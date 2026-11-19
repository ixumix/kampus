"""Содержательные API-тесты «Кампуса» на отдельной временной базе.

Запуск: python -m unittest discover -s tests -v
"""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

os.environ.setdefault("CAMPUS_PBKDF2_ITERS", "2000")
os.environ.setdefault("CAMPUS_FROZEN_TIME", "1")  # демо-часы стоят: тексты вида «осталось 5 мин» проверяются точно
os.environ["CAMPUS_QUIET"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.app import make_server, open_store  # noqa: E402
from server.ai import WeekBriefAI  # noqa: E402
from fake_ai import FakeModel  # noqa: E402


class Client:
    def __init__(self, port):
        self.port = port
        self.cookie = None
        self.csrf = None

    def call(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Content-Type": "application/json"}
        if self.cookie:
            h["Cookie"] = self.cookie
        if self.csrf and method != "GET":
            h["X-CSRF-Token"] = self.csrf
        h.update(headers or {})
        conn.request(method, path, json.dumps(body) if body is not None else None, h)
        r = conn.getresponse()
        data = r.read()
        sc = r.getheader("Set-Cookie")
        if sc and sc.startswith("campus_sid="):
            v = sc.split(";")[0]
            self.cookie = None if v == "campus_sid=" else v
        conn.close()
        if raw:
            return r.status, data, r
        return r.status, (json.loads(data.decode()) if data else None)

    def login(self, login, password):
        st, b = self.call("POST", "/api/auth/login", {"login": login, "password": password})
        if st == 200:
            self.csrf = b["csrf"]
        return st, b


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.store = open_store(os.path.join(cls.tmp, "test.db"))
        cls.model = FakeModel(key=False)
        cls.srv = make_server(cls.store, port=0, dev=True, ai=WeekBriefAI(cls.model))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def anna(self):
        c = Client(self.port)
        self.assertEqual(c.login("belova", "kampus-anna")[0], 200)
        return c

    def timur(self):
        c = Client(self.port)
        self.assertEqual(c.login("galiev", "kampus-timur")[0], 200)
        return c

    # ------------------------------------------------------------- auth
    def test_login_logout_and_cookie_flags(self):
        c = Client(self.port)
        st, b = c.call("POST", "/api/auth/login", {"login": "belova", "password": "wrong"})
        self.assertEqual(st, 401)
        self.assertEqual(b["error"], "bad_credentials")
        st, data, r = c.call("POST", "/api/auth/login", {"login": "Belova ", "password": "kampus-anna"}, raw=True)
        self.assertEqual(st, 200)
        sc = r.getheader("Set-Cookie")
        self.assertIn("HttpOnly", sc)
        self.assertIn("SameSite=Strict", sc)
        body = json.loads(data)
        self.assertNotIn("password_hash", json.dumps(body))
        self.assertEqual(body["user"]["group_name"], "2МО-3")
        c.csrf = body["csrf"]
        self.assertEqual(c.call("GET", "/api/session")[0], 200)
        self.assertEqual(c.call("POST", "/api/auth/logout", {})[0], 200)
        self.assertEqual(c.call("GET", "/api/session")[0], 401)

    def test_unauthenticated_api_is_rejected(self):
        c = Client(self.port)
        for path in ("/api/today", "/api/requests", "/api/grades", "/api/notifications", "/api/lessons/1"):
            st, b = c.call("GET", path)
            self.assertEqual(st, 401, path)
            self.assertEqual(b["error"], "unauthorized")

    def test_csrf_required_for_mutations(self):
        c = self.anna()
        token = c.csrf
        c.csrf = None
        st, b = c.call("POST", "/api/notifications/read-all", {})
        self.assertEqual((st, b["error"]), (403, "csrf"))
        c.csrf = token
        st, b = c.call("POST", "/api/notifications/read-all", {}, headers={"Origin": "http://evil.example"})
        self.assertEqual((st, b["error"]), (403, "bad_origin"))

    def test_session_expiry_is_reported(self):
        c = self.anna()
        c.call("POST", "/api/dev/fault", {"expire_session": True})
        st, b = c.call("GET", "/api/today")
        self.assertEqual((st, b["error"]), (401, "session_expired"))

    # ------------------------------------------------------- isolation
    def test_accounts_are_isolated_including_direct_ids(self):
        a, t = self.anna(), self.timur()
        a_req = a.call("GET", "/api/requests")[1]["requests"][0]["id"]
        a_les = a.call("GET", "/api/today")[1]["lessons"][0]["id"]
        a_sub = a.call("GET", "/api/grades")[1]["subjects"][0]["id"]
        a_not = a.call("GET", "/api/notifications")[1]["notifications"][0]["id"]
        for path in ("/api/requests/%d" % a_req, "/api/lessons/%d" % a_les, "/api/subjects/%d" % a_sub,
                     "/api/requests/%d/document" % a_req, "/api/lessons/%d.ics" % a_les):
            self.assertEqual(t.call("GET", path)[0], 404, path)
        for path, body in (("/api/requests/%d/cancel" % a_req, {}), ("/api/lessons/%d/ack" % a_les, {}),
                           ("/api/notifications/%d/read" % a_not, {"read": True})):
            self.assertEqual(t.call("POST", path, body)[0], 404, path)
        # поиск Тимура не находит дисциплины Анны
        res = t.call("GET", "/api/search?q=%D0%BF%D1%80%D0%B0%D0%B2%D0%BE")[1]
        self.assertFalse(any("право" in i["title"].lower() for g in res["groups"] for i in g["items"]))

    # -------------------------------------------------------- schedule
    def test_today_current_next_and_change(self):
        d = self.anna().call("GET", "/api/today")[1]
        self.assertEqual(d["now"], "2026-11-16T10:15")
        cur = next(l for l in d["lessons"] if l["id"] == d["current_id"])
        nxt = next(l for l in d["lessons"] if l["id"] == d["next_id"])
        self.assertEqual((cur["start"], cur["subject"]), ("09:00", "Теория международных отношений"))
        self.assertEqual(nxt["start"], "10:30")
        self.assertEqual(nxt["change"]["kind"], "room")
        self.assertEqual((nxt["change"]["old"]["room"], nxt["room"]), ("412", "318"))
        self.assertTrue(any(r["status"] == "ready" for r in d["documents"]))

    def test_timur_has_different_day(self):
        d = self.timur().call("GET", "/api/today")[1]
        self.assertIsNone(d["current_id"])
        self.assertEqual(next(l for l in d["lessons"] if l["id"] == d["next_id"])["start"], "12:40")
        self.assertEqual(d["documents"], [])

    def test_free_day_differs_from_no_data(self):
        c = self.anna()
        s = c.call("GET", "/api/schedule?from=2026-11-21&to=2026-11-24")[1]
        states = {d["date"]: d["state"] for d in s["days"]}
        self.assertEqual(states["2026-11-21"], "free")
        self.assertEqual(states["2026-11-23"], "no_data")
        self.assertEqual(c.call("GET", "/api/schedule?from=2026-11-24&to=2026-11-01")[0], 400)

    def test_ack_change_is_idempotent(self):
        c = self.anna()
        lid = c.call("GET", "/api/today")[1]["next_id"]
        st, b = c.call("POST", "/api/lessons/%d/ack" % lid, {})
        self.assertEqual((st, b["outcome"]), (200, "ok"))
        st, b = c.call("POST", "/api/lessons/%d/ack" % lid, {})
        self.assertEqual((st, b["outcome"]), (200, "already"))
        self.assertTrue(all(l["id"] != lid for l in c.call("GET", "/api/today")[1]["changes"]))

    def test_ics_exports(self):
        c = self.anna()
        lid = c.call("GET", "/api/today")[1]["current_id"]
        st, data, r = c.call("GET", "/api/lessons/%d.ics" % lid, raw=True)
        self.assertEqual(st, 200)
        self.assertIn("text/calendar", r.getheader("Content-Type"))
        text = data.decode()
        self.assertIn("DTSTART:20261116T060000Z", text)  # 09:00 МСК
        self.assertTrue(all(len(l.encode()) <= 75 for l in text.split("\r\n")))
        st, data, _ = c.call("GET", "/api/schedule.ics?from=2026-11-16&to=2026-11-22", raw=True)
        self.assertEqual(data.decode().count("BEGIN:VEVENT"), 15)
        self.assertIn("STATUS:CANCELLED", data.decode())

    # ---------------------------------------------------------- grades
    def test_grades_csv_and_exam_ics(self):
        c = self.anna()
        g = c.call("GET", "/api/grades")[1]
        econ = next(s for s in g["subjects"] if s["title"] == "Мировая экономика")
        self.assertTrue(econ["attention"])
        self.assertEqual(econ["score"], 18)
        st, data, r = c.call("GET", "/api/grades.csv", raw=True)
        self.assertTrue(data.startswith("﻿".encode()))
        self.assertIn("не итоговая оценка", data.decode())
        exam = g["exams"][0]
        st, data, _ = c.call("GET", "/api/exams/%d.ics" % exam["id"], raw=True)
        self.assertEqual(st, 200)
        self.assertEqual(len(g["past_results"]), 7)

    # -------------------------------------------------------- requests
    def _new(self, c, key, payload=None, rtype="study_cert"):
        payload = payload or {"purpose": "Военный комиссариат", "copies": 1, "language": "ru", "delivery": "electronic", "comment": ""}
        return c.call("POST", "/api/requests", {"type": rtype, "payload": payload}, headers={"Idempotency-Key": key})

    def test_request_validation(self):
        c = self.anna()
        st, b = self._new(c, "key-invalid-1", {"topic": "Пересдача", "subject": "a", "message": "коротко", "email": "x"}, "dean_appeal")
        self.assertEqual(st, 422)
        self.assertEqual(set(b["fields"]), {"subject", "message", "email"})
        st, b = self._new(c, "key-invalid-2", {"period_from": "2026-10", "period_to": "2026-09", "purpose": "Банк", "copies": 9}, "stipend_cert")
        self.assertEqual(set(b["fields"]), {"period_to", "copies"})
        self.assertEqual(c.call("POST", "/api/requests", {"type": "study_cert", "payload": {}})[0], 400)

    def test_idempotent_create_replay_and_conflict(self):
        c = self.anna()
        before = len(c.call("GET", "/api/requests")[1]["requests"])
        st1, b1 = self._new(c, "key-same-000001")
        st2, b2 = self._new(c, "key-same-000001")
        self.assertEqual((st1, b1["outcome"]), (201, "created"))
        self.assertEqual((st2, b2["outcome"]), (200, "replayed"))
        self.assertEqual(b1["request"]["id"], b2["request"]["id"])
        self.assertEqual(b1["request"]["status"], "accepted")
        st3, b3 = self._new(c, "key-same-000001", {"purpose": "Банк", "copies": 2, "language": "ru", "delivery": "office", "comment": ""})
        self.assertEqual((st3, b3["error"]), (409, "idempotency_conflict"))
        self.assertEqual(b3["request"]["id"], b1["request"]["id"])
        self.assertEqual(len(c.call("GET", "/api/requests")[1]["requests"]), before + 1)
        # тот же ключ у другого аккаунта — независимая заявка
        st4, b4 = self._new(self.timur(), "key-same-000001")
        self.assertEqual(st4, 201)
        self.assertNotEqual(b4["request"]["id"], b1["request"]["id"])

    def test_lost_response_then_retry_does_not_duplicate(self):
        c = self.anna()
        before = len(c.call("GET", "/api/requests")[1]["requests"])
        c.call("POST", "/api/dev/fault", {"drop_next_write": True})
        with self.assertRaises(Exception):
            self._new(c, "key-lost-0000001")
        st, b = self._new(c, "key-lost-0000001")
        self.assertEqual(b["outcome"], "replayed")
        self.assertEqual(len(c.call("GET", "/api/requests")[1]["requests"]), before + 1)

    def test_cancel_and_status_rules(self):
        c = self.anna()
        rid = self._new(c, "key-cancel-00001")[1]["request"]["id"]
        st, b = c.call("POST", "/api/requests/%d/cancel" % rid, {})
        self.assertEqual((st, b["request"]["status"]), (200, "cancelled"))
        self.assertEqual(c.call("POST", "/api/requests/%d/cancel" % rid, {})[1]["outcome"], "already")
        ready = next(r for r in c.call("GET", "/api/requests")[1]["requests"] if r["status"] == "ready")
        self.assertEqual(c.call("POST", "/api/requests/%d/cancel" % ready["id"], {})[0], 409)

    def test_document_download_does_not_change_status(self):
        c = self.anna()
        ready = next(r for r in c.call("GET", "/api/requests")[1]["requests"] if r["status"] == "ready")
        st, data, r = c.call("GET", "/api/requests/%d/document" % ready["id"], raw=True)
        self.assertEqual(st, 200)
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        self.assertIn("ДЕМОНСТРАЦИОННЫЙ ОБРАЗЕЦ", data.decode())
        self.assertEqual(c.call("GET", "/api/requests/%d" % ready["id"])[1]["status"], "ready")
        self.assertEqual(c.call("POST", "/api/requests/%d/received" % ready["id"], {"received": True})[1]["request"]["status"], "received")
        self.assertEqual(c.call("POST", "/api/requests/%d/received" % ready["id"], {"received": False})[1]["request"]["status"], "ready")
        in_work = next(r for r in c.call("GET", "/api/requests")[1]["requests"] if r["status"] == "in_progress")
        self.assertEqual(c.call("GET", "/api/requests/%d/document" % in_work["id"])[0], 409)

    def test_drafts_per_type_and_account(self):
        a, t = self.anna(), self.timur()
        a.call("PUT", "/api/drafts/dean_appeal", {"payload": {"subject": "Черновик Анны"}})
        a.call("PUT", "/api/drafts/study_cert", {"payload": {"comment": "справка"}})
        d = a.call("GET", "/api/requests")[1]["drafts"]
        self.assertEqual(d["dean_appeal"]["payload"]["subject"], "Черновик Анны")
        self.assertEqual(d["study_cert"]["payload"]["comment"], "справка")
        self.assertNotIn("dean_appeal", t.call("GET", "/api/requests")[1]["drafts"])
        self.assertEqual(a.call("PUT", "/api/drafts/unknown", {"payload": {}})[0], 400)

    # --------------------------------------------------- notifications
    def test_read_unread_and_read_all(self):
        c = self.timur()
        ns = c.call("GET", "/api/notifications")[1]["notifications"]
        unread = [n for n in ns if not n["read"]]
        st, b = c.call("POST", "/api/notifications/%d/read" % unread[0]["id"], {"read": True})
        self.assertTrue(b["notification"]["read"])
        self.assertEqual(b["unread"], len(unread) - 1)
        st, b = c.call("POST", "/api/notifications/%d/read" % unread[0]["id"], {"read": False})
        self.assertEqual(b["unread"], len(unread))
        st, b = c.call("POST", "/api/notifications/read-all", {"category": "schedule"})
        self.assertEqual(len(b["ids"]), 1)
        st, b = c.call("POST", "/api/notifications/read-all", {})
        self.assertEqual(b["unread"], 0)
        # чтение уведомления не подтверждает изменение расписания
        self.assertTrue(c.call("GET", "/api/today")[1]["changes"])

    def test_task_done_is_separate(self):
        c = self.timur()
        tid = c.call("GET", "/api/tasks")[1]["tasks"][0]["id"]
        self.assertTrue(c.call("POST", "/api/tasks/%d/done" % tid, {"done": True})[1]["task"]["done_at"])
        self.assertIsNone(c.call("POST", "/api/tasks/%d/done" % tid, {"done": False})[1]["task"]["done_at"])

    # ------------------------------------------------- fault semantics
    def test_read_failure_after_confirmed_write(self):
        c = self.anna()
        n = next(n for n in c.call("GET", "/api/notifications")[1]["notifications"] if n["read"])
        c.call("POST", "/api/dev/fault", {"fail_reads": 1})
        st, b = c.call("POST", "/api/notifications/%d/read" % n["id"], {"read": False})
        self.assertEqual(st, 200)  # запись подтверждена
        self.assertEqual(c.call("GET", "/api/notifications")[0], 503)  # следующее чтение упало
        self.assertFalse(next(x for x in c.call("GET", "/api/notifications")[1]["notifications"] if x["id"] == n["id"])["read"])

    def test_preferences(self):
        c = self.timur()
        self.assertEqual(c.call("PATCH", "/api/preferences", {"theme": "dark"})[1]["user"]["theme"], "dark")
        self.assertEqual(c.call("PATCH", "/api/preferences", {"theme": "neon"})[0], 400)
        self.assertEqual(c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-21T12:00"})[0], 200)
        d = c.call("GET", "/api/today")[1]
        self.assertEqual(d["lessons"][0]["start"], "09:00")  # суббота Тимура: семинар
        c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15", "theme": "system"})

    def test_tour_flag_per_account(self):
        c, a = self.timur(), self.anna()
        self.assertFalse(c.call("GET", "/api/session")[1]["user"]["tour_done"])  # первый вход: тур ещё не пройден
        self.assertEqual(c.call("POST", "/api/tour", {"done": "yes"})[0], 400)
        self.assertEqual(c.call("POST", "/api/tour", {"done": True})[1], {"tour_done": True})
        self.assertTrue(c.call("GET", "/api/session")[1]["user"]["tour_done"])
        self.assertFalse(a.call("GET", "/api/session")[1]["user"]["tour_done"])  # у другого аккаунта свой флаг
        c.call("POST", "/api/tour", {"done": False})
        self.assertFalse(c.call("GET", "/api/session")[1]["user"]["tour_done"])

    def test_page_tours_seen_per_account_and_reset(self):
        # Знакомство с разделом показывается один раз: флаг у каждого аккаунта свой; «Пройти снова» сбрасывает всё.
        a, t = self.anna(), self.timur()
        self.assertEqual(a.call("GET", "/api/session")[1]["user"]["tours_seen"], [])
        self.assertEqual(a.call("POST", "/api/tour", {"page": "grades", "seen": True})[1], {"tours_seen": ["grades"]})
        self.assertEqual(a.call("POST", "/api/tour", {"page": "schedule"})[1], {"tours_seen": ["schedule", "grades"]})
        self.assertEqual(a.call("POST", "/api/tour", {"page": "admin"})[0], 400)
        self.assertEqual(a.call("POST", "/api/tour", {"page": "grades", "seen": "yes"})[0], 400)
        self.assertEqual(t.call("GET", "/api/session")[1]["user"]["tours_seen"], [])  # у другого аккаунта своё
        nocsrf = Client(self.port); nocsrf.cookie = a.cookie
        self.assertEqual(nocsrf.call("POST", "/api/tour", {"page": "profile"})[0], 403)
        self.assertEqual(a.call("POST", "/api/tour", {"page": "*"})[1]["tours_seen"], ["schedule", "grades", "documents", "notifications", "profile"])
        self.assertEqual(a.call("POST", "/api/tour", {"page": "grades", "seen": False})[1]["tours_seen"], ["schedule", "documents", "notifications", "profile"])
        a.call("POST", "/api/tour", {"done": True})
        self.assertEqual(a.call("POST", "/api/tour", {"reset": True})[1], {"tour_done": False, "tours_seen": []})
        u = a.call("GET", "/api/session")[1]["user"]
        self.assertEqual((u["tour_done"], u["tours_seen"]), (False, []))

    def test_week_ai_brief_is_checked_and_cached(self):
        m = self.model
        a = self.anna()
        m.has_key, m.reply, m.calls = False, None, 0
        self.assertFalse(a.call("GET", "/api/session")[1]["meta"]["ai"])
        self.assertEqual(a.call("POST", "/api/summary/week/ai", {})[1], {"ok": False, "reason": "no_key"})
        self.assertEqual(m.calls, 0)
        m.has_key = True
        self.assertTrue(a.call("GET", "/api/session")[1]["meta"]["ai"])
        nocsrf = Client(self.port); nocsrf.cookie = a.cookie
        self.assertEqual(nocsrf.call("POST", "/api/summary/week/ai", {})[0], 403)  # платный вызов — только с CSRF
        st, r = a.call("POST", "/api/summary/week/ai", {})
        self.assertEqual(st, 200)
        self.assertTrue(r["ok"]) ; self.assertFalse(r["cached"])
        self.assertIn("ауд. 318", r["text"])
        # в модель уходят только факты недели — без ФИО, логина, почты и телефона
        for secret in ("Белова", "belova", "@", "+7"):
            self.assertNotIn(secret, m.last_user)
        self.assertIn("412", m.last_user)
        self.assertTrue(a.call("POST", "/api/summary/week/ai", {})[1]["cached"])  # те же факты — без второго вызова
        self.assertEqual(m.calls, 1)
        # выдуманное число (аудитория, которой нет в данных) — ответ отброшен
        m.reply = "Пара переехала в ауд. 999."
        t = self.timur()  # вход прогревает абзац в фоне — ответ тот же, с выдуманной аудиторией
        r = t.call("POST", "/api/summary/week/ai", {})[1]
        self.assertEqual((r["ok"], r["reason"], r["unknown_numbers"]), (False, "unverified", ["999"]))
        m.reply, m.has_key = None, False

    def test_ask_campus_answer_sources_and_checks(self):
        # «Спросить Кампус»: ответ по фактам недели, источники без модели, сверка чисел, кэш, без данных студента.
        m = self.model
        m.has_key, m.reply, m.calls = False, None, 0
        a = self.anna()
        self.assertEqual(a.call("POST", "/api/ask", {"question": "когда немецкий?"})[1], {"ok": False, "reason": "no_key"})
        m.has_key = True
        nocsrf = Client(self.port); nocsrf.cookie = a.cookie
        self.assertEqual(nocsrf.call("POST", "/api/ask", {"question": "когда немецкий?"})[0], 403)
        self.assertEqual(a.call("POST", "/api/ask", {"question": "   "})[0], 400)
        self.assertEqual(a.call("POST", "/api/ask", {"question": "а" * 121})[0], 400)
        self.assertEqual(m.calls, 0)
        m.reply = "Немецкий в четверг, 12:40, отменён; ближайший — во вторник, 10:30, ауд. 214, корпус А."
        st, r = a.call("POST", "/api/ask", {"question": "Когда немецкий? ответ на anna.b@mail.ru"})
        self.assertEqual(st, 200)
        self.assertTrue(r["ok"]); self.assertFalse(r["cached"])
        self.assertIn("Вопрос: Когда немецкий? ответ на [почта]", m.last_user)
        for secret in ("Белова", "belova", "@", "Орлова", "Кравцов"):  # ни студента, ни преподавателей
            self.assertNotIn(secret, m.last_user)
        self.assertIn('"перенесено_с": "14:10–15:30"', m.last_user)  # перенос в среду виден модели
        src = [(x["kind"], x["date"], x["meta"][:11]) for x in r["sources"]]
        self.assertEqual(src, [("lesson", "2026-11-17", "10:30–11:50"), ("lesson", "2026-11-19", "12:40–14:00")])
        self.assertEqual(r["sources"][1]["status"], "cancelled")
        self.assertTrue(a.call("POST", "/api/ask", {"question": "когда немецкий? ответ на anna.b@mail.ru"})[1]["cached"])  # регистр не важен
        self.assertEqual(m.calls, 1)
        # модель честно говорит, что в данных этого нет
        m.reply = "В данных кабинета этого нет."
        r = a.call("POST", "/api/ask", {"question": "какая завтра погода"})[1]
        self.assertEqual((r["ok"], r["none"], r["sources"]), (True, True, []))
        # выдуманное число — ответ отброшен
        m.reply = "Немецкий перенесли в ауд. 999."
        r = a.call("POST", "/api/ask", {"question": "где немецкий во вторник"})[1]
        self.assertEqual((r["ok"], r["reason"], r["unknown_numbers"]), (False, "unverified", ["999"]))
        m.reply, m.has_key = None, False

    def test_personal_events_crud_isolation_and_export(self):
        a, t = self.anna(), self.timur()
        ev = {"date": "2026-11-17", "start": "18:00", "end": "19:30", "title": "  Английский клуб  ", "note": "ауд. 101"}
        st, r = a.call("POST", "/api/events", ev)
        self.assertEqual(st, 201)
        e = r["event"]
        self.assertEqual((e["title"], e["start"], e["end"]), ("Английский клуб", "18:00", "19:30"))
        # событие приходит вместе с расписанием своего дня
        day = next(d for d in a.call("GET", "/api/schedule?from=2026-11-16&to=2026-11-22")[1]["days"] if d["date"] == "2026-11-17")
        self.assertEqual([x["id"] for x in day["events"]], [e["id"]])
        # проверка полей: шаг 15 минут, конец позже начала, название обязательно
        for bad, field in (({**ev, "start": "18:10"}, "start"), ({**ev, "end": "17:00"}, "end"), ({**ev, "title": "  "}, "title"),
                           ({**ev, "end": "24:15"}, "end"), ({**ev, "date": "2026-13-01"}, "date")):
            st, r = a.call("POST", "/api/events", bad)
            self.assertEqual(st, 400)
            self.assertIn(field, r["fields"])
        # конец дня и перенос: частичное изменение
        st, r = a.call("PATCH", "/api/events/%d" % e["id"], {"date": "2026-11-18", "start": "22:00", "end": "24:00"})
        self.assertEqual((st, r["event"]["date"], r["event"]["end"], r["event"]["title"]), (200, "2026-11-18", "24:00", "Английский клуб"))
        # чужой аккаунт не видит и не меняет событие; без CSRF — отказ
        self.assertEqual(t.call("PATCH", "/api/events/%d" % e["id"], {"title": "x"})[0], 404)
        self.assertEqual(t.call("DELETE", "/api/events/%d" % e["id"])[0], 404)
        self.assertFalse(any(d["events"] for d in t.call("GET", "/api/schedule?from=2026-11-16&to=2026-11-22")[1]["days"]))
        nocsrf = Client(self.port); nocsrf.cookie = a.cookie
        self.assertEqual(nocsrf.call("POST", "/api/events", ev)[0], 403)
        # экспорт выбранного диапазона включает событие; 24:00 — полночь следующего дня (UTC: 21:00)
        st, body, _ = a.call("GET", "/api/schedule.ics?from=2026-11-18&to=2026-11-20", raw=True)
        txt = body.decode()
        self.assertIn("SUMMARY:Английский клуб", txt)
        self.assertIn("DTEND:20261118T210000Z", txt)
        self.assertEqual(a.call("DELETE", "/api/events/%d" % e["id"])[0], 200)
        self.assertEqual(a.call("DELETE", "/api/events/%d" % e["id"])[0], 404)

    def test_week_ai_one_call_for_parallel_requests(self):
        # Пока ответ модели в пути, параллельные открытия сводки ждут его, а не делают новые платные вызовы.
        import time as _t
        from server.ai import WeekBriefAI as _AI
        class Slow(FakeModel):
            def complete(self, system, user):
                _t.sleep(0.3)
                return super().complete(system, user)
        m = Slow(key=True)
        ai = _AI(m)
        uid = self.store.one("SELECT id FROM users WHERE login='belova'")["id"]
        w = self.store.summary_week(uid)
        out = []
        ts = [threading.Thread(target=lambda: out.append(ai.brief(uid, w))) for _ in range(4)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(m.calls, 1)
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual(sum(1 for r in out if not r["cached"]), 1)

    def test_behind_proxy_secure_cookie_and_client_ip(self):
        # Хостинг с TLS за прокси: cookie с Secure, блокировка входа — по настоящему адресу клиента, а не по адресу прокси.
        os.environ["CAMPUS_TRUST_PROXY"] = "1"
        try:
            c = Client(self.port)
            st, _, r = c.call("POST", "/api/auth/login", {"login": "galiev", "password": "kampus-timur"},
                              headers={"X-Forwarded-Proto": "https"}, raw=True)
            self.assertEqual(st, 200)
            self.assertIn("Secure", r.getheader("Set-Cookie"))
            bad = Client(self.port)
            for _ in range(8):
                bad.call("POST", "/api/auth/login", {"login": "galiev", "password": "wrong"}, headers={"X-Forwarded-For": "203.0.113.7"})
            self.assertEqual(bad.call("POST", "/api/auth/login", {"login": "galiev", "password": "kampus-timur"}, headers={"X-Forwarded-For": "203.0.113.7"})[0], 429)
            # другой зритель за тем же прокси входит спокойно
            self.assertEqual(Client(self.port).call("POST", "/api/auth/login", {"login": "galiev", "password": "kampus-timur"}, headers={"X-Forwarded-For": "198.51.100.9"})[0], 200)
        finally:
            os.environ.pop("CAMPUS_TRUST_PROXY", None)
            self.srv.RequestHandlerClass.cfg.login_failures.clear() if hasattr(self.srv.RequestHandlerClass, "cfg") else None
        # без доверенного прокси заголовки не учитываются, Secure нет
        st, _, r = Client(self.port).call("POST", "/api/auth/login", {"login": "belova", "password": "kampus-anna"}, headers={"X-Forwarded-Proto": "https"}, raw=True)
        self.assertNotIn("Secure", r.getheader("Set-Cookie"))

    def test_nothing_from_the_future_and_overdue_by_time(self):
        # Изменение, объявленное в 09:10, в 08:20 ещё не видно: занятие как было, ни в «Нужно сделать», ни в уведомлениях.
        c = self.timur()
        try:
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T08:20"})
            day = c.call("GET", "/api/schedule?from=2026-11-17&to=2026-11-17")[1]["days"][0]
            py = [l for l in day["lessons"] if "Python" in l["subject"]][0]
            self.assertEqual((py["status"], py["change"]), ("normal", None))
            self.assertNotIn("4", py["room"])
            self.assertFalse([l for l in c.call("GET", "/api/today")[1]["changes"] if l["id"] == py["id"]])
            self.assertFalse([n for n in c.call("GET", "/api/notifications")[1]["notifications"] if n["created_at"] > "2026-11-16T08:20"])
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15"})
            py = c.call("GET", "/api/lessons/%d" % py["id"])[1]
            self.assertEqual(py["change"]["kind"], "room")
            # срок 12:40 сегодня в 12:41 — уже просрочен и в сводке недели
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T12:41"})
            t = [t for t in c.call("GET", "/api/summary/week")[1]["tasks"] if t["due_date"] == "2026-11-16"][0]
            self.assertTrue(t["overdue"])
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T12:39"})
            t = [t for t in c.call("GET", "/api/summary/week")[1]["tasks"] if t["due_date"] == "2026-11-16"][0]
            self.assertFalse(t["overdue"])
        finally:
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15"})

    def test_live_script_appears_by_demo_clock(self):
        # «Живой» сценарий: справка о стипендии готовится в 10:17, объявление приходит в 10:23 — не раньше.
        c = self.anna()
        def state(at):
            me = c.call("PATCH", "/api/preferences", {"demo_now": at})[1]["user"]
            reqs = c.call("GET", "/api/requests")[1]
            reqs = reqs["requests"]
            stip = [r for r in reqs if r["type"] == "stipend_cert" and r["demo_example"]][0]
            notes = c.call("GET", "/api/notifications")[1]
            notes = notes["notifications"]
            titles = [n["title"] for n in notes]
            unread = c.call("GET", "/api/session")[1]["unread"]
            return me["next_live_at"], stip, titles, unread
        try:
            nxt, stip, titles, unread0 = state("2026-11-16T10:15")
            self.assertEqual(nxt, "2026-11-16T10:17")
            self.assertEqual(stip["status"], "in_progress")
            self.assertNotIn("Справка о стипендии готова", titles)
            self.assertEqual(c.call("GET", "/api/search?q=" + "%D0%B4%D0%B5%D0%BB%D0%B5%D0%B3%D0%B0%D1%86%D0%B8%D0%B9")[1].get("total", 0), 0)
            nxt, stip, titles, unread = state("2026-11-16T10:17")
            self.assertEqual(nxt, "2026-11-16T10:23")
            self.assertEqual((stip["status"], stip["has_document"], stip["can_cancel"]), ("ready", True, False))
            self.assertIn("Справка о стипендии готова", titles)
            self.assertEqual(unread, unread0 + 1)
            detail = c.call("GET", "/api/requests/%d" % stip["id"])[1]
            detail = detail.get("request", detail)
            self.assertEqual(detail["events"][-1]["status"], "ready")
            nxt, stip, titles, unread = state("2026-11-16T10:23")
            self.assertIsNone(nxt)
            self.assertEqual(titles[0], "Модель ООН: списки делегаций опубликованы")
            self.assertEqual(unread, unread0 + 2)
            # чужой сценарий не виден: у Тимура свои события
            self.assertNotIn("Модель ООН: списки делегаций опубликованы", [n["title"] for n in self.timur().call("GET", "/api/notifications")[1]["notifications"]])
            # демо-время назад — события ещё не наступили; уведомления 08:40 и 09:00 тоже ещё не пришли
            nxt, stip, titles, unread = state("2026-11-16T08:20")
            self.assertEqual((nxt, stip["status"], unread), ("2026-11-16T10:17", "in_progress", unread0 - 2))
            self.assertNotIn("Библиотека 17–18 ноября работает до 16:00", titles)
        finally:
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15"})

    def test_demo_clock_flows_and_scrubs(self):
        # «Время идёт»: демо-часы идут от входа; любую минуту дня можно выбрать; ход можно остановить.
        import datetime as _dt
        st = self.store
        t0 = _dt.datetime(2026, 11, 12, 6, 0, 0, tzinfo=_dt.timezone.utc)
        clock = {"t": t0}
        st.clock, st.frozen = (lambda: clock["t"]), False
        try:
            c = self.timur()  # вход ставит часы на выбранный демо-момент
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15"})
            me = c.call("GET", "/api/session")[1]["user"]
            self.assertEqual((me["demo_now"], me["time_flow"], me["clock_running"]), ("2026-11-16T10:15", True, True))
            clock["t"] = t0 + _dt.timedelta(minutes=6, seconds=30)
            me = c.call("GET", "/api/session")[1]["user"]
            self.assertEqual((me["demo_now"], me["demo_clock"]), ("2026-11-16T10:21", "2026-11-16T10:21:30"))
            self.assertEqual(c.call("GET", "/api/today")[1]["now"], "2026-11-16T10:21")
            # ползунок: любая минута в пределах демо-периода, за пределами — 400
            self.assertEqual(c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T13:05"})[1]["user"]["demo_now"], "2026-11-16T13:05")
            self.assertEqual(c.call("PATCH", "/api/preferences", {"demo_now": "2027-03-01T10:00"})[0], 400)
            self.assertEqual(c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T25:00"})[0], 400)
            # стоп: часы замирают на текущем значении
            clock["t"] += _dt.timedelta(minutes=10)
            r = c.call("PATCH", "/api/preferences", {"time_flow": False})[1]["user"]
            self.assertEqual((r["demo_now"], r["clock_running"]), ("2026-11-16T13:15", False))
            clock["t"] += _dt.timedelta(hours=1)
            self.assertEqual(c.call("GET", "/api/session")[1]["user"]["demo_now"], "2026-11-16T13:15")
            # «Прокрутить день»: часы идут быстрее; новый вход возвращает обычную скорость
            r = c.call("PATCH", "/api/preferences", {"time_flow": True, "demo_now": "2026-11-16T08:00", "clock_speed": 1000})[1]["user"]
            self.assertEqual((r["clock_speed"], r["demo_now"]), (1000, "2026-11-16T08:00"))
            clock["t"] += _dt.timedelta(seconds=36)
            self.assertEqual(c.call("GET", "/api/session")[1]["user"]["demo_now"], "2026-11-16T18:00")
            self.assertEqual(c.call("PATCH", "/api/preferences", {"clock_speed": 5000})[0], 400)
            self.assertEqual(c.call("PATCH", "/api/preferences", {"clock_speed": True})[0], 400)
            r = c.call("PATCH", "/api/preferences", {"clock_speed": 1})[1]["user"]
            self.assertEqual((r["clock_speed"], r["demo_now"]), (1, "2026-11-16T18:00"))
            c.call("PATCH", "/api/preferences", {"clock_speed": 900})
            c2 = self.timur()
            self.assertEqual(c2.call("GET", "/api/session")[1]["user"]["clock_speed"], 1)
            c = c2
            # не дальше конца дня
            c.call("PATCH", "/api/preferences", {"time_flow": True, "demo_now": "2026-11-16T23:50"})
            clock["t"] += _dt.timedelta(hours=3)
            self.assertEqual(c.call("GET", "/api/session")[1]["user"]["demo_now"], "2026-11-16T23:59")
        finally:
            st.frozen = True
            st.clock = lambda: _dt.datetime.now(_dt.timezone.utc)
            c.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15"})

    def test_search_counts_honestly(self):
        c = self.anna()
        r = c.call("GET", "/api/search?q=%D0%BF%D1%80%D0%B0%D0%B2%D0%BE")[1]  # «право»
        self.assertEqual(r["total"], sum(g["total"] for g in r["groups"]))
        self.assertTrue(any(g["total"] > len(g["items"]) for g in r["groups"]) or r["total"] <= 6 * len(r["groups"]))
        self.assertEqual(c.call("GET", "/api/search?q=zzzz-nothing")[1]["total"], 0)

    def test_keepalive_body_is_always_consumed(self):
        c = self.anna()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Content-Type": "application/json", "Cookie": c.cookie, "X-CSRF-Token": c.csrf}
        rid = self._new(c, "key-keepalive-01")[1]["request"]["id"]
        conn.request("POST", "/api/requests/%d/cancel" % rid, json.dumps({}), h)
        self.assertEqual(conn.getresponse().read() and 200, 200)
        conn.request("GET", "/api/requests", headers=h)  # то же соединение
        r = conn.getresponse()
        r.read()
        self.assertEqual(r.status, 200)
        conn.close()

    # --------------------------------------------------------- summary
    def test_summary_since_last_visit(self):
        c = self.anna()
        c.call("POST", "/api/summary/seen", {"at": "2026-11-14T12:00"})  # сброс к демо-визиту
        s = c.call("GET", "/api/summary")[1]
        g = s["groups"]
        self.assertEqual(s["since"], "2026-11-14T12:00")
        self.assertEqual(len(g["schedule"]), 3)
        self.assertEqual([d["status"] for d in g["documents"]], ["answered"])
        self.assertEqual(len(g["deadlines"]), 1)
        self.assertEqual(len(g["announcements"]), 1)
        self.assertEqual(s["total"], 6)
        # изменения не дублируются уведомлениями о них
        self.assertFalse(any(it.get("notification", {}).get("category") == "schedule" for v in g.values() for it in v))

    def test_summary_seen_and_undo(self):
        c = self.anna()
        c.call("POST", "/api/summary/seen", {"at": "2026-11-14T12:00"})
        st, b = c.call("POST", "/api/summary/seen", {})
        self.assertEqual((st, b["last_visit"], b["previous"]), (200, "2026-11-16T10:15", "2026-11-14T12:00"))
        self.assertEqual(c.call("GET", "/api/summary")[1]["total"], 0)
        c.call("POST", "/api/summary/seen", {"at": b["previous"]})  # «Вернуть»
        self.assertEqual(c.call("GET", "/api/summary")[1]["total"], 6)
        self.assertEqual(c.call("POST", "/api/summary/seen", {"at": "2026-12-01T10:00"})[0], 400)  # не позже «сейчас»
        self.assertEqual(c.call("POST", "/api/summary/seen", {"at": "вчера"})[0], 400)

    def test_summary_respects_demo_now_and_isolation(self):
        a, t = self.anna(), self.timur()
        a.call("POST", "/api/summary/seen", {"at": "2026-11-14T12:00"})
        a.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T08:20"})
        titles = [it["lesson"]["subject"] for it in a.call("GET", "/api/summary")[1]["groups"]["schedule"]]
        self.assertEqual(len(titles), 2)  # изменение, объявленное в 08:40, ещё «в будущем»
        a.call("PATCH", "/api/preferences", {"demo_now": "2026-11-16T10:15"})
        t.call("POST", "/api/summary/seen", {})  # Тимур отметил своё — у Анны не меняется
        self.assertEqual(a.call("GET", "/api/summary")[1]["total"], 6)
        ts = t.call("GET", "/api/summary/week")[1]
        self.assertFalse(any("право" in (d["first"] or {}).get("subject", "").lower() for d in ts["days"]))

    def test_summary_week(self):
        w = self.anna().call("GET", "/api/summary/week")[1]
        self.assertEqual((w["from"], w["to"]), ("2026-11-16", "2026-11-22"))
        self.assertEqual(w["lessons_total"], 14)
        self.assertEqual([d["state"] for d in w["days"]][-2:], ["free", "free"])
        self.assertEqual(w["days"][0]["first"]["start"], "09:00")
        self.assertTrue(w["next_exam"])
        self.assertTrue(any(t["overdue"] for t in w["tasks"]))
        self.assertEqual(self.anna().call("GET", "/api/summary/week")[0], 200)

    # -------------------------------------------------------- calendar
    def _raw(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", path)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, data.decode("utf-8", "replace"), r

    def test_calendar_subscription_feed(self):
        a, t = self.anna(), self.timur()
        self.assertIsNone(a.call("GET", "/api/calendar")[1]["token"])
        tok = a.call("POST", "/api/calendar/token", {})[1]["token"]
        self.assertGreaterEqual(len(tok), 20)
        st, body, r = self._raw("/cal/%s.ics" % tok)  # без cookie
        self.assertEqual(st, 200)
        self.assertIn("text/calendar", r.getheader("Content-Type"))
        self.assertIn("X-WR-CALNAME:Кампус — Анна Белова", body)
        self.assertIn("REFRESH-INTERVAL;VALUE=DURATION:PT1H", body)
        self.assertEqual(body.count("BEGIN:VEVENT"), 30 + 7)  # 2 опубликованные недели + 7 событий сессии
        self.assertIn("STATUS:CANCELLED", body)
        self.assertIn("SEQUENCE:1", body)
        self.assertNotIn("Эконометрика", body)  # только данные владельца ссылки
        tt = t.call("POST", "/api/calendar/token", {})[1]["token"]
        self.assertIn("Эконометрика", self._raw("/cal/%s.ics" % tt)[1])
        # перевыпуск: старая ссылка перестаёт работать
        tok2 = a.call("POST", "/api/calendar/token", {})[1]["token"]
        self.assertNotEqual(tok, tok2)
        self.assertEqual(self._raw("/cal/%s.ics" % tok)[0], 404)
        self.assertEqual(self._raw("/cal/%s.ics" % tok2)[0], 200)
        a.call("DELETE", "/api/calendar/token", {})
        self.assertEqual(self._raw("/cal/%s.ics" % tok2)[0], 404)
        self.assertEqual(self._raw("/cal/" + "x" * 30 + ".ics")[0], 404)
        self.assertEqual(Client(self.port).call("POST", "/api/calendar/token", {})[0], 401)

    def test_offline_shell_manifest(self):
        st, body, r = self._raw("/asset-manifest.json")
        files = json.loads(body)["files"]
        self.assertIn("/src/main.js", files)
        self.assertIn("/manifest.webmanifest", files)
        self.assertNotIn("/sw.js", files)
        self.assertEqual(r.getheader("Cache-Control"), "no-store")
        st, body, r = self._raw("/sw.js")
        self.assertEqual((st, r.getheader("Cache-Control")), (200, "no-cache"))
        self.assertIn("javascript", r.getheader("Content-Type"))
        st, body, r = self._raw("/manifest.webmanifest")
        self.assertEqual(json.loads(body)["short_name"], "Кампус")

    def test_static_revalidates_with_etag(self):
        # Без сборки и хэшей в именах: браузер сверяется каждый раз, неизменённый файл — 304 без тела.
        c = Client(self.port)
        st, data, r = c.call("GET", "/assets/app.css", raw=True)
        etag = r.getheader("ETag")
        self.assertEqual((st, r.getheader("Cache-Control")), (200, "no-cache"))
        self.assertTrue(etag and len(data) > 1000)
        st, data, r = c.call("GET", "/assets/app.css", headers={"If-None-Match": etag}, raw=True)
        self.assertEqual((st, data), (304, b""))
        self.assertEqual(c.call("GET", "/assets/app.css", headers={"If-None-Match": '"stale"'}, raw=True)[0], 200)

    def test_static_spa_fallback_and_csp(self):
        st, data, r = Client(self.port).call("GET", "/schedule/lesson/5", raw=True)
        self.assertEqual(st, 200)
        self.assertIn("script-src 'self'", r.getheader("Content-Security-Policy"))
        self.assertEqual(Client(self.port).call("GET", "/src/missing.js", raw=True)[0], 404)
        self.assertEqual(Client(self.port).call("GET", "/../server/app.py", raw=True)[0], 200)  # отдаёт index, не исходник
        self.assertNotIn(b"ThreadingHTTPServer", Client(self.port).call("GET", "/../server/app.py", raw=True)[1])


if __name__ == "__main__":
    unittest.main()
