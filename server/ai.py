"""Сводка недели одним абзацем через языковую модель (DeepSeek, OpenAI-совместимый API).

Принципы:
- ключ живёт только на сервере: переменная окружения DEEPSEEK_API_KEY или файл .secrets/deepseek.key
  (каталог в .gitignore); в браузер не уходит ни ключ, ни сам факт его значения;
- адрес API и имя модели — DEEPSEEK_BASE_URL / DEEPSEEK_MODEL или .secrets/llm.json
  (по умолчанию официальный https://api.deepseek.com и deepseek-v4-flash);
- в модель уходят только факты недели (пары, изменения, сроки, документы) — без ФИО, логина, почты и телефона;
- модель только пересказывает: каждое число в ответе (время, аудитория, дата) обязано быть в фактах,
  иначе ответ отбрасывается и интерфейс показывает шаблонную сводку;
- одинаковые факты — один платный вызов (кэш по хэшу), плюс ограничение частоты на аккаунт.
Без ключа модуль просто сообщает «недоступно» — кабинет работает на шаблонах (web/src/brief.js).
"""

import datetime as dt
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_FILE = os.path.join(ROOT, ".secrets", "deepseek.key")
CONF_FILE = os.path.join(ROOT, ".secrets", "llm.json")  # необязательно: {"base_url": ..., "model": ...} — для посредников
WD = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
WD_FULL = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]

SYSTEM = """Ты пишешь короткую сводку учебной недели для студента в его личном кабинете — как внимательный одногруппник.
Правила:
- по-русски, 2–3 коротких живых предложения, не больше 55 слов, одним абзацем;
- без приветствия, обращения, эмодзи, списков и разметки;
- только факты из JSON пользователя; ничего не добавляй, не предполагай и не советуй;
- сначала все изменения в расписании (до трёх, каждое коротко: что, когда, как стало), затем, если остаётся место, ближайший срок и готовый документ;
- дни называй словами: «сегодня» для дня из поля «сегодня», иначе «в понедельник», «во вторник», «в среду» по полю «день»; дату числом пиши, только если событие не на этой неделе;
- длинные названия предметов можно сокращать до привычных («международное право», «немецкий»), но время, аудитории и корпуса переписывай ровно как в данных;
- если изменение не подтверждено, можно добавить «стоит подтвердить» — один раз на всю сводку."""


def _date(d):
    x = dt.date.fromisoformat(d)
    return {"день": WD_FULL[x.weekday()], "дата": "%d %s" % (x.day, MONTHS[x.month - 1])}


def _room(room, building):
    if not room:
        return ""
    r = "ауд. %s" % room if room[:1].isdigit() else room
    return r + (", корпус %s" % building if building else "")


def week_facts(w):
    """Компактные факты недели из store.summary_week — всё, что модели можно знать."""
    days = []
    for d in w["days"]:
        item = _date(d["date"])
        if d["state"] == "no_data":
            item["расписание"] = "не опубликовано"
        elif not d["count"]:
            item["пар"] = 0
        else:
            item.update({"пар": d["count"], "с": d["first"]["start"], "до": d["last_end"]})
        if d["cancelled"]:
            item["отменено"] = d["cancelled"]
        days.append(item)
    changes = []
    for l in w["changes"]:
        c = l["change"]
        if c["kind"] == "cancelled":
            what = "занятие отменено"
        elif c["kind"] == "room":
            what = "аудитория: %s → %s" % (_room(c["old"]["room"], c["old"]["building"]), _room(l["room"], l["building"]))
        elif c["kind"] == "time":
            what = "время: %s–%s → %s–%s" % (c["old"]["start"], c["old"]["end"], l["start"], l["end"])
        else:
            what = "время и место: %s, %s → %s, %s" % (c["old"]["start"], _room(c["old"]["room"], c["old"]["building"]), l["start"], _room(l["room"], l["building"]))
        ch = dict(_date(l["date"]), предмет=l["subject"], изменение=what, подтверждено=bool(c["acknowledged_at"]))
        if c.get("reason"):
            ch["причина"] = c["reason"]
        changes.append(ch)
    tasks = []
    for t in w["tasks"]:
        it = dict(_date(t["due_date"]), что=t["title"])
        if t["due_time"]:
            it["до"] = t["due_time"]
        if t["overdue"]:
            it["срок_прошёл"] = True
        tasks.append(it)
    facts = {"неделя": "%s — %s" % (_date(w["from"])["дата"], _date(w["to"])["дата"]),
             "сегодня": "%s, %s" % (_date(w["from"])["день"], _date(w["from"])["дата"]),
             "пар_за_неделю": w["lessons_total"], "дни": days, "изменения": changes, "сроки": tasks,
             "документы_готовы": [r["type_label"] for r in w["documents_ready"]],
             "заявок_в_работе": w["requests_open"]}
    if w.get("next_exam"):
        e = w["next_exam"]
        facts["ближайшее_в_сессии"] = dict(_date(e["date"]), что="%s «%s»" % (e["kind"], e["subject"]), время=e["start"])
    return facts


