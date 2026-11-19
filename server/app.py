"""HTTP-сервер «Кампуса» на стандартной библиотеке Python.

Запуск:  python -m server            (из корня проекта)
Опции:   --port 4180  --db data/campus.db  --reset  --stress  --dev
"""

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import seed as seedmod
from .ai import WeekBriefAI
from .store import (APPEAL_TOPICS, NOTIF_CATEGORIES, REQUEST_TYPES, STATUS_LABELS, STIPEND_PURPOSES,
                    STUDY_PURPOSES, Store)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
COOKIE = "campus_sid"
MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
              "сентября", "октября", "ноября", "декабря"]

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class ApiError(Exception):
    def __init__(self, status, code, message, extra=None):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra or {}


class Config:
    def __init__(self, store, dev=False, idle=8 * 3600, ai=None):
        self.store = store
        self.ai = ai or WeekBriefAI()
        self.dev = dev
        self.idle = idle
        self.faults = {"fail_reads": 0, "drop_next_write": False, "offline": False}
        self.login_failures = {}
        self.lock = threading.Lock()


def route(method, pattern):
    def deco(fn):
        fn._route = (method, re.compile("^" + pattern + "$"))
        return fn
    return deco


def ru_date(iso):
    d = dt.date.fromisoformat(iso[:10])
    return "%d %s %d" % (d.day, MONTHS_GEN[d.month - 1], d.year)


