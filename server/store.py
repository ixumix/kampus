"""Хранилище «Кампуса»: схема SQLite, демо-набор и все запросы к данным.

Каждый запрос к пользовательским данным фильтруется по user_id. Чужой или
несуществующий объект неразличимы: оба дают None (на HTTP-уровне — 404).
"""

import datetime as dt
import hashlib
import hmac
import json
import re
import os
import secrets
import sqlite3
import threading

from . import seed as seedmod

MSK = dt.timezone(dt.timedelta(hours=3))
DEFAULT_NOW = "2026-11-16T10:15"
# Прошлый визит по умолчанию (демо): суббота, 14 ноября, 12:00. «Понятно» в сводке сдвигает его на демо-«сейчас».
DEFAULT_LAST_VISIT = "2026-11-14T12:00"
# Действия деканата, которые попадают в сводку; действия самого студента (отмена, получение) — нет.
OFFICE_STATUSES = ("in_progress", "ready", "answered", "rejected")
TOUR_PAGES = ("schedule", "grades", "documents", "notifications", "profile")  # разделы со своим знакомством
DEMO_NOW_PRESETS = {
    "2026-11-16T08:20": "Пн, 16 ноября, 08:20 — до начала пар",
    "2026-11-16T10:15": "Пн, 16 ноября, 10:15 — во время первой пары",
    "2026-11-16T11:55": "Пн, 16 ноября, 11:55 — перерыв",
    "2026-11-16T18:30": "Пн, 16 ноября, 18:30 — пары закончились",
    "2026-11-21T12:00": "Сб, 21 ноября, 12:00 — свободный день",
}