ASK_SYSTEM = """Ты отвечаешь студенту на вопрос о его учебной неделе в личном кабинете «Кампус».
Правила:
- по-русски, одно-два коротких предложения, не больше 40 слов; без приветствия, эмодзи, списков и разметки;
- отвечай только по JSON с фактами недели; ничего не придумывай, не советуй и не обещай;
- если ответа в фактах нет (другая неделя, оценки, преподаватели, что-то вне учёбы), ответь ровно: «В данных кабинета этого нет.»;
- дни называй словами: «сегодня» для дня из поля «сегодня», иначе «в понедельник», «во вторник» и т. д.;
- время, аудитории и корпуса переписывай ровно как в данных; для отменённой пары так и скажи, что отменена;
- если у пары есть неподтверждённое изменение, можно добавить «стоит подтвердить»."""

NONE_ANSWER = "В данных кабинета этого нет."


def ask_facts(w, sched):
    """Факты для вопроса: пары по дням (время, предмет, вид, место, изменения), сроки, документы, сессия.
    Без преподавателей и без данных студента — только расписание и дела."""
    base = week_facts(w)
    days = []
    for d in sched["days"]:
        item = _date(d["date"])
        if d["state"] == "no_data":
            item["расписание"] = "не опубликовано"
        else:
            lessons = []
            for l in d["lessons"]:
                it = {"время": "%s–%s" % (l["start"], l["end"]), "предмет": l["subject"], "вид": l["kind"], "где": _room(l["room"], l["building"])}
                c = l.get("change")
                if l["status"] == "cancelled":
                    it["отменено"] = True
                elif c:
                    if c["kind"] in ("time", "room_time"):
                        it["перенесено_с"] = "%s–%s" % (c["old"]["start"], c["old"]["end"])
                    if c["kind"] in ("room", "room_time"):
                        it["прежнее_место"] = _room(c["old"]["room"], c["old"]["building"])
                if c:
                    it["изменение_подтверждено"] = bool(c["acknowledged_at"])
                lessons.append(it)
            item["пары"] = lessons
        days.append(item)
    out = {"сегодня": base["сегодня"], "сейчас": w["now"][11:16], "дни": days, "сроки": base["сроки"],
           "документы_готовы": base["документы_готовы"], "заявок_в_работе": base["заявок_в_работе"]}
    if "ближайшее_в_сессии" in base:
        out["ближайшее_в_сессии"] = base["ближайшее_в_сессии"]
    return out


def clean_question(q):
    """Вопрос в модель: одна строка, до 120 символов, без почты и телефонов (вдруг вставили)."""
    q = re.sub(r"\s+", " ", (q or "")).strip()[:120]
    q = re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "[почта]", q)
    q = re.sub(r"\+?\d[\d\s()-]{8,}\d", "[телефон]", q)
    return q


