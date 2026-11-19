// Общий поиск (⌘K / Ctrl+K / «/»): разделы, действия и объекты аккаунта. Честный счётчик.
import { html, useEffect, useLayoutEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Icon } from "./icons.js";
import { navigate } from "./router.js";
import { api, state, applyTheme } from "./data.js";
import { download, setPreferences } from "./actions.js";
import { startTour } from "./tour.js";
import { mondayOf, addDays, shortDate, countOf } from "./format.js";
import { Spark } from "./spark.js";
import { Presence, reduced } from "./motion.js";
import { Typed } from "./views/summary.js";

// «Спросить Кампус»: вопрос обычным языком → ответ модели по фактам недели (сервер сверяет числа) и строки-источники.
const QUESTION = /\?\s*$|^(когда|где|что|чем|какая|какой|какие|каким|какую|сколько|есть ли|во сколько|кто|почему|зачем|надо ли|нужно ли|будет ли|можно ли|успею ли)(\s|$)/i;
const ASK_NOTE = {
  unverified: "Ответ модели не прошёл проверку фактов и не показан — попробуйте спросить иначе",
  upstream: "Модель сейчас недоступна — попробуйте позже",
  auth: "Ключ модели не принят",
  rate_limited: "Слишком много вопросов подряд — подождите несколько минут",
  network: "Нет связи с сервером",
  no_key: "Модель не подключена",
};

function staticItems() {
  const today = state.session.user.demo_now.slice(0, 10);
  const mon = mondayOf(today);
  const go = (href, overlay) => () => navigate(href, { state: overlay ? { overlay: true } : {} });
  const theme = (t) => async () => { applyTheme(t); try { await setPreferences({ theme: t }); } catch (e) { /* применено локально */ } };
  return [
    { group: "Разделы", icon: "today", title: "Сегодня", kw: "главная пары день", run: go("/") },
    { group: "Разделы", icon: "calendar", title: "Расписание", kw: "неделя пары", run: go("/schedule") },
    { group: "Разделы", icon: "grades", title: "Оценки и сессия", kw: "баллы успеваемость экзамены зачёты", run: go("/grades") },
    { group: "Разделы", icon: "doc", title: "Документы", kw: "заявки справки обращения", run: go("/documents") },
    { group: "Разделы", icon: "bell", title: "Уведомления", kw: "сообщения входящие", run: go("/notifications") },
    { group: "Разделы", icon: "user", title: "Профиль и настройки", kw: "тема демо-время аккаунт", run: go("/profile") },
    { group: "Действия", icon: "book", title: "Заказать справку об обучении", kw: "документ заявка", run: go("/documents/new/study_cert", true) },
    { group: "Действия", icon: "coin", title: "Заказать справку о стипендии", kw: "документ заявка", run: go("/documents/new/stipend_cert", true) },
    { group: "Действия", icon: "message", title: "Написать обращение в деканат", kw: "заявка вопрос", run: go("/documents/new/dean_appeal", true) },
    { group: "Действия", icon: "summary", title: "Сводка недели", kw: "итоги кратко неделя summary что изменилось", run: go("/summary/week", true) },
    { group: "Действия", icon: "refresh", title: "Подписка на календарь", kw: "календарь ics webcal google apple outlook синхронизация", run: go("/profile#calendar") },
    { group: "Действия", icon: "calExport", title: "Экспорт текущей недели в календарь", meta: ".ics", kw: "ics расписание", run: () => download(`/api/schedule.ics?from=${mon}&to=${addDays(mon, 6)}`) },
    { group: "Действия", icon: "calExport", title: "Сессия в календарь", meta: ".ics", kw: "ics экзамены", run: () => download("/api/exams.ics") },
    { group: "Действия", icon: "download", title: "Скачать баллы", meta: ".csv", kw: "csv оценки успеваемость", run: () => download("/api/grades.csv") },
    { group: "Действия", icon: "alert", title: "Дисциплины, требующие внимания", kw: "оценки долги", run: go("/grades?filter=attention") },
    { group: "Действия", icon: "info", title: "Как устроен Кампус", meta: "знакомство", kw: "тур обучение подсказки помощь справка как пользоваться онбординг", run: startTour },
    { group: "Действия", icon: "sun", title: "Тема: светлая", kw: "оформление", run: theme("light") },
    { group: "Действия", icon: "moon", title: "Тема: тёмная", kw: "оформление", run: theme("dark") },
    { group: "Действия", icon: "system", title: "Тема: как в системе", kw: "оформление", run: theme("system") },
  ];
}