# ------------------------------------------------------------------ ICS / CSV
def _ics_escape(s):
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _ics_dt(date, hm):
    if hm == "24:00":  # конец дня личного события
        date, hm = (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat(), "00:00"
    local = dt.datetime.fromisoformat("%sT%s" % (date, hm))
    return (local - dt.timedelta(hours=3)).strftime("%Y%m%dT%H%M%SZ")


def _fold(line):
    out, b = [], line.encode("utf-8")
    while len(b) > 74:
        cut = 74
        while (b[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(b[:cut].decode())
        b = b" " + b[cut:]
    out.append(b.decode())
    return "\r\n".join(out)


def ics(events, name=None):
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kampus demo//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]
    if name:  # подписка: имя календаря и просьба обновляться раз в час (клиенты могут реже)
        lines += ["X-WR-CALNAME:" + _ics_escape(name), "X-WR-TIMEZONE:Europe/Moscow",
                  "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"]
    stamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    for e in events:
        lines += ["BEGIN:VEVENT", "UID:%s@kampus.demo" % e["uid"], "DTSTAMP:" + stamp, "SEQUENCE:%d" % e.get("sequence", 0),
                  "DTSTART:" + _ics_dt(e["date"], e["start"]), "DTEND:" + _ics_dt(e["date"], e["end"]),
                  "SUMMARY:" + _ics_escape(e["summary"]), "LOCATION:" + _ics_escape(e["location"]),
                  "DESCRIPTION:" + _ics_escape(e["description"])]
        if e.get("cancelled"):
            lines.append("STATUS:CANCELLED")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return ("\r\n".join(_fold(l) for l in lines) + "\r\n").encode("utf-8")


def personal_event(e):
    return {"uid": "event-%d" % e["id"], "date": e["date"], "start": e["start"], "end": e["end"], "summary": e["title"],
            "location": "", "description": (e["note"] + " " if e["note"] else "") + "Личное событие в «Кампусе».",
            "sequence": 0}


def place(room, building):
    r = ("ауд. %s" % room) if (room or "")[:1].isdigit() else (room or "")
    if not building:
        return r
    return "%s, %s" % (r, ("корпус %s" % building) if len(building) <= 2 else building)


def lesson_event(l):
    desc = "%s. %s." % (l["kind"], l["teacher"])
    c = l["change"]
    if c:
        if c["kind"] == "cancelled":
            desc += " Занятие отменено."
        else:
            desc += " Изменено: было %s–%s, %s." % (c["old"]["start"], c["old"]["end"], place(c["old"]["room"], c["old"]["building"]))
        if c["reason"]:
            desc += " Причина: %s." % c["reason"].rstrip(".")
    desc += " Демонстрационные данные «Кампуса»."
    return {"uid": "lesson-%d" % l["id"], "date": l["date"], "start": l["start"], "end": l["end"],
            "summary": ("Отменено: " if l["status"] == "cancelled" else "") + "%s (%s)" % (l["subject"], l["kind"].lower()),
            "location": place(l["room"], l["building"]), "description": desc,
            "cancelled": l["status"] == "cancelled", "sequence": 1 if c else 0}


def exam_event(e):
    start = dt.datetime.fromisoformat("%sT%s" % (e["date"], e["start"]))
    end = (start + dt.timedelta(hours=3)).strftime("%H:%M")
    return {"uid": "exam-%d" % e["id"], "date": e["date"], "start": e["start"], "end": end,
            "summary": "%s: %s" % (e["kind"], e["subject"]),
            "location": place(e["room"], e["building"]),
            "description": "Преподаватель: %s. Длительность в календаре условная (3 ч). Демонстрационные данные." % e["teacher"]}


def csv_cell(v):
    s = "" if v is None else str(v)
    if s[:1] in ("=", "+", "-", "@"):
        s = "'" + s
    if any(c in s for c in ";\"\n"):
        s = '"' + s.replace('"', '""') + '"'
    return s


# ------------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "Kampus/1.0"
    protocol_version = "HTTP/1.1"
    cfg = None  # type: Config

    def log_message(self, fmt, *args):
        if os.environ.get("CAMPUS_QUIET"):
            return
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- plumbing
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        if self.cfg.faults.get("offline"):  # dev: «нет сети» — соединение рвётся без ответа
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return
        url = urlparse(self.path)
        self.query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        self.session = None
        self._set_cookie = None
        # Тело читаем всегда: непрочитанные байты испортили бы следующий запрос в keep-alive соединении.
        n = int(self.headers.get("Content-Length") or 0)
        if n > 64 * 1024:
            self.close_connection = True
            return self._send_json(413, {"error": "too_large", "message": "Слишком большой запрос"})
        self._raw = self.rfile.read(n) if n else b""
        path = url.path
        m = re.match(r"^/cal/([A-Za-z0-9_-]{20,80})\.ics$", path)
        if m and method == "GET":
            return self._calendar_feed(m.group(1))
        if not path.startswith("/api/"):
            if method != "GET":
                return self._send_json(405, {"error": "method", "message": "Метод не поддерживается"})
            return self._static(path)
        try:
            for m_, rx, name in _routes(type(self)):
                if m_ == method:
                    m = rx.match(path)
                    if m:
                        return self._run(getattr(self, name), method, path, m.groups())
            raise ApiError(404, "not_found", "Такого адреса API нет")
        except ApiError as e:
            body = {"error": e.code, "message": e.message}
            body.update(e.extra)
            self._send_json(e.status, body)
        except Exception as e:  # pragma: no cover
            import traceback
            traceback.print_exc()
            self._send_json(500, {"error": "server", "message": "Внутренняя ошибка сервера"})

    def _run(self, fn, method, path, groups):
        public = getattr(fn, "_public", False)
        mutating = method in ("POST", "PUT", "PATCH", "DELETE")
        if not public:
            self._require_session()
            if mutating:
                self._check_csrf()
        if mutating and public:
            self._check_origin()
        if not mutating and self.cfg.faults["fail_reads"] > 0 and path not in ("/api/session",) and not path.startswith("/api/dev"):
            with self.cfg.lock:
                self.cfg.faults["fail_reads"] -= 1
            raise ApiError(503, "unavailable", "Сервер временно недоступен (имитация сбоя)")
        drop = mutating and self.cfg.faults["drop_next_write"] and not path.startswith("/api/dev")
        if drop:
            self.cfg.faults["drop_next_write"] = False
        status, body, headers = fn(*groups)
        if drop:
            # Запись выполнена, но ответ «теряется»: закрываем соединение без ответа.
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return
        if isinstance(body, (bytes, bytearray)):
            self._send_raw(status, body, headers)
        else:
            self._send_json(status, body, headers)

    def _send_json(self, status, body, headers=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        h = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
        h.update(headers or {})
        self._send_raw(status, data, h)

    def _send_raw(self, status, data, headers):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if self._set_cookie:
            self.send_header("Set-Cookie", self._set_cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _body(self):
        raw = self._raw
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError(400, "bad_json", "Неверный формат запроса")
        if not isinstance(data, dict):
            raise ApiError(400, "bad_json", "Неверный формат запроса")
        return data

    def _token(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c[COOKIE].value if COOKIE in c else None

    def _require_session(self):
        s, state = self.cfg.store.get_session(self._token(), self.cfg.idle)
        if not s:
            if state == "expired":
                raise ApiError(401, "session_expired", "Сессия истекла. Войдите снова — несохранённые данные формы останутся.")
            raise ApiError(401, "unauthorized", "Нужно войти в кабинет")
        self.session = s
        self.uid = s["user_id"]

    # За обратным прокси хостинга (CAMPUS_TRUST_PROXY=1): настоящий адрес клиента и схема — из заголовков прокси.
    # Без доверенного прокси заголовки игнорируются: их может подделать кто угодно.
    def _client_ip(self):
        if os.environ.get("CAMPUS_TRUST_PROXY") == "1":
            fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            if fwd:
                return fwd
        return self.client_address[0]

    def _secure(self):
        """Cookie только по HTTPS: на хостинге с TLS (или CAMPUS_SECURE_COOKIE=1)."""
        https = os.environ.get("CAMPUS_TRUST_PROXY") == "1" and (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"
        return "; Secure" if https or os.environ.get("CAMPUS_SECURE_COOKIE") == "1" else ""

    def _check_origin(self):
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            raise ApiError(403, "bad_origin", "Запрос с чужого сайта отклонён")

    def _check_csrf(self):
        self._check_origin()
        if self.headers.get("X-CSRF-Token") != self.session["csrf"]:
            raise ApiError(403, "csrf", "Защитный токен устарел. Обновите страницу.")

    def _id(self, s):
        try:
            return int(s)
        except ValueError:
            raise ApiError(404, "not_found", "Объект не найден")

    def _asset_manifest(self):
        """Список файлов оболочки для офлайн-кэша service worker (всё из web/, кроме самого sw.js)."""
        files = ["/", "/index.html"]
        for root, _dirs, names in os.walk(WEB):
            for n in sorted(names):
                full = os.path.join(root, n)
                rel = "/" + os.path.relpath(full, WEB).replace(os.sep, "/")
                if rel in ("/sw.js", "/index.html") or n.startswith(".") or n.endswith((".txt", ".md")):
                    continue
                files.append(rel)
        return self._send_json(200, {"files": files}, {"Cache-Control": "no-store"})

    def _static(self, path):
        if path == "/asset-manifest.json":
            return self._asset_manifest()
        rel = path.lstrip("/")
        if rel == "" or "." not in rel.split("/")[-1]:
            rel = "index.html"
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB) or not os.path.isfile(full):
            if rel.startswith(("src/", "vendor/", "fonts/", "assets/")):
                return self._send_raw(404, b"Not found", {"Content-Type": "text/plain"})
            full = os.path.join(WEB, "index.html")
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        # Сборки и хэшей в именах файлов нет, поэтому браузер каждый раз сверяется с сервером (no-cache + ETag):
        # неизменённый файл приходит ответом 304 без тела, изменённый — сразу свежим, без минуты устаревшего CSS/JS.
        etag = '"%s"' % hashlib.sha1(data).hexdigest()[:16]
        headers = {"Content-Type": ctype, "Cache-Control": "no-cache", "ETag": etag}
        if not full.endswith("index.html") and self.headers.get("If-None-Match") == etag:
            return self._send_raw(304, b"", {"Cache-Control": "no-cache", "ETag": etag})
        if full.endswith("index.html"):
            headers["Content-Security-Policy"] = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                                  "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
                                                  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            headers["X-Frame-Options"] = "DENY"
        self._send_raw(200, data, headers)

    def _calendar_feed(self, token):
        """Подписка: секретная ссылка вместо cookie, только чтение, только данные владельца токена."""
        uid = self.cfg.store.user_by_cal_token(token)
        if not uid:
            return self._send_raw(404, "Ссылка подписки недействительна или отключена".encode("utf-8"),
                                  {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"})
        st = self.cfg.store
        lessons = [l for p in st.published(uid) for l in st.lessons_between(uid, p["from"], p["to"])]
        u = st.profile(uid)
        evs = st.events_between(uid, "0000-01-01", "9999-12-31")
        body = ics([lesson_event(l) for l in lessons] + [exam_event(e) for e in st.exams(uid)] + [personal_event(e) for e in evs],
                   name="Кампус — %s" % u["short_name"])
        return self._send_raw(200, body, {"Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache",
                                          "Content-Disposition": 'inline; filename="kampus.ics"', "X-Robots-Tag": "noindex"})

    @property
    def st(self):
        return self.cfg.store

    # ======================================================== auth & profile
    def _session_payload(self, uid, csrf):
        return {"user": self.st.profile(uid), "csrf": csrf, "unread": self.st.unread_count(uid),
                "meta": {"request_types": REQUEST_TYPES, "statuses": STATUS_LABELS,
                         "study_purposes": STUDY_PURPOSES, "stipend_purposes": STIPEND_PURPOSES,
                         "appeal_topics": APPEAL_TOPICS, "categories": NOTIF_CATEGORIES,
                         "published": self.st.published(uid), "dev": self.cfg.dev,
                         "ai": self.cfg.ai.available()}}

    @route("POST", "/api/auth/login")
    def login(self):
        b = self._body()
        login = str(b.get("login", "")).strip().lower()[:64]
        password = str(b.get("password", ""))[:256]
        key = (login, self._client_ip())
        now = time.time()
        with self.cfg.lock:
            fails = [t for t in self.cfg.login_failures.get(key, []) if now - t < 300]
            self.cfg.login_failures[key] = fails
        if len(fails) >= 8:
            raise ApiError(429, "rate_limited", "Слишком много попыток. Подождите 5 минут.")
        if not login or not password:
            raise ApiError(400, "invalid", "Введите логин и пароль",
                           {"fields": {k: "Обязательное поле" for k in ("login", "password") if not b.get(k)}})
        u = self.st.login(login, password)
        if not u:
            with self.cfg.lock:
                self.cfg.login_failures[key].append(now)
            raise ApiError(401, "bad_credentials", "Неверный логин или пароль")
        token, csrf = self.st.create_session(u["id"])
        self._set_cookie = "%s=%s; HttpOnly; SameSite=Strict; Path=/%s" % (COOKIE, token, self._secure())
        self.st.start_clock(u["id"], reset_speed=True)  # «Время идёт»: каждый вход начинается с выбранного демо-момента, с обычной скоростью
        self.cfg.ai.prewarm(u["id"], self.st.summary_week)  # абзац недели готовится, пока открывается кабинет
        return 200, self._session_payload(u["id"], csrf), None
    login._public = True

    @route("POST", "/api/auth/logout")
    def logout(self):
        self.st.delete_session(self._token())
        self._set_cookie = "%s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0%s" % (COOKIE, self._secure())
        return 200, {"ok": True}, None

    @route("GET", "/api/session")
    def session_info(self):
        return 200, self._session_payload(self.uid, self.session["csrf"]), None

    @route("PATCH", "/api/preferences")
    def preferences(self):
        b = self._body()
        try:
            self.st.set_preferences(self.uid, theme=b.get("theme"), demo_now=b.get("demo_now"), time_flow=b.get("time_flow"),
                                    clock_speed=b.get("clock_speed"))
        except ValueError as e:
            raise ApiError(400, "invalid", "Недопустимое значение настройки", {"field": str(e)})
        return 200, {"user": self.st.profile(self.uid)}, None

    @route("POST", "/api/tour")
    def tour(self):
        b = self._body()
        if b.get("reset") is True:  # «Пройти снова»: главное знакомство и разделы — заново
            self.st.reset_tours(self.uid)
            return 200, {"tour_done": False, "tours_seen": []}, None
        if "page" in b:  # знакомство с разделом показано: {"page": "schedule", "seen": true}
            if not isinstance(b.get("page"), str) or not isinstance(b.get("seen", True), bool):
                raise ApiError(400, "invalid", "Нужны поля page и seen")
            try:
                seen = self.st.set_page_tour(self.uid, b["page"], b.get("seen", True))
            except ValueError:
                raise ApiError(400, "invalid", "Неизвестный раздел")
            return 200, {"tours_seen": seen}, None
        if not isinstance(b.get("done"), bool):
            raise ApiError(400, "invalid", "Нужно поле done: true или false")
        self.st.set_tour(self.uid, b["done"])
        return 200, {"tour_done": b["done"]}, None

    # ============================================================== schedule
    @route("GET", "/api/today")
    def today(self):
        return 200, self.st.today(self.uid), None

    def _range(self):
        f, t = self.query.get("from"), self.query.get("to")
        try:
            df, dt_ = dt.date.fromisoformat(f), dt.date.fromisoformat(t)
        except (TypeError, ValueError):
            raise ApiError(400, "invalid", "Укажите период: from и to в формате ГГГГ-ММ-ДД")
        if df > dt_ or (dt_ - df).days > 62:
            raise ApiError(400, "invalid", "Период должен быть не длиннее двух месяцев")
        return f, t

    @route("GET", "/api/schedule")
    def schedule(self):
        f, t = self._range()
        return 200, self.st.schedule(self.uid, f, t), None

    @route("GET", r"/api/lessons/(\d+)")
    def lesson(self, lid):
        l = self.st.lesson(self.uid, self._id(lid))
        if not l:
            raise ApiError(404, "not_found", "Занятие не найдено или недоступно этому аккаунту")
        l["tasks"] = [t for t in self.st.tasks(self.uid, subject_id=l["subject_id"])]
        l["notifications"] = [n for n in self.st.notifications(self.uid) if n["link_type"] == "lesson" and n["link_id"] == l["id"]]
        return 200, l, None

    @route("POST", r"/api/lessons/(\d+)/ack")
    def ack(self, lid):
        l, outcome = self.st.ack_change(self.uid, self._id(lid))
        if outcome == "not_found":
            raise ApiError(404, "not_found", "Занятие не найдено")
        if outcome == "no_change":
            raise ApiError(409, "no_change", "У этого занятия нет изменений")
        return 200, {"lesson": l, "outcome": outcome}, None

    @route("GET", r"/api/lessons/(\d+)\.ics")
    def lesson_ics(self, lid):
        l = self.st.lesson(self.uid, self._id(lid))
        if not l:
            raise ApiError(404, "not_found", "Занятие не найдено")
        return 200, ics([lesson_event(l)]), self._file_headers("text/calendar", "lesson-%s-%d.ics" % (l["date"], l["id"]))

    @route("GET", r"/api/schedule\.ics")
    def schedule_ics(self):
        f, t = self._range()
        ls = self.st.lessons_between(self.uid, f, t)
        evs = self.st.events_between(self.uid, f, t)  # выбранный диапазон: пары и личные события
        return 200, ics([lesson_event(l) for l in ls] + [personal_event(e) for e in evs]), \
            self._file_headers("text/calendar", "schedule-%s-%s.ics" % (f, t))

    # ---------------------------------------------------------- личные события
    def _event_or_404(self, eid):
        e = self.st.event(self.uid, self._id(eid))
        if not e:
            raise ApiError(404, "not_found", "Событие не найдено или недоступно этому аккаунту")
        return e

    @route("POST", "/api/events")
    def create_event(self):
        try:
            e = self.st.create_event(self.uid, self._body())
        except ValueError as err:
            raise ApiError(400, "invalid", "Проверьте поля события", {"fields": err.args[0]})
        return 201, {"event": e}, None

    @route("PATCH", r"/api/events/(\d+)")
    def update_event(self, eid):
        self._event_or_404(eid)
        try:
            e = self.st.update_event(self.uid, int(eid), self._body())
        except ValueError as err:
            raise ApiError(400, "invalid", "Проверьте поля события", {"fields": err.args[0]})
        return 200, {"event": e}, None

    @route("DELETE", r"/api/events/(\d+)")
    def delete_event(self, eid):
        e = self._event_or_404(eid)
        self.st.delete_event(self.uid, e["id"])
        return 200, {"deleted": e}, None

    def _file_headers(self, ctype, name, utf_name=None):
        disp = 'attachment; filename="%s"' % name
        if utf_name:
            disp += "; filename*=UTF-8''%s" % quote(utf_name)
        return {"Content-Type": ctype + "; charset=utf-8", "Content-Disposition": disp, "Cache-Control": "no-store"}

    # ================================================================ grades
    @route("GET", "/api/grades")
    def grades(self):
        return 200, {"subjects": self.st.subjects(self.uid), "exams": self.st.exams(self.uid),
                     "past_results": self.st.past_results(self.uid), "now": self.st.now(self.uid)}, None

    @route("GET", r"/api/subjects/(\d+)")
    def subject(self, sid):
        s = self.st.subject(self.uid, self._id(sid))
        if not s:
            raise ApiError(404, "not_found", "Дисциплина не найдена или недоступна этому аккаунту")
        return 200, s, None

    @route("GET", r"/api/grades\.csv")
    def grades_csv(self):
        rows = [["Дисциплина", "Форма контроля", "Работа", "Тип", "Дата", "Баллы", "Максимум"]]
        for s in self.st.subjects(self.uid):
            for i in s["items"]:
                rows.append([s["title"], s["control"], i["title"], i["kind"], i["date"], _num(i["score"]), _num(i["max"])])
            rows.append([s["title"], s["control"], "Текущий балл (сумма, не итоговая оценка)", "", "", _num(s["score"]), _num(s["score_max_so_far"])])
        data = "\ufeff" + "\r\n".join(";".join(csv_cell(c) for c in r) for r in rows) + "\r\n"
        return 200, data.encode("utf-8"), self._file_headers("text/csv", "grades.csv")

    @route("GET", r"/api/exams/(\d+)\.ics")
    def exam_ics(self, eid):
        e = self.st.exam(self.uid, self._id(eid))
        if not e:
            raise ApiError(404, "not_found", "Экзамен не найден")
        return 200, ics([exam_event(e)]), self._file_headers("text/calendar", "exam-%d.ics" % e["id"])

    @route("GET", r"/api/exams\.ics")
    def exams_ics(self):
        return 200, ics([exam_event(e) for e in self.st.exams(self.uid)]), self._file_headers("text/calendar", "session.ics")

    # ================================================================= tasks
    @route("GET", "/api/tasks")
    def tasks(self):
        return 200, {"tasks": self.st.tasks(self.uid)}, None

    @route("POST", r"/api/tasks/(\d+)/done")
    def task_done(self, tid):
        b = self._body()
        t = self.st.set_task_done(self.uid, self._id(tid), bool(b.get("done", True)))
        if not t:
            raise ApiError(404, "not_found", "Дело не найдено")
        return 200, {"task": t}, None

    # ============================================================== requests
    @route("GET", "/api/requests")
    def requests(self):
        return 200, {"requests": self.st.requests(self.uid), "drafts": self.st.drafts(self.uid)}, None

    @route("POST", "/api/requests")
    def create_request(self):
        key = (self.headers.get("Idempotency-Key") or "").strip()
        if not re.match(r"^[A-Za-z0-9_-]{8,80}$", key):
            raise ApiError(400, "idempotency_key", "Нет ключа повторной отправки")
        b = self._body()
        r, outcome = self.st.create_request(self.uid, b.get("type"), b.get("payload"), key)
        if outcome == "invalid":
            raise ApiError(422, "invalid", "Проверьте поля формы", {"fields": r["errors"]})
        if outcome == "conflict":
            raise ApiError(409, "idempotency_conflict",
                           "Предыдущая отправка уже дошла до сервера, но данные формы с тех пор изменились.",
                           {"request": r})
        return (201 if outcome == "created" else 200), {"request": r, "outcome": outcome}, None

    @route("GET", r"/api/requests/(\d+)")
    def request_detail(self, rid):
        r = self.st.request(self.uid, self._id(rid))
        if not r:
            raise ApiError(404, "not_found", "Заявка не найдена или недоступна этому аккаунту")
        return 200, r, None

    @route("POST", r"/api/requests/(\d+)/cancel")
    def cancel(self, rid):
        r, outcome = self.st.cancel_request(self.uid, self._id(rid))
        if outcome == "not_found":
            raise ApiError(404, "not_found", "Заявка не найдена")
        if outcome == "not_allowed":
            raise ApiError(409, "not_allowed", "Заявку в статусе «%s» отменить нельзя" % r["status_label"], {"request": r})
        return 200, {"request": r, "outcome": outcome}, None

    @route("POST", r"/api/requests/(\d+)/received")
    def received(self, rid):
        b = self._body()
        r, outcome = self.st.set_received(self.uid, self._id(rid), bool(b.get("received", True)))
        if outcome == "not_found":
            raise ApiError(404, "not_found", "Заявка не найдена")
        if outcome == "not_allowed":
            raise ApiError(409, "not_allowed", "Для этой заявки нет документа", {"request": r})
        return 200, {"request": r, "outcome": outcome}, None

    @route("GET", r"/api/requests/(\d+)/document")
    def document(self, rid):
        r = self.st.request(self.uid, self._id(rid))
        if not r:
            raise ApiError(404, "not_found", "Документ не найден")
        if not r["has_document"]:
            raise ApiError(409, "not_ready", "Документ ещё не готов")
        u = self.st.profile(self.uid)
        p = r["payload"]
        lines = [
            "ДЕМОНСТРАЦИОННЫЙ ОБРАЗЕЦ — НЕ ЯВЛЯЕТСЯ ОФИЦИАЛЬНЫМ ДОКУМЕНТОМ",
            "Сформирован неофициальным учебным проектом «Кампус». Все сведения вымышлены.",
            "",
            r["type_label"].upper() + (" (английская версия)" if p.get("language") == "en" else ""),
            "",
            "Выдана: %s" % u["full_name"],
            "%s, %s, %d курс, группа %s." % (u["faculty"], u["program"], u["course"], u["group_name"]),
            "Номер зачётной книжки: %s." % u["record_no"],
        ]
        if r["type"] == "study_cert":
            lines += ["Обучается по очной форме обучения.", "Справка выдана для предоставления: %s." % p.get("purpose")]
        else:
            lines += ["Период: %s — %s." % (p.get("period_from"), p.get("period_to")),
                      "Суммы выплат в демонстрационном образце не указываются.",
                      "Справка выдана для предоставления: %s." % p.get("purpose")]
        lines += ["", "Номер заявки: %d. Дата заявки: %s." % (r["id"], ru_date(r["created_at"])),
                  "", "Подпись и печать отсутствуют: это демонстрационный образец."]
        name = "kampus-%s-%d-demo.txt" % (r["type"].replace("_", "-"), r["id"])
        utf = "%s №%d (демо).txt" % (r["type_label"], r["id"])
        return 200, ("\r\n".join(lines) + "\r\n").encode("utf-8"), self._file_headers("text/plain", name, utf)

    @route("PUT", r"/api/drafts/(\w+)")
    def put_draft(self, rtype):
        b = self._body()
        try:
            self.st.save_draft(self.uid, rtype, b.get("payload"))
        except ValueError:
            raise ApiError(400, "invalid", "Черновик не сохранён: неверные данные")
        return 200, {"ok": True}, None

    @route("DELETE", r"/api/drafts/(\w+)")
    def del_draft(self, rtype):
        self.st.delete_draft(self.uid, rtype)
        return 200, {"ok": True}, None

    # ========================================================= notifications
    @route("GET", "/api/notifications")
    def notifications(self):
        return 200, {"notifications": self.st.notifications(self.uid)}, None

    @route("POST", r"/api/notifications/(\d+)/read")
    def read(self, nid):
        b = self._body()
        n = self.st.set_read(self.uid, self._id(nid), bool(b.get("read", True)))
        if not n:
            raise ApiError(404, "not_found", "Уведомление не найдено")
        return 200, {"notification": n, "unread": self.st.unread_count(self.uid)}, None

    @route("POST", "/api/notifications/read-all")
    def read_all(self):
        b = self._body()
        cat = b.get("category")
        if cat is not None and cat not in NOTIF_CATEGORIES:
            raise ApiError(400, "invalid", "Неизвестная категория")
        ids = self.st.read_all(self.uid, cat)
        return 200, {"ids": ids, "unread": self.st.unread_count(self.uid)}, None

    # ============================================================== calendar
    @route("GET", "/api/calendar")
    def calendar_info(self):
        return 200, self.st.cal_token_info(self.uid), None

    @route("POST", "/api/calendar/token")
    def calendar_token(self):
        return 200, self.st.create_cal_token(self.uid), None

    @route("DELETE", "/api/calendar/token")
    def calendar_revoke(self):
        self.st.revoke_cal_token(self.uid)
        return 200, {"token": None}, None

    # =============================================================== summary
    @route("GET", "/api/summary")
    def summary(self):
        return 200, self.st.summary_since(self.uid), None

    @route("GET", "/api/summary/week")
    def summary_week(self):
        return 200, self.st.summary_week(self.uid), None

    @route("POST", "/api/summary/week/ai")
    def summary_week_ai(self):
        # POST: вызов платный и меняет состояние кэша; CSRF и Origin проверяются как у любой записи.
        self._body()
        res = self.cfg.ai.brief(self.uid, self.st.summary_week(self.uid))
        return 200, res, None

    @route("POST", "/api/ask")
    def ask(self):
        # «Спросить Кампус» (⌘K): вопрос обычным языком, ответ модели по фактам недели со сверкой чисел и источниками.
        b = self._body()
        q = b.get("question")
        if not isinstance(q, str) or not q.strip():
            raise ApiError(400, "invalid", "Нужен вопрос")
        if len(q) > 120:
            raise ApiError(400, "invalid", "Вопрос длиннее 120 символов")
        w = self.st.summary_week(self.uid)
        res = self.cfg.ai.answer(self.uid, q, w, self.st.schedule(self.uid, w["from"], w["to"]))
        return 200, res, None

    @route("POST", "/api/summary/seen")
    def summary_seen(self):
        b = self._body()
        try:
            res = self.st.set_last_visit(self.uid, b.get("at"))
        except ValueError:
            raise ApiError(400, "invalid", "Неверная отметка времени: нужна дата не позже демо-«сейчас»")
        return 200, res, None

    # ================================================================ search
    @route("GET", "/api/search")
    def search(self):
        q = (self.query.get("q") or "")[:100]
        return 200, self.st.search(self.uid, q), None

    # ================================================================== dev
    @route("POST", "/api/dev/fault")
    def dev_fault(self):
        if not self.cfg.dev:
            raise ApiError(404, "not_found", "Такого адреса API нет")
        b = self._body()
        with self.cfg.lock:
            if "fail_reads" in b:
                self.cfg.faults["fail_reads"] = int(b["fail_reads"])
            if "drop_next_write" in b:
                self.cfg.faults["drop_next_write"] = bool(b["drop_next_write"])
        if b.get("expire_session"):
            self.st.expire_session(self._token())
        return 200, {"faults": self.cfg.faults}, None


_ROUTE_CACHE = {}


def _routes(cls):
    if cls not in _ROUTE_CACHE:
        table = []
        for name, fn in vars(Handler).items():
            r = getattr(fn, "_route", None)
            if r:
                table.append((r[0], r[1], name))
        _ROUTE_CACHE[cls] = table
    return _ROUTE_CACHE[cls]


def _num(v):
    return int(v) if float(v).is_integer() else v


def make_server(store, port=4180, host="127.0.0.1", dev=False, idle=8 * 3600, ai=None):
    cfg = Config(store, dev=dev, idle=idle, ai=ai)
    handler = type("BoundHandler", (Handler,), {"cfg": cfg})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    srv.cfg = cfg
    return srv


def open_store(db_path, reset=False, stress=False):
    if reset and os.path.exists(db_path):
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(db_path + suffix):
                os.remove(db_path + suffix)
    store = Store(db_path)
    if store.is_empty():
        store.seed([seedmod.stress_account()] if stress else seedmod.ACCOUNTS)
    return store


def main(argv=None):
    ap = argparse.ArgumentParser(description="Кампус — демо-кабинет студента")
    # Хостинг обычно задаёт порт переменной PORT и требует слушать все адреса (CAMPUS_HOST=0.0.0.0).
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or os.environ.get("CAMPUS_PORT") or 4180))
    ap.add_argument("--host", default=os.environ.get("CAMPUS_HOST", "127.0.0.1"))
    ap.add_argument("--db", default=os.environ.get("CAMPUS_DB"), help="путь к SQLite (по умолчанию data/campus.db)")
    ap.add_argument("--reset", action="store_true", help="пересоздать ЭТУ базу из демо-набора")
    ap.add_argument("--stress", action="store_true", help="стрессовый набор (отдельная база data/campus-stress.db)")
    ap.add_argument("--dev", action="store_true", help="включить /api/dev/fault для проверки сбоев")
    a = ap.parse_args(argv)
    db = a.db or os.path.join(ROOT, "data", "campus-stress.db" if a.stress else "campus.db")
    store = open_store(db, reset=a.reset, stress=a.stress)
    srv = make_server(store, port=a.port, host=a.host, dev=a.dev or bool(os.environ.get("CAMPUS_DEV")))
    print("Кампус: http://%s:%d  (база: %s%s)" % (a.host, a.port, os.path.relpath(db, ROOT), ", dev" if srv.cfg.dev else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