def _stems(text):
    return {wd[:5] for wd in re.findall(r"[а-яёa-z]{5,}", text.lower())}


def find_sources(text, sched, tasks):
    """Источники ответа — без модели: пары и сроки, которые упомянуты в ответе (предмет + время или день)."""
    low = text.lower()
    st = _stems(text)
    out = []
    for d in sched["days"]:
        x = dt.date.fromisoformat(d["date"])
        day_hit = WD_FULL[x.weekday()][:4] in low or ("сегодня" in low and d["date"] == sched["from"])
        for l in d["lessons"]:
            subj = _stems(l["subject"]) - {"основ", "язык"}
            hit = len(subj & st)
            if not hit:
                continue
            if l["start"] in text or (day_hit and hit >= min(2, len(subj))):
                out.append({"kind": "lesson", "id": l["id"], "date": l["date"], "title": l["subject"],
                            "meta": "%s–%s · %s" % (l["start"], l["end"], _room(l["room"], l["building"])), "status": l["status"]})
    for t in tasks:
        if len(_stems(t["title"]) & st) >= 2:
            out.append({"kind": "task", "id": t["id"], "date": t["due_date"], "title": t["title"], "meta": "срок"})
    return out[:3]


NUM = re.compile(r"\d+")


def check(text, facts):
    """Ответ годится, только если каждое число в нём есть в фактах (время, аудитория, дата, количество)."""
    src = json.dumps(facts, ensure_ascii=False)
    allowed = set(NUM.findall(src)) | {str(i) for i in range(0, 8)}  # «2 пары», «3 изменения» — малые количества
    bad = [n for n in NUM.findall(text) if n not in allowed]
    return not bad, bad


def clean(text):
    t = re.sub(r"[*_#`>]+", "", text or "").strip()
    t = re.sub(r"\s*\n+\s*", " ", t)
    return re.sub(r"\s{2,}", " ", t)