REQUEST_TYPES = {
    "study_cert": "Справка об обучении",
    "stipend_cert": "Справка о стипендии",
    "dean_appeal": "Обращение в деканат",
}
STATUS_LABELS = {
    "accepted": "Принята",
    "in_progress": "В работе",
    "ready": "Готова",
    "received": "Получена",
    "answered": "Ответ дан",
    "rejected": "Отклонена",
    "cancelled": "Отменена",
}
CANCELLABLE = {"accepted", "in_progress"}
NOTIF_CATEGORIES = {
    "schedule": "Расписание",
    "requests": "Заявки",
    "deadlines": "Сроки",
    "announcements": "Объявления",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  full_name TEXT, short_name TEXT, faculty TEXT, program TEXT, course INTEGER,
  group_name TEXT, record_no TEXT, email TEXT, phone TEXT,
  theme TEXT NOT NULL DEFAULT 'system', demo_now TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL, created_at REAL NOT NULL, last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, code TEXT, title TEXT NOT NULL,
  control TEXT, teacher TEXT, attention TEXT, max_points INTEGER
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
  date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, kind TEXT, teacher TEXT,
  room TEXT, building TEXT, status TEXT NOT NULL DEFAULT 'normal',
  old_start TEXT, old_end TEXT, old_room TEXT, old_building TEXT,
  change_reason TEXT, change_announced TEXT, change_ack TEXT
);
CREATE INDEX IF NOT EXISTS lessons_user_date ON lessons(user_id, date);
CREATE TABLE IF NOT EXISTS published (user_id INTEGER NOT NULL, date_from TEXT, date_to TEXT);
CREATE TABLE IF NOT EXISTS grade_items (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
  title TEXT, kind TEXT, date TEXT, score REAL, max REAL
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
  kind TEXT, date TEXT, start TEXT, room TEXT, building TEXT, admission TEXT, admission_note TEXT
);
CREATE TABLE IF NOT EXISTS past_results (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, semester TEXT, title TEXT,
  control TEXT, result TEXT, date TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, due_date TEXT,
  due_time TEXT, subject_id INTEGER, note TEXT, done_at TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  payload TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL, at TEXT, status TEXT, text TEXT,
  actor TEXT NOT NULL DEFAULT 'office', scripted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS idempotency (
  user_id INTEGER NOT NULL, key TEXT NOT NULL, body_hash TEXT NOT NULL,
  request_id INTEGER NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(user_id, key)
);
CREATE TABLE IF NOT EXISTS drafts (
  user_id INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, type)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user_date ON events(user_id, date);
CREATE TABLE IF NOT EXISTS calendar_tokens (
  user_id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT, created_at TEXT NOT NULL, read_at TEXT, link_type TEXT, link_id INTEGER,
  scripted INTEGER NOT NULL DEFAULT 0
);
"""


# ------------------------------------------------------------------ passwords
def hash_password(password, iterations=None):
    iterations = iterations or int(os.environ.get("CAMPUS_PBKDF2_ITERS", "240000"))
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return "pbkdf2_sha256$%d$%s$%s" % (iterations, salt.hex(), digest.hex())


def verify_password(password, stored):
    try:
        algo, iters, salt, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    got = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
    return hmac.compare_digest(got.hex(), digest)


# --------------------------------------------------------------------- helpers
def _slot_times(slot):
    return seedmod.SLOTS[slot]


def iso_now_msk():
    return dt.datetime.now(MSK).strftime("%Y-%m-%dT%H:%M")


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        if path != ":memory:":
            self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        # Демо-часы: в тестах стоят на месте (CAMPUS_FROZEN_TIME=1), иначе идут от момента входа или выбора времени.
        self.frozen = os.environ.get("CAMPUS_FROZEN_TIME") == "1"
        self.clock = lambda: dt.datetime.now(dt.timezone.utc)
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(users)").fetchall()}
        if "last_visit" not in cols:  # миграция баз, созданных до появления сводки
            self.db.execute("ALTER TABLE users ADD COLUMN last_visit TEXT")
        if "tour_done_at" not in cols:  # знакомство с интерфейсом пройдено или пропущено
            self.db.execute("ALTER TABLE users ADD COLUMN tour_done_at TEXT")
        if "tours_seen" not in cols:  # знакомства с разделами, уже показанные этому аккаунту: «schedule,grades,…»
            self.db.execute("ALTER TABLE users ADD COLUMN tours_seen TEXT NOT NULL DEFAULT ''")
        if "demo_anchor" not in cols:  # «Время идёт»: когда (по UTC) демо-часы стояли на значении demo_now
            self.db.execute("ALTER TABLE users ADD COLUMN demo_anchor TEXT")
        if "time_flow" not in cols:
            self.db.execute("ALTER TABLE users ADD COLUMN time_flow INTEGER NOT NULL DEFAULT 1")
        if "clock_speed" not in cols:  # «Прокрутить день»: во сколько раз демо-часы идут быстрее настоящих
            self.db.execute("ALTER TABLE users ADD COLUMN clock_speed REAL NOT NULL DEFAULT 1")
        ecols = {r[1] for r in self.db.execute("PRAGMA table_info(request_events)").fetchall()}
        if "actor" not in ecols:  # кто изменил статус: деканат (office) или сам студент (student)
            self.db.execute("ALTER TABLE request_events ADD COLUMN actor TEXT NOT NULL DEFAULT 'office'")
            self.db.execute("UPDATE request_events SET actor='student' WHERE status IN ('accepted','cancelled','received') OR text LIKE 'Отметка о получении снята%'")
        ncols = {r[1] for r in self.db.execute("PRAGMA table_info(notifications)").fetchall()}
        if "scripted" not in ncols:  # «живой» сценарий демо: события, которые наступают по демо-часам
            self.db.execute("ALTER TABLE request_events ADD COLUMN scripted INTEGER NOT NULL DEFAULT 0")
            self.db.execute("ALTER TABLE notifications ADD COLUMN scripted INTEGER NOT NULL DEFAULT 0")
            for acc in seedmod.ACCOUNTS:
                u = self.db.execute("SELECT id FROM users WHERE login=?", (acc["login"],)).fetchone()
                if u:
                    refs = {}
                    for r in acc.get("requests", []):
                        row = self.db.execute("SELECT id FROM requests WHERE user_id=? AND demo=1 AND type=? AND created_at=?",
                                              (u[0], r["type"], r["created"])).fetchone()
                        if row:
                            refs[r["key"]] = row[0]
                    self._seed_live(self.db, u[0], acc, refs)
        self.db.commit()

    # ---- generic
    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.lastrowid

    def is_empty(self):
        return self.one("SELECT COUNT(*) AS n FROM users")["n"] == 0

    # ------------------------------------------------------------------ seed
    def seed(self, accounts):
        with self.lock:
            for acc in accounts:
                self._seed_account(acc)
            self.db.commit()

    def _seed_account(self, a):
        c = self.db
        uid = c.execute(
            "INSERT INTO users(login,password_hash,full_name,short_name,faculty,program,course,group_name,record_no,email,phone)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (a["login"], hash_password(a["password"]), a["full_name"], a["short_name"], a["faculty"],
             a["program"], a["course"], a["group_name"], a["record_no"], a["email"], a["phone"])).lastrowid
        sid = {}
        for code, title, control, teacher, attention in a["subjects"]:
            sid[code] = c.execute(
                "INSERT INTO subjects(user_id,code,title,control,teacher,attention,max_points) VALUES(?,?,?,?,?,?,?)",
                (uid, code, title, control, teacher, attention, a["max_points"].get(code, 60))).lastrowid
        teachers = {s[0]: s[3] for s in a["subjects"]}
        c.execute("INSERT INTO published VALUES(?,?,?)", (uid,) + seedmod.PUBLISHED)
        lesson_ref = {}
        for monday in ("2026-11-09", "2026-11-16"):
            dates = seedmod._week_dates(monday)
            for wd, items in a["week"].items():
                for slot, code, kind, room, building in items:
                    date = dates[wd]
                    start, end = _slot_times(slot)
                    ch = a["changes"].get((date, code, slot)) if monday == "2026-11-16" else None
                    row = dict(status="normal", start=start, end=end, room=room, building=building,
                               old_start=None, old_end=None, old_room=None, old_building=None,
                               reason=None, announced=None)
                    if ch:
                        row["status"] = ch["status"]
                        row["reason"] = ch["reason"]
                        row["announced"] = ch["announced"]
                        if ch["status"] == "changed":
                            if "room" in ch:
                                row["old_room"], row["old_building"] = room, building
                                row["room"], row["building"] = ch["room"], ch["building"]
                            if "slot" in ch:
                                row["old_start"], row["old_end"] = start, end
                                row["start"], row["end"] = _slot_times(ch["slot"])
                    lid = c.execute(
                        "INSERT INTO lessons(user_id,subject_id,date,start,end,kind,teacher,room,building,status,"
                        "old_start,old_end,old_room,old_building,change_reason,change_announced)"
                        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (uid, sid[code], date, row["start"], row["end"], kind, teachers[code], row["room"],
                         row["building"], row["status"], row["old_start"], row["old_end"], row["old_room"],
                         row["old_building"], row["reason"], row["announced"])).lastrowid
                    lesson_ref[(date, code, slot)] = lid
        for code, items in a["grade_items"].items():
            for title, kind, date, score, mx in items:
                c.execute("INSERT INTO grade_items(user_id,subject_id,title,kind,date,score,max) VALUES(?,?,?,?,?,?,?)",
                          (uid, sid[code], title, kind, date, score, mx))
        for code, kind, date, start, room, building, adm, note in a["exams"]:
            c.execute("INSERT INTO exams(user_id,subject_id,kind,date,start,room,building,admission,admission_note)"
                      " VALUES(?,?,?,?,?,?,?,?,?)", (uid, sid[code], kind, date, start, room, building, adm, note))
        for sem, title, control, result, date in a["past_results"]:
            c.execute("INSERT INTO past_results(user_id,semester,title,control,result,date) VALUES(?,?,?,?,?,?)",
                      (uid, sem, title, control, result, date))
        task_ids = []
        for title, due, due_time, code, note, done in a["tasks"]:
            task_ids.append(c.execute(
                "INSERT INTO tasks(user_id,title,due_date,due_time,subject_id,note,done_at) VALUES(?,?,?,?,?,?,?)",
                (uid, title, due, due_time, sid.get(code), note, done)).lastrowid)
        req_ids = {}
        for r in a["requests"]:
            last = r["events"][-1][0]
            rid = c.execute(
                "INSERT INTO requests(user_id,type,status,payload,answer,created_at,updated_at,demo) VALUES(?,?,?,?,?,?,?,1)",
                (uid, r["type"], r["status"], json.dumps(r["payload"], ensure_ascii=False), r.get("answer"),
                 r["created"], last)).lastrowid
            req_ids[r["key"]] = rid
            for at, st, text in r["events"]:
                c.execute("INSERT INTO request_events(request_id,at,status,text,actor) VALUES(?,?,?,?,?)",
                          (rid, at, st, text, "student" if st in ("accepted", "cancelled", "received") else "office"))
        for cat, title, body, created, read_at, link_type, ref in a["notifications"]:
            link_id = None
            if link_type == "change":
                link_type, link_id = "lesson", lesson_ref.get(ref)
            elif link_type == "task":
                link_id = task_ids[ref]
            elif link_type == "request":
                link_id = req_ids.get(ref)
            elif link_type == "subject":
                link_id = sid.get(ref)
            c.execute("INSERT INTO notifications(user_id,category,title,body,created_at,read_at,link_type,link_id)"
                      " VALUES(?,?,?,?,?,?,?,?)", (uid, cat, title, body, created, read_at, link_type, link_id))
        self._seed_live(c, uid, a, req_ids)

    def _seed_live(self, c, uid, a, req_ids):
        """«Живой» сценарий: статусы заявок и уведомления, которые наступают по демо-часам (scripted=1).
        Пока демо-«сейчас» до них не дошло, их не видно нигде: ни в списках, ни в счётчиках, ни в поиске."""
        for ev in a.get("live", []):
            rid = req_ids.get(ev.get("request"))
            if ev.get("request") and not rid:
                continue
            if rid:
                c.execute("INSERT INTO request_events(request_id,at,status,text,actor,scripted) VALUES(?,?,?,?,'office',1)",
                          (rid, ev["at"], ev["status"], ev["text"]))
            if ev.get("notify"):
                cat, title, body = ev["notify"]
                c.execute("INSERT INTO notifications(user_id,category,title,body,created_at,read_at,link_type,link_id,scripted)"
                          " VALUES(?,?,?,?,?,NULL,?,?,1)", (uid, cat, title, body, ev["at"], "request" if rid else None, rid))

    # -------------------------------------------------------------- sessions
    def login(self, login, password):
        u = self.one("SELECT * FROM users WHERE login=?", (login.strip().lower(),))
        if not u or not verify_password(password, u["password_hash"]):
            # выравниваем время ответа для несуществующего логина
            if not u:
                verify_password(password, "pbkdf2_sha256$1000$00$00")
            return None
        return u

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        now = dt.datetime.now().timestamp()
        self.x("INSERT INTO sessions VALUES(?,?,?,?,?)", (_h(token), user_id, csrf, now, now))
        return token, csrf

    def get_session(self, token, idle_limit):
        if not token:
            return None, "none"
        s = self.one("SELECT * FROM sessions WHERE token_hash=?", (_h(token),))
        if not s:
            return None, "unknown"
        now = dt.datetime.now().timestamp()
        if now - s["last_seen"] > idle_limit:
            self.x("DELETE FROM sessions WHERE token_hash=?", (_h(token),))
            return None, "expired"
        self.x("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now, _h(token)))
        return s, "ok"

    def expire_session(self, token):
        self.x("UPDATE sessions SET last_seen=0 WHERE token_hash=?", (_h(token),))

    def delete_session(self, token):
        self.x("DELETE FROM sessions WHERE token_hash=?", (_h(token),))

    # ------------------------------------------------------------------ user
    def user(self, uid):
        return self.one("SELECT * FROM users WHERE id=?", (uid,))

    def profile(self, uid):
        u = self.user(uid)
        keys = ["login", "full_name", "short_name", "faculty", "program", "course", "group_name",
                "record_no", "email", "phone", "theme"]
        p = {k: u[k] for k in keys}
        p["demo_now"] = self.now(uid)
        p["demo_clock"] = self.now(uid, seconds=True)
        p["time_flow"] = bool(u["time_flow"])
        p["clock_running"] = self._running(u)
        p["clock_speed"] = u["clock_speed"] or 1
        p["demo_range"] = self.demo_range(uid)
        p["tour_done"] = bool(u["tour_done_at"])
        p["tours_seen"] = [x for x in (u["tours_seen"] or "").split(",") if x]
        p["demo_now_presets"] = [{"value": k, "label": v} for k, v in DEMO_NOW_PRESETS.items()]
        p["next_live_at"] = self.next_live_at(uid)
        return p

    def next_live_at(self, uid):
        """Ближайшее событие «живого» сценария после демо-«сейчас»: клиент обновит данные ровно в эту минуту."""
        now = self.now(uid)
        r = self.one("SELECT MIN(at) AS t FROM ("
                     " SELECT e.at AS at FROM request_events e JOIN requests r ON r.id=e.request_id WHERE r.user_id=? AND e.scripted=1 AND e.at > ?"
                     " UNION ALL SELECT created_at FROM notifications WHERE user_id=? AND scripted=1 AND created_at > ?)", (uid, now, uid, now))
        return r and r["t"]

    def _drop_future_script(self, uid, rid):
        """Студент сам изменил заявку — её ещё не наступившие события сценария больше не случатся."""
        now = self.now(uid)
        self.db.execute("DELETE FROM request_events WHERE request_id=? AND scripted=1 AND at > ?", (rid, now))
        self.db.execute("DELETE FROM notifications WHERE user_id=? AND scripted=1 AND created_at > ? AND link_type='request' AND link_id=?", (uid, now, rid))

    # ------------------------------------------------------------ демо-время
    # «Сейчас» кабинета — не часы компьютера, а демо-момент. С «Время идёт» он движется вперёд от момента входа
    # (или выбора времени) с обычной скоростью, но не дальше конца того же дня: демо не уезжает в неопубликованные дни.
    def _running(self, u):
        return bool(u and u["time_flow"] and u["demo_anchor"] and not self.frozen)

    def now(self, uid, seconds=False):
        u = self.user(uid)
        base = (u and u["demo_now"]) or DEFAULT_NOW
        t = dt.datetime.fromisoformat(base)
        if self._running(u):
            elapsed = (self.clock() - dt.datetime.fromisoformat(u["demo_anchor"])) * (u["clock_speed"] or 1)
            if elapsed.total_seconds() > 0:
                t = min(t + elapsed, t.replace(hour=23, minute=59, second=59))
        return t.strftime("%Y-%m-%dT%H:%M:%S" if seconds else "%Y-%m-%dT%H:%M")

    def demo_range(self, uid):
        """Дни, на которые можно поставить демо-время: опубликованные недели и сессия ± неделя."""
        pub = self.published(uid)
        days = [p["from"] for p in pub] + [p["to"] for p in pub] + [e["date"] for e in self.exams(uid)] or [DEFAULT_NOW[:10]]
        lo = dt.date.fromisoformat(min(days)) - dt.timedelta(days=7)
        hi = dt.date.fromisoformat(max(days)) + dt.timedelta(days=7)
        return {"from": lo.isoformat(), "to": hi.isoformat()}

    def start_clock(self, uid, reset_speed=False):
        """Часы идут от текущего значения с этой секунды (вход, смена времени, включение хода)."""
        self.x("UPDATE users SET demo_anchor=?" + (", clock_speed=1" if reset_speed else "") + " WHERE id=?",
               (self.clock().isoformat(timespec="seconds"), uid))

    def set_preferences(self, uid, theme=None, demo_now=None, time_flow=None, clock_speed=None):
        if clock_speed is not None:
            if isinstance(clock_speed, bool) or not isinstance(clock_speed, (int, float)) or not (1 <= clock_speed <= 2000):
                raise ValueError("clock_speed")
            if demo_now is None:  # смена скорости: часы продолжают от текущего значения
                self.x("UPDATE users SET demo_now=? WHERE id=?", (self.now(uid), uid))
                self.start_clock(uid)
            self.x("UPDATE users SET clock_speed=? WHERE id=?", (float(clock_speed), uid))
        if theme is not None:
            if theme not in ("system", "light", "dark"):
                raise ValueError("theme")
            self.x("UPDATE users SET theme=? WHERE id=?", (theme, uid))
        if demo_now is not None:
            if demo_now not in DEMO_NOW_PRESETS:
                # любая минута в пределах демо-периода (ползунок дня)
                if not isinstance(demo_now, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d", demo_now):
                    raise ValueError("demo_now")
                try:
                    dt.datetime.fromisoformat(demo_now)
                except ValueError:
                    raise ValueError("demo_now")
                r = self.demo_range(uid)
                if not (r["from"] <= demo_now[:10] <= r["to"]):
                    raise ValueError("demo_now")
            self.x("UPDATE users SET demo_now=? WHERE id=?", (demo_now, uid))
            self.start_clock(uid)
        if time_flow is not None:
            if not isinstance(time_flow, bool):
                raise ValueError("time_flow")
            if not time_flow:
                # остановить часы на текущем значении
                self.x("UPDATE users SET demo_now=?, time_flow=0, demo_anchor=NULL WHERE id=?", (self.now(uid), uid))
            else:
                self.x("UPDATE users SET time_flow=1 WHERE id=?", (uid,))
                self.start_clock(uid)

    def set_tour(self, uid, done):
        self.x("UPDATE users SET tour_done_at=? WHERE id=?", (self.now(uid) if done else None, uid))

    def set_page_tour(self, uid, page, seen=True):
        """Знакомство с разделом показано (или снова нужно). page="*" — все разделы сразу."""
        if page != "*" and page not in TOUR_PAGES:
            raise ValueError("page")
        cur = [x for x in (self.one("SELECT tours_seen FROM users WHERE id=?", (uid,))["tours_seen"] or "").split(",") if x]
        pages = list(TOUR_PAGES) if page == "*" else [page]
        cur = [x for x in TOUR_PAGES if (x in cur or (seen and x in pages)) and not (not seen and x in pages)]
        self.x("UPDATE users SET tours_seen=? WHERE id=?", (",".join(cur), uid))
        return cur

    def reset_tours(self, uid):
        """«Пройти снова»: главное знакомство и знакомства с разделами покажутся заново."""
        self.x("UPDATE users SET tour_done_at=NULL, tours_seen='' WHERE id=?", (uid,))

    # -------------------------------------------------------------- schedule
    def _lesson_out(self, r, now=None):
        change = None
        # Изменение «из будущего»: пока демо-часы не дошли до объявления, занятие показывается как было.
        if now and r["status"] != "normal" and r["change_announced"] and r["change_announced"] > now:
            return {
                "id": r["id"], "date": r["date"], "start": r["old_start"] or r["start"], "end": r["old_end"] or r["end"],
                "subject_id": r["subject_id"], "subject": r["subject"], "control": r.get("control"),
                "kind": r["kind"], "teacher": r["teacher"], "room": r["old_room"] or r["room"], "building": r["old_building"] or r["building"],
                "status": "normal", "change": None,
            }
        if r["status"] != "normal":
            if r["status"] == "cancelled":
                kind = "cancelled"
            elif r["old_room"] and r["old_start"]:
                kind = "room_time"
            elif r["old_room"]:
                kind = "room"
            else:
                kind = "time"
            change = {
                "kind": kind,
                "old": {"start": r["old_start"] or r["start"], "end": r["old_end"] or r["end"],
                        "room": r["old_room"] or r["room"], "building": r["old_building"] or r["building"]},
                "reason": r["change_reason"],
                "announced_at": r["change_announced"],
                "acknowledged_at": r["change_ack"],
            }
        return {
            "id": r["id"], "date": r["date"], "start": r["start"], "end": r["end"],
            "subject_id": r["subject_id"], "subject": r["subject"], "control": r.get("control"),
            "kind": r["kind"], "teacher": r["teacher"], "room": r["room"], "building": r["building"],
            "status": r["status"], "change": change,
        }

    _LESSON_SQL = ("SELECT l.*, s.title AS subject, s.control AS control FROM lessons l "
                   "JOIN subjects s ON s.id=l.subject_id WHERE l.user_id=? ")

    def lessons_between(self, uid, d_from, d_to):
        rows = self.q(self._LESSON_SQL + "AND l.date BETWEEN ? AND ? ORDER BY l.date, l.start", (uid, d_from, d_to))
        now = self.now(uid)
        return sorted([self._lesson_out(r, now) for r in rows], key=lambda l: (l["date"], l["start"]))

    def lesson(self, uid, lid):
        r = self.one(self._LESSON_SQL + "AND l.id=?", (uid, lid))
        return self._lesson_out(r, self.now(uid)) if r else None

    def published(self, uid):
        rows = self.q("SELECT date_from, date_to FROM published WHERE user_id=?", (uid,))
        return [{"from": r["date_from"], "to": r["date_to"]} for r in rows]

    def schedule(self, uid, d_from, d_to):
        pub = self.published(uid)
        days = []
        d = dt.date.fromisoformat(d_from)
        end = dt.date.fromisoformat(d_to)
        lessons = self.lessons_between(uid, d_from, d_to)
        evs, tks, exs = {}, {}, {}
        for e in self.events_between(uid, d_from, d_to):
            evs.setdefault(e["date"], []).append(e)
        # Сроки и экзамены — строкой «весь день» над сеткой календаря (у экзамена известно только начало).
        for t in self.tasks(uid):
            if t["due_date"] and d_from <= t["due_date"] <= d_to:
                tks.setdefault(t["due_date"], []).append({k: t[k] for k in ("id", "title", "due_time", "subject", "done_at")})
        for x in self.exams(uid):
            if d_from <= x["date"] <= d_to:
                exs.setdefault(x["date"], []).append({k: x[k] for k in ("id", "kind", "subject", "start", "room", "building")})
        by_date = {}
        for l in lessons:
            by_date.setdefault(l["date"], []).append(l)
        while d <= end:
            iso = d.isoformat()
            is_pub = any(p["from"] <= iso <= p["to"] for p in pub)
            items = by_date.get(iso, [])
            days.append({"date": iso, "published": is_pub, "lessons": items, "events": evs.get(iso, []),
                         "tasks": tks.get(iso, []), "exams": exs.get(iso, []),
                         "state": "lessons" if items else ("free" if is_pub else "no_data")})
            d += dt.timedelta(days=1)
        return {"from": d_from, "to": d_to, "published": pub, "days": days, "now": self.now(uid)}

    # ------------------------------------------------------- личные события
    # Событие студента в календаре: один день, шаг 15 минут, от 15 минут до суток («24:00» — конец дня).
    def events_between(self, uid, d_from, d_to):
        return self.q("SELECT id, date, start, end, title, note, updated_at FROM events WHERE user_id=? AND date BETWEEN ? AND ? "
                      "ORDER BY date, start, id", (uid, d_from, d_to))

    def event(self, uid, eid):
        return self.one("SELECT id, date, start, end, title, note, updated_at FROM events WHERE id=? AND user_id=?", (eid, uid))

    @staticmethod
    def _event_fields(b, cur=None):
        """Проверка полей события; cur — текущие значения при частичном изменении. Ошибки — {поле: текст}."""
        v = dict(cur or {})
        for k in ("date", "start", "end", "title", "note"):
            if k in b:
                v[k] = b[k]
        errs = {}
        try:
            dt.date.fromisoformat(v.get("date") or "")
        except (TypeError, ValueError):
            errs["date"] = "Неверная дата"

        def minutes(hm):
            if not isinstance(hm, str) or not re.fullmatch(r"\d\d:\d\d", hm):
                return None
            h, m = int(hm[:2]), int(hm[3:])
            if m % 15 or m > 59 or h > 24 or (h == 24 and m):
                return None
            return h * 60 + m
        s, e = minutes(v.get("start")), minutes(v.get("end"))
        if s is None or s >= 24 * 60:
            errs["start"] = "Время начала — с шагом 15 минут"
        if e is None:
            errs["end"] = "Время окончания — с шагом 15 минут"
        elif s is not None and e <= s:
            errs["end"] = "Окончание позже начала"
        title = (v.get("title") or "").strip() if isinstance(v.get("title"), str) else ""
        if not title:
            errs["title"] = "Введите название"
        elif len(title) > 120:
            errs["title"] = "Не длиннее 120 символов"
        note = v.get("note") or ""
        if not isinstance(note, str) or len(note) > 1000:
            errs["note"] = "Заметка не длиннее 1000 символов"
        if errs:
            raise ValueError(errs)
        return {"date": v["date"], "start": v["start"], "end": v["end"], "title": title, "note": note.strip()}

    def create_event(self, uid, b):
        f = self._event_fields(b)
        now = iso_now_msk()
        eid = self.x("INSERT INTO events(user_id,date,start,end,title,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                     (uid, f["date"], f["start"], f["end"], f["title"], f["note"], now, now))
        return self.event(uid, eid)

    def update_event(self, uid, eid, b):
        cur = self.event(uid, eid)
        if not cur:
            return None
        f = self._event_fields(b, cur)
        self.x("UPDATE events SET date=?, start=?, end=?, title=?, note=?, updated_at=? WHERE id=? AND user_id=?",
               (f["date"], f["start"], f["end"], f["title"], f["note"], iso_now_msk(), eid, uid))
        return self.event(uid, eid)

    def delete_event(self, uid, eid):
        cur = self.event(uid, eid)
        if cur:
            self.x("DELETE FROM events WHERE id=? AND user_id=?", (eid, uid))
        return cur

    def ack_change(self, uid, lid):
        l = self.lesson(uid, lid)
        if not l:
            return None, "not_found"
        if not l["change"]:
            return None, "no_change"
        if l["change"]["acknowledged_at"]:
            return l, "already"
        self.x("UPDATE lessons SET change_ack=? WHERE id=? AND user_id=?", (self.now(uid), lid, uid))
        return self.lesson(uid, lid), "ok"

    # ---------------------------------------------------------------- grades
    def subjects(self, uid):
        subs = self.q("SELECT * FROM subjects WHERE user_id=? ORDER BY id", (uid,))
        items = self.q("SELECT * FROM grade_items WHERE user_id=? ORDER BY date", (uid,))
        exams = {e["subject_id"]: e for e in self.q("SELECT * FROM exams WHERE user_id=?", (uid,))}
        out = []
        for s in subs:
            its = [i for i in items if i["subject_id"] == s["id"]]
            score = sum(i["score"] for i in its)
            maxsum = sum(i["max"] for i in its)
            e = exams.get(s["id"])
            out.append({
                "id": s["id"], "title": s["title"], "control": s["control"], "teacher": s["teacher"],
                "attention": s["attention"], "score": score, "score_max_so_far": maxsum,
                "semester_max": s["max_points"],
                "items": [{"id": i["id"], "title": i["title"], "kind": i["kind"], "date": i["date"],
                           "score": i["score"], "max": i["max"]} for i in its],
                "exam_id": e["id"] if e else None,
            })
        return out

    def subject(self, uid, sid):
        for s in self.subjects(uid):
            if s["id"] == sid:
                s["tasks"] = self.tasks(uid, subject_id=sid)
                return s
        return None

    def exams(self, uid):
        rows = self.q("SELECT e.*, s.title AS subject, s.teacher AS teacher FROM exams e JOIN subjects s ON s.id=e.subject_id"
                      " WHERE e.user_id=? ORDER BY e.date, e.start", (uid,))
        return rows

    def exam(self, uid, eid):
        return self.one("SELECT e.*, s.title AS subject, s.teacher AS teacher FROM exams e JOIN subjects s ON s.id=e.subject_id"
                        " WHERE e.user_id=? AND e.id=?", (uid, eid))

    def past_results(self, uid):
        return self.q("SELECT id, semester, title, control, result, date FROM past_results WHERE user_id=? ORDER BY date DESC", (uid,))

    # ----------------------------------------------------------------- tasks
    def tasks(self, uid, subject_id=None):
        sql = ("SELECT t.*, s.title AS subject FROM tasks t LEFT JOIN subjects s ON s.id=t.subject_id WHERE t.user_id=?")
        args = [uid]
        if subject_id:
            sql += " AND t.subject_id=?"
            args.append(subject_id)
        return self.q(sql + " ORDER BY t.due_date, t.due_time", args)

    def task(self, uid, tid):
        rows = [t for t in self.tasks(uid) if t["id"] == tid]
        return rows[0] if rows else None

    def set_task_done(self, uid, tid, done):
        t = self.task(uid, tid)
        if not t:
            return None
        self.x("UPDATE tasks SET done_at=? WHERE id=? AND user_id=?", (self.now(uid) if done else None, tid, uid))
        return self.task(uid, tid)

    # -------------------------------------------------------------- requests
    def _request_out(self, r, with_events=True, now=None, live=None):
        p = json.loads(r["payload"])
        r = dict(r)
        # Статус из «живого» сценария, если он уже наступил и позже сохранённого
        lv = (live or {}).get(r["id"])
        if lv and lv["at"] >= r["updated_at"]:
            r["status"], r["updated_at"] = lv["status"], lv["at"]
        out = {
            "id": r["id"], "type": r["type"], "type_label": REQUEST_TYPES[r["type"]],
            "status": r["status"], "status_label": STATUS_LABELS[r["status"]],
            "payload": p, "answer": r["answer"], "created_at": r["created_at"], "updated_at": r["updated_at"],
            "title": REQUEST_TYPES[r["type"]] if r["type"] != "dean_appeal" else (p.get("subject") or REQUEST_TYPES[r["type"]]),
            "can_cancel": r["status"] in CANCELLABLE,
            "has_document": r["type"] != "dean_appeal" and r["status"] in ("ready", "received"),
            "demo_example": bool(r["demo"]),
        }
        if with_events:
            out["events"] = self.q("SELECT at, status, text FROM request_events WHERE request_id=? AND (scripted=0 OR at <= ?) ORDER BY at, id",
                                   (r["id"], now or self.now(r["user_id"])))
            for e in out["events"]:
                e["status_label"] = STATUS_LABELS.get(e["status"], e["status"])
        return out

    def requests(self, uid):
        rows = self.q("SELECT * FROM requests WHERE user_id=? ORDER BY created_at DESC, id DESC", (uid,))
        now = self.now(uid)
        live = self._live_requests(uid, now)
        return [self._request_out(r, with_events=False, now=now, live=live) for r in rows]

    def request(self, uid, rid):
        r = self.one("SELECT * FROM requests WHERE user_id=? AND id=?", (uid, rid))
        if not r:
            return None
        now = self.now(uid)
        return self._request_out(r, now=now, live=self._live_requests(uid, now))

    def _live_requests(self, uid, now):
        """Последнее наступившее событие сценария по каждой заявке: {request_id: {at, status}}."""
        out = {}
        for e in self.q("SELECT e.request_id, e.at, e.status FROM request_events e JOIN requests r ON r.id=e.request_id"
                        " WHERE r.user_id=? AND e.scripted=1 AND e.at <= ? ORDER BY e.at, e.id", (uid, now)):
            out[e["request_id"]] = {"at": e["at"], "status": e["status"]}
        return out

    def create_request(self, uid, rtype, payload, idem_key):
        """Возвращает (request, outcome): created | replayed | conflict | invalid."""
        clean, errors = validate_request(rtype, payload)
        if errors:
            return {"errors": errors}, "invalid"
        body_hash = hashlib.sha256(json.dumps([rtype, clean], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            prev = self.one("SELECT * FROM idempotency WHERE user_id=? AND key=?", (uid, idem_key))
            if prev:
                existing = self.request(uid, prev["request_id"])
                if prev["body_hash"] == body_hash:
                    return existing, "replayed"
                return existing, "conflict"
            now = self.now(uid)
            # Реальное время отправки сохраняем вместе с демо-датой, чтобы порядок был стабилен.
            cur = self.db.execute(
                "INSERT INTO requests(user_id,type,status,payload,created_at,updated_at,demo) VALUES(?,?,?,?,?,?,0)",
                (uid, rtype, "accepted", json.dumps(clean, ensure_ascii=False), now, now))
            rid = cur.lastrowid
            self.db.execute("INSERT INTO request_events(request_id,at,status,text,actor) VALUES(?,?,?,?,'student')",
                            (rid, now, "accepted", "Заявка принята. Демо-режим: дальнейшая обработка не выполняется"))
            self.db.execute("INSERT INTO idempotency VALUES(?,?,?,?,?)",
                            (uid, idem_key, body_hash, rid, dt.datetime.now().timestamp()))
            self.db.execute("DELETE FROM drafts WHERE user_id=? AND type=?", (uid, rtype))
            self.db.commit()
        return self.request(uid, rid), "created"

    def cancel_request(self, uid, rid):
        r = self.request(uid, rid)
        if not r:
            return None, "not_found"
        if r["status"] == "cancelled":
            return r, "already"
        if not r["can_cancel"]:
            return r, "not_allowed"
        now = self.now(uid)
        with self.lock:
            self._drop_future_script(uid, rid)
            self.db.execute("UPDATE requests SET status='cancelled', updated_at=? WHERE id=? AND user_id=?", (now, rid, uid))
            self.db.execute("INSERT INTO request_events(request_id,at,status,text,actor) VALUES(?,?,?,?,'student')",
                            (rid, now, "cancelled", "Отменена студентом"))
            self.db.commit()
        return self.request(uid, rid), "ok"

    def set_received(self, uid, rid, received):
        r = self.request(uid, rid)
        if not r:
            return None, "not_found"
        if not r["has_document"]:
            return r, "not_allowed"
        target = "received" if received else "ready"
        if r["status"] == target:
            return r, "already"
        now = self.now(uid)
        with self.lock:
            self._drop_future_script(uid, rid)
            self.db.execute("UPDATE requests SET status=?, updated_at=? WHERE id=? AND user_id=?", (target, now, rid, uid))
            self.db.execute("INSERT INTO request_events(request_id,at,status,text,actor) VALUES(?,?,?,?,'student')",
                            (rid, now, target, "Отмечено получение" if received else "Отметка о получении снята"))
            self.db.commit()
        return self.request(uid, rid), "ok"

    # ---------------------------------------------------------------- drafts
    def drafts(self, uid):
        rows = self.q("SELECT type, payload, updated_at FROM drafts WHERE user_id=?", (uid,))
        return {r["type"]: {"payload": json.loads(r["payload"]), "updated_at": r["updated_at"]} for r in rows}

    def save_draft(self, uid, rtype, payload):
        if rtype not in REQUEST_TYPES or not isinstance(payload, dict):
            raise ValueError("draft")
        data = json.dumps(payload, ensure_ascii=False)
        if len(data) > 20000:
            raise ValueError("draft_too_large")
        self.x("INSERT INTO drafts VALUES(?,?,?,?) ON CONFLICT(user_id,type) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
               (uid, rtype, data, self.now(uid)))  # черновик датируется демо-временем, как всё в кабинете

    def delete_draft(self, uid, rtype):
        self.x("DELETE FROM drafts WHERE user_id=? AND type=?", (uid, rtype))

    # --------------------------------------------------------- notifications
    def notifications(self, uid):
        rows = self.q("SELECT * FROM notifications WHERE user_id=? AND created_at <= ? ORDER BY created_at DESC, id DESC",
                      (uid, self.now(uid)))
        return [self._notif_out(r) for r in rows]

    def _notif_out(self, r):
        r = dict(r)
        r["category_label"] = NOTIF_CATEGORIES[r["category"]]
        r["read"] = bool(r["read_at"])
        return r

    def notification(self, uid, nid):
        r = self.one("SELECT * FROM notifications WHERE user_id=? AND id=? AND created_at <= ?", (uid, nid, self.now(uid)))
        return self._notif_out(r) if r else None

    def set_read(self, uid, nid, read):
        n = self.notification(uid, nid)
        if not n:
            return None
        self.x("UPDATE notifications SET read_at=? WHERE id=? AND user_id=?",
               (self.now(uid) if read else None, nid, uid))
        return self.notification(uid, nid)

    def read_all(self, uid, category=None):
        now = self.now(uid)
        sql = "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND created_at <= ?"
        args = [now, uid, now]
        if category:
            sql += " AND category=?"
            args.append(category)
        with self.lock:
            ids = [r[0] for r in self.db.execute(
                "SELECT id FROM notifications WHERE user_id=? AND read_at IS NULL AND created_at <= ?" + (" AND category=?" if category else ""),
                [uid, now] + ([category] if category else [])).fetchall()]
            self.db.execute(sql, args)
            self.db.commit()
        return ids

    def unread_count(self, uid):
        return self.one("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL AND created_at <= ?",
                        (uid, self.now(uid)))["n"]

    # -------------------------------------------------------------- calendar
    # Ссылка подписки — «секретный адрес», как у Google/Apple: хранится, чтобы её можно было показать снова;
    # перевыпуск делает старую ссылку недействительной.
    def cal_token_info(self, uid):
        r = self.one("SELECT token, created_at FROM calendar_tokens WHERE user_id=?", (uid,))
        return {"token": r["token"], "created_at": r["created_at"]} if r else {"token": None}

    def create_cal_token(self, uid):
        token = secrets.token_urlsafe(24)
        self.x("INSERT INTO calendar_tokens VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token, created_at=excluded.created_at",
               (uid, token, iso_now_msk()))
        return self.cal_token_info(uid)

    def revoke_cal_token(self, uid):
        self.x("DELETE FROM calendar_tokens WHERE user_id=?", (uid,))

    def user_by_cal_token(self, token):
        r = self.one("SELECT user_id FROM calendar_tokens WHERE token=?", (token,))
        return r and r["user_id"]

    # --------------------------------------------------------------- summary
    def last_visit(self, uid):
        u = self.user(uid)
        return (u and u["last_visit"]) or DEFAULT_LAST_VISIT

    def set_last_visit(self, uid, at=None):
        prev = self.last_visit(uid)
        now = self.now(uid)
        at = at or now
        try:
            dt.datetime.fromisoformat(at)
        except (TypeError, ValueError):
            raise ValueError("at")
        if len(at) != 16 or at > now:
            raise ValueError("at")
        self.x("UPDATE users SET last_visit=? WHERE id=?", (at, uid))
        return {"last_visit": at, "previous": prev}

    def summary_since(self, uid):
        """Что появилось после прошлого визита и не позже демо-«сейчас». Одно событие — один пункт."""
        cur, now = self.last_visit(uid), self.now(uid)
        rows = self.q(self._LESSON_SQL + "AND l.change_announced > ? AND l.change_announced <= ? ORDER BY l.change_announced DESC", (uid, cur, now))
        schedule = [{"kind": "change", "at": r["change_announced"], "lesson": self._lesson_out(r)} for r in rows]
        ev = self.q("SELECT e.at, e.status, e.text, r.id AS rid FROM request_events e JOIN requests r ON r.id=e.request_id "
                    "WHERE r.user_id=? AND e.actor='office' AND e.at > ? AND e.at <= ? AND e.status IN (%s) ORDER BY e.at DESC" % ",".join("?" * len(OFFICE_STATUSES)),
                    (uid, cur, now) + OFFICE_STATUSES)
        documents = []
        for e in ev:
            r = self.request(uid, e["rid"])
            documents.append({"kind": "request", "at": e["at"], "status": e["status"], "status_label": STATUS_LABELS[e["status"]], "request": {
                "id": r["id"], "title": r["title"], "type_label": r["type_label"], "status": r["status"], "status_label": r["status_label"], "has_document": r["has_document"]}})
        notes = self.q("SELECT * FROM notifications WHERE user_id=? AND category IN ('deadlines','announcements') AND created_at > ? AND created_at <= ? ORDER BY created_at DESC",
                       (uid, cur, now))
        deadlines = []
        for n in notes:
            if n["category"] != "deadlines":
                continue
            item = {"kind": "deadline", "at": n["created_at"], "notification": self._notif_out(n)}
            if n["link_type"] == "task":  # срок берём из задачи: заголовок уведомления мог устареть («— сегодня»)
                t = self.task(uid, n["link_id"])
                if t:
                    item["task"] = {"id": t["id"], "title": t["title"], "due_date": t["due_date"], "due_time": t["due_time"], "done": bool(t["done_at"])}
            deadlines.append(item)
        announcements = [{"kind": "announcement", "at": n["created_at"], "notification": self._notif_out(n)} for n in notes if n["category"] == "announcements"]
        groups = {"schedule": schedule, "documents": documents, "deadlines": deadlines, "announcements": announcements}
        return {"since": cur, "now": now, "groups": groups, "total": sum(len(v) for v in groups.values())}

    def summary_week(self, uid):
        now = self.now(uid)
        d0 = now[:10]
        d6 = (dt.date.fromisoformat(d0) + dt.timedelta(days=6)).isoformat()
        sched = self.schedule(uid, d0, d6)
        days = []
        for d in sched["days"]:
            active = [l for l in d["lessons"] if l["status"] != "cancelled"]
            first = active[0] if active else None
            days.append({"date": d["date"], "state": d["state"], "count": len(active),
                         "cancelled": len(d["lessons"]) - len(active),
                         "changes": sum(1 for l in d["lessons"] if l["change"]),
                         "first": first and {"id": first["id"], "start": first["start"], "subject": first["subject"], "room": first["room"], "building": first["building"]},
                         "last_end": active[-1]["end"] if active else None})
        lessons = [l for d in sched["days"] for l in d["lessons"]]
        changes = [l for l in lessons if l["change"] and not (l["date"] == d0 and l["end"] <= now[11:16])]
        tasks = [t for t in self.tasks(uid) if not t["done_at"] and t["due_date"] and t["due_date"] <= d6]
        exams = [e for e in self.exams(uid) if e["date"] >= d0]
        reqs = self.requests(uid)
        return {
            "from": d0, "to": d6, "now": now, "days": days,
            "lessons_total": sum(x["count"] for x in days),
            "changes": changes,
            "tasks": [{"id": t["id"], "title": t["title"], "due_date": t["due_date"], "due_time": t["due_time"], "subject": t["subject"], "overdue": "%sT%s" % (t["due_date"], t["due_time"] or "23:59") <= now} for t in tasks],
            "next_exam": exams[0] if exams else None,
            "documents_ready": [{"id": r["id"], "title": r["title"], "type_label": r["type_label"]} for r in reqs if r["status"] == "ready" and r["has_document"]],
            "requests_open": sum(1 for r in reqs if r["status"] in ("accepted", "in_progress")),
            "unread": self.unread_count(uid),
        }

    # ----------------------------------------------------------------- today
    def today(self, uid):
        now = self.now(uid)
        date, hm = now[:10], now[11:16]
        lessons = self.lessons_between(uid, date, date)
        current = next((l for l in lessons if l["status"] != "cancelled" and l["start"] <= hm < l["end"]), None)
        upcoming = [l for l in lessons if l["status"] != "cancelled" and l["start"] > hm]
        nxt = upcoming[0] if upcoming else None
        next_day = None
        if True:  # первая пара следующего учебного дня — всегда: клиент сам решает, когда её показать (время идёт)
            later = self.lessons_between(uid, (dt.date.fromisoformat(date) + dt.timedelta(days=1)).isoformat(),
                                         (dt.date.fromisoformat(date) + dt.timedelta(days=14)).isoformat())
            later = [l for l in later if l["status"] != "cancelled"]
            next_day = later[0] if later else None
        week_end = (dt.date.fromisoformat(date) + dt.timedelta(days=13)).isoformat()
        changes = [l for l in self.lessons_between(uid, date, week_end)
                   if l["change"] and not l["change"]["acknowledged_at"]
                   and not (l["date"] == date and l["end"] <= hm)]
        tasks = self.tasks(uid)
        horizon = (dt.date.fromisoformat(date) + dt.timedelta(days=7)).isoformat()
        tasks = [t for t in tasks if (t["due_date"] or "") <= horizon and (not t["done_at"] or t["done_at"][:10] == date or t["due_date"] >= date)]
        docs = [r for r in self.requests(uid) if r["status"] == "ready" and r["has_document"]]
        answers = [r for r in self.requests(uid) if r["status"] == "answered" and r["updated_at"] >= (dt.date.fromisoformat(date) - dt.timedelta(days=7)).isoformat()]
        pub = self.published(uid)
        return {
            "now": now, "date": date,
            "published": any(p["from"] <= date <= p["to"] for p in pub),
            "lessons": lessons,
            "current_id": current["id"] if current else None,
            "next_id": nxt["id"] if nxt else None,
            "next_day_lesson": next_day,
            "changes": changes, "tasks": tasks, "documents": docs, "answers": answers,
            "unread": self.unread_count(uid),
        }

    # ---------------------------------------------------------------- search
    def search(self, uid, query, limit=6):
        ql = query.strip().lower()
        if not ql:
            return {"groups": [], "total": 0}
        def m(*vals):
            return any(ql in (v or "").lower() for v in vals)
        groups = []
        subs = [s for s in self.subjects(uid) if m(s["title"], s["teacher"], s["control"])]
        groups.append(("subjects", "Дисциплины", [{"id": s["id"], "title": s["title"], "meta": "%s · %s" % (s["control"], s["teacher"])} for s in subs]))
        pub = self.published(uid)
        les = [l for l in self.lessons_between(uid, pub[0]["from"], pub[0]["to"]) if m(l["subject"], l["teacher"], l["room"], l["kind"], l["building"])] if pub else []
        now = self.now(uid)[:10]
        les.sort(key=lambda l: (l["date"] < now, l["date"] if l["date"] >= now else "~" + l["date"], l["start"]))
        groups.append(("lessons", "Занятия", [{"id": l["id"], "title": l["subject"], "date": l["date"],
                                                "meta": "%s · %s–%s · ауд. %s" % (l["kind"], l["start"], l["end"], l["room"]),
                                                "status": l["status"]} for l in les]))
        reqs = [r for r in self.requests(uid) if m(r["title"], r["type_label"], r["status_label"], json.dumps(r["payload"], ensure_ascii=False))]
        groups.append(("requests", "Заявки", [{"id": r["id"], "title": r["title"], "meta": "%s · %s" % (r["type_label"], r["status_label"])} for r in reqs]))
        nots = [n for n in self.notifications(uid) if m(n["title"], n["body"])]
        groups.append(("notifications", "Уведомления", [{"id": n["id"], "title": n["title"], "meta": n["category_label"]} for n in nots]))
        exs = [e for e in self.exams(uid) if m(e["subject"], e["kind"], e["room"])]
        groups.append(("exams", "Сессия", [{"id": e["id"], "title": "%s — %s" % (e["kind"], e["subject"]), "date": e["date"], "meta": e["start"]} for e in exs]))
        out = []
        total = 0
        for key, label, items in groups:
            if items:
                total += len(items)
                out.append({"key": key, "label": label, "total": len(items), "items": items[:limit]})
        return {"groups": out, "total": total}


def _h(token):
    return hashlib.sha256(token.encode()).hexdigest()


# ------------------------------------------------------------------ validation
STUDY_PURPOSES = ["По месту требования", "Военный комиссариат", "Посольство или визовый центр",
                  "По месту работы родителей", "Банк", "Другое"]
STIPEND_PURPOSES = ["По месту требования", "Социальная защита", "Банк", "Другое"]
APPEAL_TOPICS = ["Индивидуальный график", "Перезачёт дисциплины", "Пересдача", "Академический отпуск", "Другое"]


def _month_ok(v):
    try:
        y, mth = v.split("-")
        return len(y) == 4 and 1 <= int(mth) <= 12
    except Exception:
        return False


def validate_request(rtype, p):
    errors = {}
    if rtype not in REQUEST_TYPES:
        return None, {"type": "Неизвестный тип заявки"}
    if not isinstance(p, dict):
        return None, {"_": "Неверный формат данных"}

    def text(key, max_len, required=False, min_len=0, label=""):
        v = p.get(key, "")
        if v is None:
            v = ""
        if not isinstance(v, str):
            errors[key] = "Неверное значение"
            return ""
        v = v.strip()
        if required and not v:
            errors[key] = "Заполните поле «%s»" % label
        elif v and len(v) < min_len:
            errors[key] = "Минимум %d символов — сейчас %d" % (min_len, len(v))
        elif len(v) > max_len:
            errors[key] = "Максимум %d символов — сейчас %d" % (max_len, len(v))
        return v

    def copies():
        try:
            c = int(p.get("copies", 1))
        except (TypeError, ValueError):
            errors["copies"] = "Укажите число экземпляров"
            return 1
        if not 1 <= c <= 5:
            errors["copies"] = "От 1 до 5 экземпляров"
        return c

    if rtype == "study_cert":
        purpose = p.get("purpose")
        if purpose not in STUDY_PURPOSES:
            errors["purpose"] = "Выберите, куда нужна справка"
        clean = {"purpose": purpose, "copies": copies(),
                 "language": p.get("language") if p.get("language") in ("ru", "en") else None,
                 "delivery": p.get("delivery") if p.get("delivery") in ("electronic", "office") else None,
                 "comment": text("comment", 500)}
        if purpose == "Другое" and not clean["comment"]:
            errors["comment"] = "Укажите, куда нужна справка"
        if not clean["language"]:
            errors["language"] = "Выберите язык справки"
        if not clean["delivery"]:
            errors["delivery"] = "Выберите способ получения"
    elif rtype == "stipend_cert":
        pf, pt = p.get("period_from"), p.get("period_to")
        if not isinstance(pf, str) or not _month_ok(pf):
            errors["period_from"] = "Укажите месяц начала периода"
        if not isinstance(pt, str) or not _month_ok(pt):
            errors["period_to"] = "Укажите месяц конца периода"
        if "period_from" not in errors and "period_to" not in errors and pf > pt:
            errors["period_to"] = "Конец периода раньше начала"
        purpose = p.get("purpose")
        if purpose not in STIPEND_PURPOSES:
            errors["purpose"] = "Выберите, куда нужна справка"
        clean = {"period_from": pf, "period_to": pt, "purpose": purpose, "copies": copies()}
    else:
        topic = p.get("topic")
        if topic not in APPEAL_TOPICS:
            errors["topic"] = "Выберите тему обращения"
        clean = {"topic": topic,
                 "subject": text("subject", 120, required=True, min_len=5, label="Кратко о сути"),
                 "message": text("message", 2000, required=True, min_len=20, label="Текст обращения"),
                 "email": text("email", 120, required=True, label="Почта для ответа")}
        if clean["email"] and ("@" not in clean["email"] or "." not in clean["email"].split("@")[-1]):
            errors["email"] = "Проверьте адрес почты"
    return clean, errors