const GROUP_ICON = { subjects: "grades", lessons: "calendar", requests: "doc", notifications: "bell", exams: "grades" };
function serverHref(key, it) {
  if (key === "subjects") return [`/grades/subject/${it.id}`, true];
  if (key === "lessons") return [`/schedule/lesson/${it.id}?view=day&date=${it.date}`, true];
  if (key === "requests") return [`/documents/${it.id}`, true];
  if (key === "notifications") return [`/notifications?id=${it.id}`, false];
  return ["/grades?tab=session", false];
}

// Ответ в палитре. Ответ модели выше заглушки — блок дорастает до него, а не прыгает.
function AskBlock({ a, srcRows, item }) {
  const pending = !a.res, ok = a.res && a.res.ok;
  const ref = useRef(null), lastH = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (lastH.current && Math.abs(h - lastH.current) > 1 && !reduced()) {
      el.style.overflow = "hidden";
      el.animate([{ height: lastH.current + "px" }, { height: h + "px" }], { duration: 280, easing: "cubic-bezier(.23,1,.32,1)" })
        .finished.then(() => { el.style.overflow = ""; }, () => {});
    }
    lastH.current = h;
  }, [pending, ok, srcRows.length]);
  return html`<section class="pal-ask" ref=${ref} aria-label="Ответ Кампуса" aria-busy=${pending ? "true" : "false"}>
    <div class="pal-ask-head"><${Spark} size=${16} busy=${pending} /><span class="pal-ask-q">${a.q}</span><span class="ai-chip">AI</span></div>
    <div aria-live="polite">${pending
      ? html`<div class="ai-wait" role="status"><span class="sr-only">Кампус отвечает…</span><i style="width:92%"></i><i style="width:58%"></i></div>`
      : ok ? html`<${Typed} key=${a.res.text} text=${a.res.text} />`
      : html`<p class="pal-ask-fail">${ASK_NOTE[a.res.reason] || "Не получилось ответить"}</p>`}</div>
    ${srcRows.length > 0 && html`<div role="group" aria-label="Источники">${srcRows.map(item)}</div>`}
    <p class="ai-src">${pending ? "Модель отвечает по данным недели…" : ok ? (a.res.none ? "Отвечаю только по расписанию, срокам и документам этой недели" : `${a.res.model} по данным недели · числа сверены с расписанием`) : "Ответ не показан"}</p>
  </section>`;
}

function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return html`${text.slice(0, i)}<mark>${text.slice(i, i + q.length)}</mark>${text.slice(i + q.length)}`;
}