class DeepSeek:
    """Клиент chat/completions. Ключ читается при каждом вызове — его можно положить без перезапуска сервера."""

    def __init__(self, base=None, model=None, timeout=25):
        conf = {}
        if os.path.exists(CONF_FILE):
            try:
                with open(CONF_FILE, encoding="utf-8") as f:
                    conf = json.load(f)
            except (OSError, ValueError):
                conf = {}
        self.base = (base or os.environ.get("DEEPSEEK_BASE_URL") or conf.get("base_url") or "https://api.deepseek.com").rstrip("/")
        self.model = model or os.environ.get("DEEPSEEK_MODEL") or conf.get("model") or "deepseek-v4-flash"
        self.timeout = timeout

    def key(self):
        k = os.environ.get("DEEPSEEK_API_KEY")
        if not k and os.path.exists(KEY_FILE):
            with open(KEY_FILE, encoding="utf-8") as f:
                k = f.read().strip()
        return k or None

    def available(self):
        return bool(self.key())

    def _post(self, body):
        # Своя подпись клиента: посредники за Cloudflare отклоняют стандартный «Python-urllib».
        req = urllib.request.Request(self.base + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.key(),
                                              "User-Agent": "Kampus/1.0 (student portal demo)"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def complete(self, system, user):
        body = {"model": self.model, "temperature": 0.3, "max_tokens": 400, "stream": False,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                # Пересказ фактов не требует «размышлений»: без них ответ быстрее, а лимит не уходит на рассуждения.
                "thinking": {"type": "disabled"}}
        try:
            data = self._post(body)
        except urllib.error.HTTPError as e:
            if e.code != 400:
                raise
            body.pop("thinking")  # API без этого параметра — повторяем без него
            body["max_tokens"] = 1500
            data = self._post(body)
        return data["choices"][0]["message"].get("content") or "", data.get("model") or self.model


class WeekBriefAI:
    def __init__(self, client=None, per_window=8, window=600):
        self.client = client or DeepSeek()
        self.cache = {}
        self.calls = {}
        self.per_window, self.window = per_window, window
        self.lock = threading.Lock()
        self.inflight = {}

    def available(self):
        return self.client.available()

    def brief(self, uid, w):
        if not self.available():
            return {"ok": False, "reason": "no_key"}
        facts = week_facts(w)
        payload = json.dumps(facts, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(payload.encode()).hexdigest()
        return self._guarded((uid, h), uid, lambda: self._ask(facts, payload))

    def answer(self, uid, question, w, sched):
        """Ответ на вопрос о неделе: те же правила, что у сводки (только факты, сверка чисел, кэш, лимит)."""
        if not self.available():
            return {"ok": False, "reason": "no_key"}
        q = clean_question(question)
        if len(q) < 2:
            return {"ok": False, "reason": "empty"}
        facts = ask_facts(w, sched)
        payload = json.dumps(facts, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256((payload + "\n" + q.lower()).encode()).hexdigest()

        def run():
            try:
                raw, model = self.client.complete(ASK_SYSTEM, "Факты недели (JSON):\n" + payload + "\n\nВопрос: " + q)
            except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError) as e:
                return {"ok": False, "reason": "auth" if getattr(e, "code", None) in (401, 403) else "upstream"}
            text = clean(raw)
            if text.rstrip(".").strip("«»\" ") == NONE_ANSWER.rstrip("."):
                return {"ok": True, "text": NONE_ANSWER, "none": True, "model": model, "sources": []}
            ok, bad = check(text, facts)
            if not text or len(text) > 400 or not ok:
                return {"ok": False, "reason": "unverified", "unknown_numbers": bad[:5]}
            return {"ok": True, "text": text, "model": model, "sources": find_sources(text, dict(sched, **{"from": w["from"]}), w["tasks"])}
        # свой лимит у вопросов (10 за 10 минут), чтобы они не съедали сводку недели
        return self._guarded(("ask", uid, h), ("ask", uid), run, limit=10)

    def _guarded(self, key, bucket, compute, limit=None):
        # Один платный вызов на одни и те же факты: пока ответ в пути, остальные запросы ждут его, а не зовут модель снова.
        with self.lock:
            if key in self.cache:
                return dict(self.cache[key], cached=True)
            waiting = self.inflight.get(key)
            if waiting is None:
                now = time.time()
                recent = [t for t in self.calls.get(bucket, []) if now - t < self.window]
                if len(recent) >= (limit or self.per_window):
                    return {"ok": False, "reason": "rate_limited"}
                self.calls[bucket] = recent + [now]
                self.inflight[key] = threading.Event()
        if waiting is not None:
            waiting.wait(timeout=self.client.timeout + 5 if hasattr(self.client, "timeout") else 30)
            with self.lock:
                if key in self.cache:
                    return dict(self.cache[key], cached=True)
            return {"ok": False, "reason": "upstream"}
        try:
            res = compute()
            if res.get("ok"):
                with self.lock:
                    self.cache[key] = res
            return dict(res, cached=False) if res.get("ok") else res
        finally:
            with self.lock:
                ev = self.inflight.pop(key, None)
            if ev:
                ev.set()

    def _ask(self, facts, payload):
        try:
            raw, model = self.client.complete(SYSTEM, "Факты недели (JSON):\n" + payload)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError) as e:
            code = getattr(e, "code", None)
            return {"ok": False, "reason": "auth" if code in (401, 403) else "upstream"}
        text = clean(raw)
        ok, bad = check(text, facts)
        if not text or len(text) > 700 or not ok:
            return {"ok": False, "reason": "unverified", "unknown_numbers": bad[:5]}
        return {"ok": True, "text": text, "model": model}

    def prewarm(self, uid, summary_week):
        """Прогрев в фоне (после входа, смены демо-времени): к клику по «Сводке недели» абзац уже в кэше."""
        if not self.available():
            return
        def run():
            try:
                self.brief(uid, summary_week(uid))
            except Exception:  # noqa: BLE001 — прогрев не должен ронять сервер
                pass
        threading.Thread(target=run, daemon=True).start()