export function Palette({ onClose: done }) {
  const [closing, setClosing] = useState(false);
  const onClose = () => { if (closing) return; setClosing(true); setTimeout(done, 120); };
  const [q, setQ] = useState("");
  const [server, setServer] = useState({ groups: [], total: 0 });
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const listRef = useRef(null);
  const items = useRef(staticItems());
  const aiOn = !!(state.session.meta && state.session.meta.ai);
  const [ask, setAsk] = useState(null); // { q, res } — res: null, пока модель отвечает
  const lastAsk = useRef(null);
  const returnTo = useRef(document.activeElement);

  useLayoutEffect(() => {
    input.current.focus();
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; const r = returnTo.current; if (r && document.contains(r) && (document.activeElement === document.body || !document.activeElement)) r.focus(); };
  }, []);

  useEffect(() => {
    const query = q.trim();
    setActive(0);
    if (query.length < 2) { setServer({ groups: [], total: 0, q: query }); setStatus("idle"); return; }
    setStatus("loading");
    const t = setTimeout(async () => {
      try { const r = await api("GET", `/api/search?q=${encodeURIComponent(query)}`, undefined, { quiet: true }); setServer({ ...r, q: query }); setStatus("idle"); }
      catch (e) { setStatus("error"); setServer({ groups: [], total: 0, q: query }); }
    }, 140);
    return () => clearTimeout(t);
  }, [q]);

  const qq = q.trim();
  const askShown = ask && ask.q === qq ? ask : null;
  if (askShown) lastAsk.current = askShown;
  const startAsk = async (question) => {
    setAsk({ q: question, res: null });
    setActive(0);
    const put = (res) => setAsk((a) => (a && a.q === question ? { q: question, res } : a));
    try { put(await api("POST", "/api/ask", { question }, { quiet: true })); }
    catch (e) { put({ ok: false, reason: e.network ? "network" : e.status === 400 ? "invalid" : "upstream" }); }
  };
  const query = q.trim().toLowerCase();
  const local = items.current.filter((it) => !query || (it.title + " " + (it.kw || "")).toLowerCase().includes(query));
  const shownLocal = query ? local : local.filter((it) => it.group === "Разделы" || /Сводка|Заказать|Написать|Экспорт/.test(it.title));
  const rows = [];
  const groups = [];
  // источники ответа — первые строки: ↵ открывает упомянутую пару или срок
  const srcRows = (askShown && askShown.res && askShown.res.ok ? askShown.res.sources || [] : []).map((s) => {
    const row = { icon: s.kind === "lesson" ? "calendar" : "clock", title: s.title, meta: `${shortDate(s.date)} · ${s.meta}`, status: s.status,
      run: () => (s.kind === "lesson" ? navigate(`/schedule/lesson/${s.id}?view=day&date=${s.date}`, { state: { overlay: true } }) : navigate(`/?task=${s.id}`)) };
    return { ...row, idx: rows.push(row) - 1 };
  });
  // не похоже на вопрос — строка «Спросить» встаёт последней и только после результатов поиска (Enter не уходит в модель раньше)
  const looksQuestion = QUESTION.test(qq);
  const askRow = aiOn && qq.length >= 3 && !askShown && (looksQuestion || (server.q === qq && status !== "loading"))
    ? { ai: true, keep: true, title: `Спросить Кампус: «${qq}»`, meta: "ответ по расписанию, срокам и документам недели", run: () => startAsk(qq) } : null;
  const askFirst = askRow && looksQuestion;
  if (askFirst) groups.push({ label: "Спросить", total: 1, items: [{ ...askRow, idx: rows.push(askRow) - 1 }] });
  ["Разделы", "Действия"].forEach((g) => {
    const its = shownLocal.filter((it) => it.group === g);
    if (its.length) groups.push({ label: g, total: its.length, items: its.map((it) => ({ ...it, idx: rows.push(it) - 1 })) });
  });
  server.groups.forEach((g) => {
    groups.push({
      label: g.label, total: g.total, items: g.items.map((it) => {
        const [href, overlay] = serverHref(g.key, it);
        const row = { icon: GROUP_ICON[g.key], title: it.title, meta: (it.date && (g.key === "lessons" || g.key === "exams") ? shortDate(it.date) + " · " : "") + it.meta, run: () => navigate(href, { state: overlay ? { overlay: true } : {} }), status: it.status };
        return { ...row, idx: rows.push(row) - 1 };
      }),
    });
  });
  if (askRow && !askFirst) groups.push({ label: "Спросить", total: 1, items: [{ ...askRow, idx: rows.push(askRow) - 1 }] });
  const total = (query ? local.length : 0) + server.total;
  const shown = rows.length - (askRow ? 1 : 0); // строка «Спросить Кампус» — не результат поиска

  const run = (row) => { if (row.keep) { row.run(); return; } onClose(); setTimeout(row.run, 0); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && rows[active]) { e.preventDefault(); run(rows[active]); }
    else if (e.key === "Tab") e.preventDefault();
  };
  // Прокручиваем только список, не страницу (scrollIntoView сдвигал документ под палитрой).
  useEffect(() => {
    const list = listRef.current, el = list && list.querySelector(`[data-idx="${active}"]`);
    if (!el) return;
    const top = el.offsetTop - list.offsetTop, bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 28;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 6;
  }, [active]);

  const truncated = server.groups.filter((g) => g.total > g.items.length);
  const item = (it) => html`<div class=${"palette-item" + (it.ai ? " is-ai" : "")} role="option" id=${`pi-${it.idx}`} data-idx=${it.idx} aria-selected=${it.idx === active ? "true" : "false"}
    onMouseMove=${() => active !== it.idx && setActive(it.idx)} onClick=${() => run(it)}>
    ${it.ai ? html`<${Spark} size=${16} />` : html`<${Icon} name=${it.icon} />`}
    <span class="body"><span class="title">${it.ai ? it.title : html`<${Highlight} text=${it.title} q=${q.trim()} />`}${it.ai && html` <span class="ai-chip">AI</span>`}</span>${it.meta && html`<span class="meta" style="display:block">${it.meta}</span>`}</span>
    ${it.status && it.status !== "normal" && html`<span class="tag">${it.status === "cancelled" ? "отменено" : "изменено"}</span>`}
    ${it.idx === active && html`<${Icon} name="return" />`}
  </div>`;
  return html`
    <div class=${"overlay" + (closing ? " is-closing" : "")} onClick=${onClose}></div>
    <div class="dialog-wrap palette-wrap" style="padding-top:12vh" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class=${"palette" + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-label="Поиск по кабинету" onKeyDown=${onKey}>
        <div class="palette-input">
          <${Icon} name="search" />
          <input ref=${input} value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Дисциплина, преподаватель, аудитория, заявка, действие…"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant=${rows[active] ? `pi-${active}` : undefined} aria-label="Поиск по кабинету" />
          ${status === "loading" && html`<span class="small">Ищем…</span>`}
          <span class="kbd">Esc</span>
        </div>
        <div class="palette-list" id="palette-list" role="listbox" ref=${listRef} aria-label="Результаты">
          <${Presence} show=${!!askShown}>${(askShown || lastAsk.current) && html`<${AskBlock} a=${askShown || lastAsk.current} srcRows=${srcRows} item=${item} />`}</${Presence}>
          ${groups.map((g) => html`<div role="group" aria-label=${g.label}>
            <div class="palette-group" aria-hidden="true"><span>${g.label}</span>${g.total > g.items.length && html`<span>показаны ${g.items.length} из ${g.total}</span>`}</div>
            ${g.items.map(item)}
          </div>`)}
          ${query.length >= 2 && shown === 0 && !askShown && status !== "loading" && html`<div class="empty" style="padding:24px 16px">
            <h2 class="h2">${status === "error" ? "Поиск по данным недоступен" : `Ничего не найдено по «${q.trim()}»`}</h2>
            <p>${status === "error" ? "Нет связи с сервером. Разделы и действия по-прежнему доступны." : "Попробуйте фамилию преподавателя, номер аудитории (например, 318), название дисциплины или «справка»."}</p></div>`}
        </div>
        <div class="palette-foot" aria-live="polite">
          <span class="grow">${askShown ? (askShown.res ? `Ответ Кампуса${srcRows.length ? ` · ${countOf(srcRows.length, "источник", "источника", "источников")}` : ""}` : "Кампус отвечает…")
            : query ? (status === "loading" ? "Ищем по данным…" : `Найдено: ${total}${truncated.length ? ` · показано ${shown}` : ""}`) : "Введите запрос — от 2 символов для поиска по данным"}</span>
          <span><span class="kbd">↑</span> <span class="kbd">↓</span> выбрать</span><span><span class="kbd">↵</span> открыть</span>
        </div>
      </div>
    </div>`;
}
