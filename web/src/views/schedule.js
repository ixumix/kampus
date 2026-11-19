// «Расписание» — календарь в духе Notion Calendar.
//   • Шкала 00:00–24:00 со своей прокруткой; пары, экзамены и личные события стоят по времени,
//     пересекающиеся — бок о бок; линия «сейчас» по демо-времени.
//   • Вид: день, 3 дня, неделя (D · 3 · W); навигация ‹ › или J/K, «Сегодня» — T; вид и дата в URL.
//   • Личные события: протянуть по пустой сетке (автопрокрутка у края), клик — событие на час;
//     перетащить, потянуть за верх/низ, клик — изменить, Delete — удалить с возвратом. C — новое событие.
//     На телефоне — долгое нажатие: на пустом месте создаёт, на событии берёт его для переноса; свайп — соседние дни.
//   • Сроки и экзамены — строкой «весь день» над сеткой. Экспорт .ics — ровно видимого диапазона.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../vendor/preact-htm.js";
import { Icon } from "../icons.js";
import { Button, Segmented } from "../ui.js";
import { Link, navigate, withParams } from "../router.js";
import { api, useResource, state, load, patchAll, refreshAfterWrite, toast, useDemoNow } from "../data.js";
import { download } from "../actions.js";
import { lessonHref } from "./lessons.js";
import { DatePicker, TimeSelect } from "../pickers.js";
import { reduced } from "../motion.js";
import { addDays, mondayOf, longDate, WD_SHORT, weekday, parseDate, isValidIso, toMin, countOf, dayMonth, where, MONTHS_GEN, MONTHS_SHORT, shortDate } from "../format.js";

const VIEWS = [{ value: "day", label: "День", n: 1, key: "d" }, { value: "3days", label: "3 дня", n: 3, key: "3" }, { value: "week", label: "Неделя", n: 7, key: "w" }];
const DAY = 24 * 60;
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const floor15 = (m) => Math.floor(m / 15) * 15;
const round15 = (m) => Math.round(m / 15) * 15;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function useMedia(q) {
  const [v, set] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const h = () => set(m.matches); m.addEventListener("change", h); return () => m.removeEventListener("change", h); }, [q]);
  return v;
}

function rangeOf(view, date) {
  if (view === "week") { const m = mondayOf(date); return [m, addDays(m, 6)]; }
  return [date, addDays(date, view === "3days" ? 2 : 0)];
}

function rangeLabel(from, to) {
  const a = parseDate(from), b = parseDate(to);
  if (from === to) return `${longDate(from)} ${a.getUTCFullYear()}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_GEN[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  return `${dayMonth(from)} – ${dayMonth(to)} ${b.getUTCFullYear()}`;
}

// Раскладка пересекающихся блоков: группы перекрытий, внутри — колонки «первая свободная».
function layout(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let group = [], groupEnd = -1;
  const flush = () => {
    const cols = [];
    group.forEach((it) => { let c = cols.findIndex((end) => end <= it.s); if (c < 0) { c = cols.length; cols.push(it.e); } else cols[c] = it.e; it.col = c; });
    group.forEach((it) => { it.cols = cols.length; });
    out.push(...group);
    group = []; groupEnd = -1;
  };
  for (const it of sorted) { if (group.length && it.s >= groupEnd) flush(); group.push(it); groupEnd = Math.max(groupEnd, it.e); }
  if (group.length) flush();
  return out;
}

// ------------------------------------------------------------- данные событий
function patchEvents(fn) {
  patchAll((key, data) => (key.startsWith("schedule:") ? { ...data, days: data.days.map((d) => ({ ...d, events: fn(d.events || [], d.date).sort((a, b) => a.start.localeCompare(b.start)) })) } : undefined));
}
const without = (id) => (evs) => evs.filter((e) => e.id !== id);
const placeEvent = (ev) => (evs, date) => (date === ev.date ? [...evs.filter((e) => e.id !== ev.id), ev] : evs.filter((e) => e.id !== ev.id));

async function createEvent(fields) {
  const tmp = { ...fields, id: -Date.now(), note: fields.note || "", pending: true };
  patchEvents(placeEvent(tmp));
  try {
    const { event } = await api("POST", "/api/events", fields);
    patchEvents((evs) => evs.filter((e) => e.id !== tmp.id));
    patchEvents(placeEvent(event));
    return event;
  } catch (e) {
    patchEvents(without(tmp.id));
    toast(e.network ? "Нет связи — событие не создано" : e.message);
    throw e;
  }
}

async function updateEvent(ev, fields, { quiet } = {}) {
  const next = { ...ev, ...fields };
  patchEvents(placeEvent(next));
  try {
    const { event } = await api("PATCH", `/api/events/${ev.id}`, fields);
    patchEvents(placeEvent(event));
    if (!quiet) toast("Событие сохранено");
    return event;
  } catch (e) {
    patchEvents(placeEvent(ev));
    toast(e.network ? "Нет связи — изменение не сохранено" : e.message);
    refreshAfterWrite(["schedule"]);
    throw e;
  }
}

async function deleteEvent(ev) {
  patchEvents(without(ev.id));
  try {
    await api("DELETE", `/api/events/${ev.id}`);
    toast(`Событие «${ev.title}» удалено`, { action: { label: "Вернуть", fn: () => createEvent({ date: ev.date, start: ev.start, end: ev.end, title: ev.title, note: ev.note }).catch(() => {}) } });
  } catch (e) {
    patchEvents(placeEvent(ev));
    toast(e.network ? "Нет связи — событие не удалено" : e.message);
  }
}

// ------------------------------------------------------------- редактор события
function EventEditor({ ev, anchor, today, onClose }) {
  const isNew = !(ev.id > 0);
  const [v, setV] = useState({ title: ev.title || "", date: ev.date, start: ev.start, end: ev.end, note: ev.note || "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null), title = useRef(null);
  const [pos, setPos] = useState(null);
  const set = (k, val) => { setErr(null); setV((p) => { const n = { ...p, [k]: val }; if (k === "start" && n.end <= val) n.end = hm(Math.min(DAY, toMin(val) + (toMin(p.end) - toMin(p.start) || 60))); return n; }); };
  const changed = isNew || ["title", "date", "start", "end", "note"].some((k) => (v[k] || "") !== (ev[k] || ""));
  const save = async () => {
    if (!v.title.trim()) { setErr("Введите название"); title.current && title.current.focus(); return; }
    if (v.end <= v.start) { setErr("Окончание должно быть позже начала"); return; }
    if (!changed) { onClose(); return; }
    setBusy(true);
    try { if (isNew) { await createEvent({ ...v, title: v.title.trim() }); toast("Событие добавлено"); } else await updateEvent(ev, { ...v, title: v.title.trim() }); onClose(true); }
    catch (e) { setBusy(false); }
  };
  const save0 = useRef(save); save0.current = save;
  // Позиция ставится прямо в DOM (без лишней перерисовки), поэтому окно видно сразу и поле получает фокус.
  useLayoutEffect(() => {
    const place = () => {
      const p = ref.current; if (!p) return;
      const sheet = innerWidth < 760;
      p.classList.toggle("sheet", sheet);
      if (sheet) { p.style.left = p.style.top = ""; }
      else {
        const r = anchor || { left: innerWidth / 2 - 160, right: innerWidth / 2 + 160, top: 160 };
        const w = p.offsetWidth, h = p.offsetHeight;
        p.style.left = (r.right + 10 + w <= innerWidth - 12 ? r.right + 10 : Math.max(12, r.left - 10 - w)) + "px";
        p.style.top = clamp(r.top, 64, innerHeight - h - 12) + "px";
      }
    };
    place();
    title.current && title.current.focus({ preventScroll: true });
    setPos(true);
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, []);

  useEffect(() => {
    // Клик мимо — как в Notion: заполненное сохраняется, пустой черновик пропадает.
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest(".pop")) { if (v.title.trim() || !isNew) save0.current(); else onClose(); } };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [v.title]);
  const key = (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };
  return html`<div class="ev-editor" ref=${ref} role="dialog" aria-modal="false" aria-labelledby="ev-ed-h" onKeyDown=${key} style="left:-10000px;top:0">
    <h2 class="ev-heading" id="ev-ed-h">${isNew ? "Новое событие" : "Событие"}</h2>
    <input class="ev-title" ref=${title} placeholder="Название события" aria-label="Название события" maxlength="120" value=${v.title}
      onInput=${(e) => set("title", e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} aria-invalid=${err && !v.title.trim() ? "true" : undefined} />
    <div class="ev-row">
      <${Icon} name="clock" />
      <${DatePicker} value=${v.date} today=${today} onChange=${(d) => set("date", d)} label="Дата события" buttonCls="ev-chip"
        display=${html`<span>${shortDate(v.date)}</span>`} />
      <${TimeSelect} value=${v.start} onChange=${(t) => set("start", t)} max="24:00" />
      <span class="ev-dash" aria-hidden="true">–</span>
      <${TimeSelect} value=${v.end} onChange=${(t) => set("end", t)} min=${v.start} withEnd />
    </div>
    <textarea class="ev-note" placeholder="Заметка" aria-label="Заметка" rows="2" maxlength="1000" value=${v.note} onInput=${(e) => set("note", e.target.value)}></textarea>
    ${err && html`<p class="error-text" role="alert"><${Icon} name="alert" size=${14} />${err}</p>`}
    <div class="ev-foot">
      ${!isNew && html`<${Button} kind="ghost" size="sm" icon="ban" onClick=${() => { onClose(true); deleteEvent(ev); }}>Удалить</${Button}>`}
      <span class="grow"></span>
      <${Button} size="sm" onClick=${() => onClose()}>Отмена</${Button}>
      <${Button} size="sm" kind="primary" busy=${busy} onClick=${save}>${isNew ? "Добавить" : "Сохранить"}</${Button}>
    </div>
  </div>`;
}

// ------------------------------------------------------------- сетка
function Lesson({ l, now, view, top, height, style, onHot }) {
  const today = now.slice(0, 10), t = now.slice(11, 16);
  const past = l.date < today || (l.date === today && l.end <= t);
  const live = l.date === today && l.start <= t && t < l.end && l.status !== "cancelled";
  // Идущая пара заполняется сверху: прошедшая часть темнее, граница совпадает с линией «сейчас».
  const prog = live ? Math.max(0, Math.min(1, (toMin(t) - toMin(l.start)) / Math.max(1, toMin(l.end) - toMin(l.start)))) : 0;
  const cls = ["cal-item", "cal-lesson", l.status === "cancelled" && "is-cancelled", l.change && !l.change.acknowledged_at && "is-changed", live && "is-now", past && "is-past", height < 40 && "is-short"].filter(Boolean).join(" ");
  const room = l.room ? (/^\d/.test(l.room) ? l.room : l.room) + (l.building && l.building.length <= 2 ? ", " + l.building : "") : "";
  const moved = movedFrom(l);
  const hot = moved && onHot ? { onPointerEnter: () => onHot(l.id), onPointerLeave: () => onHot(null), onFocus: (e) => e.currentTarget.matches(":focus-visible") && onHot(l.id), onBlur: () => onHot(null) } : {};
  return html`<${Link} class=${cls} href=${lessonHref(l, { view })} overlay style=${`top:${top}px;height:${height}px;${live ? `--prog:${prog.toFixed(4)};` : ""}${style}`} draggable="false" data-lesson=${l.id} ...${hot}
    aria-label=${`${l.subject}, ${l.kind}, ${l.start}–${l.end}, ${where(l.room, l.building)}${moved ? `, перенесено с ${moved.start}–${moved.end}` : ""}${l.status === "cancelled" ? ", отменено" : l.change && !l.change.acknowledged_at ? ", есть неподтверждённое изменение" : ""}`}>
    <span class="ci-t">${l.change && html`<${Icon} name=${l.status === "cancelled" ? "ban" : "swap"} size=${12} />`}${l.subject}</span>
    <span class="ci-m">${l.start}–${l.end}${room ? " · " + room : ""}</span>
  </${Link}>`;
}

// Перенос по времени в тот же день: откуда пара уехала.
function movedFrom(l) {
  const c = l.change;
  if (!c || l.status === "cancelled" || (c.kind !== "time" && c.kind !== "room_time")) return null;
  return c.old.start !== l.start || c.old.end !== l.end ? c.old : null;
}

// Призрак «было»: пунктирный блок на старом месте и тонкая связка со стрелкой к паре на новом.
// Пока перенос не подтверждён — виден всегда; после — только когда пару наводят или фокусируют.
// Сам по себе не кликается (pointer-events: none) и лежит под парами: старый слот может быть занят другой.
function WasGhost({ l, H, shown }) {
  const old = movedFrom(l);
  const s = toMin(old.start), e = toMin(old.end), ns = toMin(l.start), ne = toMin(l.end);
  const top = (s / 60) * H + 1, height = Math.max(H / 4, ((e - s) / 60) * H) - 2;
  const room = old.room !== l.room || old.building !== l.building ? where(old.room, old.building) : "";
  // связка от левого края призрака (середина) к ближнему краю пары; при наложении слотов её нет
  const mid = top + height / 2, below = s >= ne, above = e <= ns;
  const edge = below ? (ne / 60) * H - 1 : (ns / 60) * H + 1;
  const len = Math.abs(mid - edge);
  let link = null;
  if ((below || above) && len > 10) {
    // d — направление к паре (−1 вверх, +1 вниз); кончик стрелки — в 2 px от края пары
    const h = len, d = below ? -1 : 1, y0 = below ? h : 0, y1 = below ? 2 : h - 2;
    link = html`<svg class="cal-was-link" aria-hidden="true" width="16" height=${h} viewBox=${`0 0 16 ${h}`} style=${`top:${Math.min(mid, edge)}px`}>
      <path pathLength="1" d=${`M15 ${y0} H11 Q7 ${y0} 7 ${y0 + d * 4} V${y1}`} />
      <path class="tip" d=${`M3.5 ${y1 - d * 3.5} L7 ${y1} L10.5 ${y1 - d * 3.5}`} /></svg>`;
  }
  return html`<div class=${"cal-was" + (shown ? " is-shown" : "") + (below ? " is-below" : "")} aria-hidden="true">
    <div class="cal-item cal-was-box" style=${`top:${top}px;height:${height}px`}>
      <span class="ci-t">было ${old.start}–${old.end}</span>${room && html`<span class="ci-m">${room}</span>`}
    </div>${link}
  </div>`;
}

function PersonalEvent({ ev, top, height, style, dragging, source, onOpen }) {
  const key = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(ev, e.currentTarget.getBoundingClientRect()); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteEvent(ev); }
  };
  // Пока событие тянут, исходный блок остаётся на месте полупрозрачным: под пальцем остаётся тот же элемент,
  // и браузер не перехватывает жест под прокрутку.
  return html`<div class=${"cal-item cal-ev" + (dragging ? " is-dragging" : "") + (source ? " is-source" : "") + (ev.pending ? " is-pending" : "") + (height < 40 ? " is-short" : height < 64 ? " is-compact" : "")} data-ev=${ev.id}
    role="button" tabindex="0" aria-label=${`Личное событие: ${ev.title}, ${ev.start}–${ev.end}. Enter — изменить, Delete — удалить`}
    style=${`top:${top}px;height:${height}px;${style}`} onKeyDown=${key}>
    <i class="h hs" data-h="s" aria-hidden="true"></i>
    <span class="ci-t">${ev.title || "Новое событие"}</span><span class="ci-m">${ev.start}–${ev.end}</span>
    <i class="h he" data-h="e" aria-hidden="true"></i>
  </div>`;
}

export function SchedulePage({ route }) {
  const phone = useMedia("(max-width: 759px)");
  const user = state.session.user;
  const now = useDemoNow(), today = now.slice(0, 10), nowMin = toMin(now.slice(11, 16)); // демо-часы: линия «сейчас» движется
  const rawDate = route.search.get("date");
  const date = isValidIso(rawDate) ? rawDate : today;
  const qv = route.search.get("view");
  const view = VIEWS.some((v) => v.value === qv) ? qv : phone ? "day" : "week";
  const [from, to] = rangeOf(view, date);
  const n = VIEWS.find((v) => v.value === view).n;
  const dates = Array.from({ length: n }, (_, i) => addDays(from, i));
  const key = `schedule:${from}:${to}`;
  const { data, error, loading, reload } = useResource(key, `/api/schedule?from=${from}&to=${to}`);
  const H = phone ? 56 : 48;
  const [hot, setHot] = useState(null); // пара под курсором/фокусом — показать её призрак «было»

  const body = useRef(null), scroller = useRef(null), cal = useRef(null), header = useRef(null), colRefs = useRef({});
  const syncHeader = () => { if (header.current && scroller.current) header.current.scrollLeft = scroller.current.scrollLeft; };
  useLayoutEffect(() => {
    const sc = scroller.current, hd = header.current; if (!sc || !hd) return;
    sc.scrollLeft = 0; syncHeader();
    const fit = () => { hd.style.marginRight = (sc.offsetWidth - sc.clientWidth) + "px"; syncHeader(); };
    const ro = new ResizeObserver(fit); ro.observe(sc); fit();
    return () => ro.disconnect();
  }, [view, phone]);
  const dragRef = useRef(null);
  const [, force] = useState(0);
  const rerender = () => force((x) => x + 1);
  const [editing, setEditing] = useState(null); // { ev, anchor }
  const [calH, setCalH] = useState(560);
  const pendingIn = useRef(0);

  // Соседние диапазоны — заранее, чтобы ‹ › открывались без пустого кадра.
  useEffect(() => {
    if (!data) return;
    const step = view === "week" ? 7 : n;
    const near = view === "week" ? [-step, step] : [-step, -1, 1, step]; // день и 3 дня: ещё ±1 день — для сдвига прокруткой
    for (const k of [...new Set(near)]) { const [a, b] = rangeOf(view, addDays(from, k)); load(`schedule:${a}:${b}`, `/api/schedule?from=${a}&to=${b}`).catch(() => {}); }
  }, [!!data, from, view]);

  // Переход: тело календаря уходит в сторону движения и приходит с другой; смена вида — затухание.
  const go = (patch, dir = 0) => {
    const href = withParams("/schedule", { view, date, ...patch });
    setEditing(null);
    const el = body.current;
    const nv = patch.view || view, [nf] = rangeOf(nv, patch.date || date);
    if (!el || reduced() || (nf === from && nv === view)) { navigate(href, { replace: true }); return; }
    pendingIn.current = dir || 0.0001;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 14}px)` }], { duration: 90, easing: "ease-in", fill: "forwards" })
      .finished.then(() => navigate(href, { replace: true }), () => {});
  };
  useLayoutEffect(() => {
    const el = body.current, dir = pendingIn.current;
    if (!el || !dir) return;
    pendingIn.current = 0;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ opacity: 0, transform: `translateX(${Math.sign(dir) * 14}px)` }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.23,1,.32,1)" });
  }, [from, view]);
  const step = (dir) => go({ date: addDays(view === "week" ? from : date, dir * (view === "week" ? 7 : n)) }, dir);

  // День и 3 дня: горизонтальная прокрутка (тачпад, Shift+колесо) и свайп сдвигают диапазон на день —
  // «Пн, Вт, Ср» → «Вт, Ср, Чт». Колонки и их заголовки едут на ширину колонки; шкала времени стоит.
  const pendingShift = useRef(0);
  const shift = (days) => {
    if (!days || view === "week") return;
    setEditing(null);
    pendingShift.current = days;
    navigate(withParams("/schedule", { view, date: addDays(date, days) }), { replace: true });
  };
  useLayoutEffect(() => {
    const k = pendingShift.current;
    pendingShift.current = 0;
    if (!k || reduced() || !cal.current) return;
    const col = cal.current.querySelector(".cal-col");
    if (!col) return;
    const w = col.getBoundingClientRect().width;
    cal.current.querySelectorAll(".cal-dh, .cal-ad, .cal-col").forEach((el) =>
      el.animate([{ transform: `translateX(${k * w}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.23,1,.32,1)" }));
  }, [from]);
  // Один жест — один шаг: день (день и 3 дня) или неделя. Жест заканчивается, когда события колеса затихли на 220 мс:
  // инерция тачпада продолжает слать события, поэтому «крутануть» на несколько дней сразу нельзя.
  // Состояние жеста живёт в ref: после шага эффект перевешивается на новую дату, а жест (и его инерция) продолжается.
  const gesture = useRef({ acc: 0, fired: false, idle: 0 });
  const stepRef = useRef(null);
  stepRef.current = (k) => (view === "week" ? step(k) : shift(k));
  useEffect(() => {
    const el = cal.current;
    if (!el) return;
    const g = gesture.current;
    const wheel = (e) => {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!dx || (!e.shiftKey && Math.abs(dx) <= Math.abs(e.deltaY))) return; // вертикально — прокрутка времени
      // неделя на узком экране листается горизонтально сама — её прокрутку не перехватываем
      const sc = el.querySelector(".cal-scroll");
      if (view === "week" && sc && sc.scrollWidth > sc.clientWidth + 1) return;
      e.preventDefault();
      clearTimeout(g.idle);
      g.idle = setTimeout(() => { g.acc = 0; g.fired = false; }, 220);
      if (g.fired) return;
      g.acc += e.deltaMode === 1 ? dx * 16 : dx;
      if (Math.abs(g.acc) >= 60) { const k = Math.sign(g.acc); g.acc = 0; g.fired = true; stepRef.current(k); }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [view]);
  useEffect(() => () => clearTimeout(gesture.current.idle), []);

  // Высота календаря — до низа окна; своя прокрутка шкалы, первая прокрутка — к первой паре или «сейчас».
  useLayoutEffect(() => {
    const fit = () => { if (!cal.current) return; const top = cal.current.getBoundingClientRect().top + scrollY; setCalH(Math.max(420, innerHeight - top - (innerWidth < 760 ? 76 : 20))); };
    fit(); addEventListener("resize", fit); return () => removeEventListener("resize", fit);
  }, [!!data, phone, !!(data && data.days.every((d) => d.state === "no_data")), !!error]);
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (scrolled.current || !scroller.current || !data) return;
    scrolled.current = true;
    const firsts = data.days.flatMap((d) => d.lessons.map((l) => toMin(l.start)));
    const anchor = Math.min(dates.includes(today) ? nowMin : DAY, firsts.length ? Math.min(...firsts) : 8 * 60);
    scroller.current.scrollTop = Math.max(0, (anchor - 60) / 60 * H);
  }, [!!data]);

  // ---------------------------------------------------------- перетаскивание
  const evById = (id) => { for (const d of (data ? data.days : [])) { const e = (d.events || []).find((x) => x.id === id); if (e) return e; } return null; };
  const colAt = (x) => {
    let best = null;
    for (const d of dates) { const el = colRefs.current[d]; if (!el) continue; const r = el.getBoundingClientRect(); const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0; if (!best || dist < best.dist) best = { date: d, rect: r, dist }; }
    return best;
  };
  const minAt = (y, rect) => clamp(((y - rect.top) / H) * 60, 0, DAY);
  const update = () => {
    const d = dragRef.current; if (!d) return;
    const c = colAt(d.x); if (!c) return;
    const m = minAt(d.y, c.rect);
    if (d.mode === "create") { d.s = Math.min(d.anchor, round15(m)); d.e = Math.min(DAY, Math.max(d.anchor + 15, round15(m))); }
    else if (d.mode === "move") { const dur = d.e0 - d.s0; d.s = clamp(round15(m - d.grab), 0, DAY - dur); d.e = d.s + dur; d.date = c.date; }
    else if (d.mode === "rs") d.s = clamp(round15(m), 0, d.e - 15);
    else if (d.mode === "re") d.e = clamp(round15(m), d.s + 15, DAY);
    rerender();
  };
  const autoscroll = () => {
    const d = dragRef.current, sc = scroller.current;
    if (!d || !d.active || !sc) return;
    const r = sc.getBoundingClientRect(), edge = 48;
    const v = d.y < r.top + edge ? -(r.top + edge - d.y) : d.y > r.bottom - edge ? d.y - (r.bottom - edge) : 0;
    if (v) { const before = sc.scrollTop; sc.scrollTop += clamp(v * 0.35, -18, 18); if (sc.scrollTop !== before) update(); }
    if (phone && view === "week") {
      const vx = d.x < r.left + edge ? -(r.left + edge - d.x) : d.x > r.right - edge ? d.x - (r.right - edge) : 0;
      if (vx) { const before = sc.scrollLeft; sc.scrollLeft += clamp(vx * .25, -12, 12); if (sc.scrollLeft !== before) { syncHeader(); update(); } }
    }
    d.raf = requestAnimationFrame(autoscroll);
  };
  const activate = () => {
    const d = dragRef.current; if (!d || d.active) return;
    d.active = true;
    if (d.touch && navigator.vibrate) navigator.vibrate(8);
    try { scroller.current.setPointerCapture(d.pointerId); } catch (e) { /* указатель уже отпущен */ }
    d.raf = requestAnimationFrame(autoscroll);
    update();
  };
  const endDrag = () => { const d = dragRef.current; if (d) { clearTimeout(d.timer); cancelAnimationFrame(d.raf); } dragRef.current = null; rerender(); };
  const openEditor = (ev, anchor) => { endDrag(); setEditing({ ev, anchor }); };

  const onDown = (e) => {
    if ((e.button && e.button !== 0) || editing) return;
    if (e.target.closest("a, .cal-allday, button")) return;
    const c = colAt(e.clientX); if (!c || c.dist > 0) return;
    const evEl = e.target.closest("[data-ev]");
    const touch = e.pointerType === "touch";
    const m = minAt(e.clientY, c.rect);
    let d;
    if (evEl) {
      const ev = evById(Number(evEl.dataset.ev)); if (!ev || ev.pending) return;
      const h = e.target.closest("[data-h]");
      const s0 = toMin(ev.start), e0 = toMin(ev.end);
      d = { mode: h && !touch ? (h.dataset.h === "s" ? "rs" : "re") : "move", ev, date: ev.date, s: s0, e: e0, s0, e0, grab: m - s0, el: evEl };
    } else {
      const a = floor15(m);
      d = { mode: "create", date: c.date, anchor: touch ? floor15(m) : a, s: a, e: a + (touch ? 60 : 15) };
    }
    Object.assign(d, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId, touch });
    dragRef.current = d;
    if (touch) d.timer = setTimeout(() => { if (dragRef.current === d) { if (d.mode === "create") { d.anchor = d.s; d.e = Math.min(DAY, d.s + 60); d.mode = "create-touch"; } activate(); } }, 450);
    else e.preventDefault();
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.active) {
      const dx = d.x - d.x0, dy = d.y - d.y0;
      if (d.touch) {
        // В неделе жест прокручивает колонки, в дне и 3 днях — меняет диапазон; вертикальный жест прокручивает время.
        if (view === "week" && Math.abs(dx) > 10) { endDrag(); }
        else if (Math.abs(dx) > 56 && Math.abs(dx) > 2 * Math.abs(dy)) {
          // один свайп — один день, как и прокрутка тачпадом
          endDrag();
          shift(-Math.sign(dx));
        }
        else if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) endDrag(); // вертикально — обычная прокрутка
        else if (Math.abs(dx) > 10) clearTimeout(d.timer); // горизонтально — ждём свайп, долгое нажатие уже не считается
        return;
      }
      if (Math.hypot(dx, dy) > 4) activate();
      return;
    }
    if (d.mode === "create-touch") { const c = colAt(d.x); const m = minAt(d.y, c.rect); d.e = clamp(round15(m), d.s + 15, DAY); rerender(); return; }
    update();
  };
  const onUp = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      endDrag();
      if (d.ev) openEditor(d.ev, d.el.getBoundingClientRect());
      else if (!d.touch) { const s = Math.min(Math.floor(d.anchor / 30) * 30, DAY - 60); openEditor({ date: d.date, start: hm(s), end: hm(Math.min(DAY, s + 60)), title: "" }, rectFor(d.date, s, s + 60)); }
      return;
    }
    if (d.mode === "create" || d.mode === "create-touch") { const r = rectFor(d.date, d.s, d.e); endDrag(); openEditor({ date: d.date, start: hm(d.s), end: hm(d.e), title: "" }, r); return; }
    const ev = d.ev, fields = { date: d.date, start: hm(d.s), end: hm(d.e) };
    endDrag();
    if (fields.date !== ev.date || fields.start !== ev.start || fields.end !== ev.end) updateEvent(ev, fields, { quiet: true }).catch(() => {});
  };
  const rectFor = (dateIso, s, e) => {
    const el = colRefs.current[dateIso]; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top + (s / 60) * H, bottom: r.top + (e / 60) * H };
  };
  // Пока событие держат пальцем, страница не прокручивается.
  useEffect(() => {
    const tm = (e) => { if (dragRef.current && dragRef.current.active) e.preventDefault(); };
    document.addEventListener("touchmove", tm, { passive: false, capture: true });
    return () => document.removeEventListener("touchmove", tm, { capture: true });
  }, []);

  // ---------------------------------------------------------- клавиши как в Notion Calendar
  const newEvent = () => {
    const d0 = dates.includes(today) ? today : from;
    const s = d0 === today ? clamp(Math.ceil((nowMin + 1) / 60) * 60, 0, DAY - 60) : 9 * 60;
    openEditor({ date: d0, start: hm(s), end: hm(s + 60), title: "" }, rectFor(d0, s, s + 60));
    const sc = scroller.current; if (sc) sc.scrollTop = Math.max(0, (s - 120) / 60 * H);
  };
  useEffect(() => {
    const k = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || e.target.closest(".pop, .ev-editor, [aria-modal='true']")) return;
      if (document.querySelector("[aria-modal='true'], .ev-editor")) return;
      const key = e.key.toLowerCase();
      const v = VIEWS.find((x) => x.key === key || (key === "в" && x.value === "day") || (key === "ц" && x.value === "week"));
      if (v && v.value !== view) { e.preventDefault(); go({ view: v.value }); }
      else if (key === "j" || key === "о") { e.preventDefault(); step(1); }
      else if (key === "k" || key === "л") { e.preventDefault(); step(-1); }
      else if (key === "t" || key === "е") { e.preventDefault(); go({ date: today }); }
      else if (key === "c" || key === "с") { e.preventDefault(); newEvent(); }
      else if (e.key === "Escape" && dragRef.current) { e.preventDefault(); endDrag(); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  // ---------------------------------------------------------- отрисовка
  const days = dates.map((d) => (data && data.days.find((x) => x.date === d)) || { date: d, state: data ? "no_data" : "loading", lessons: [], events: [], tasks: [], exams: [] });
  const drag = dragRef.current && dragRef.current.active ? dragRef.current : null;
  const hasAllDay = days.some((d) => (d.tasks || []).length || (d.exams || []).length);
  const allNoData = data && days.every((d) => d.state === "no_data");
  const stats = data && days.reduce((a, d) => ({ n: a.n + d.lessons.filter((l) => l.status !== "cancelled").length, c: a.c + d.lessons.filter((l) => l.change && !l.change.acknowledged_at).length, e: a.e + (d.events || []).length }), { n: 0, c: 0, e: 0 });
  const statParts = stats ? [
    stats.n && countOf(stats.n, "пара", "пары", "пар"),
    stats.c && countOf(stats.c, ...(phone ? ["изменение", "изменения", "изменений"] : ["неподтверждённое изменение", "неподтверждённых изменения", "неподтверждённых изменений"])),
    stats.e && countOf(stats.e, "своё событие", "своих события", "своих событий"),
  ].filter(Boolean) : [];
  const p0 = data && data.published && data.published[0];
  const cols = `grid-template-columns: var(--gut) repeat(${n}, minmax(0, 1fr))`;

  return html`<div class="page page-cal">
    <div class="page-head">
      <div class="titles">
        <h1 class="h1" tabindex="-1" data-page-title>Расписание</h1>
        <p class="meta"><span class="cal-range">${rangeLabel(from, to)}</span><span class="cal-stats">${statParts.join(" · ")}</span></p>
      </div>
      <div class="actions">
        <${Button} icon="calExport" onClick=${() => download(`/api/schedule.ics?from=${from}&to=${to}`)} disabled=${!data}
          title=${`Файл .ics: пары и свои события, ${rangeLabel(from, to)}`}><span>Экспорт<span class="hide-narrow">${"\u00a0" + (n === 1 ? "дня" : n === 3 ? "3 дней" : "недели")}</span></span></${Button}>
        <${Link} class="btn btn-ghost" href="/profile#calendar" title="Подписка обновляется сама: переносы и отмены приходят в календарь"><${Icon} name="refresh" /><span class="hide-narrow">Подписаться</span></${Link}>
      </div>
    </div>
    <div class="cal-toolbar">
      <${Segmented} label="Вид календаря" value=${view} onChange=${(v) => go({ view: v })} options=${VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
      <div class="cal-nav">
        <${Button} icon="left" aria-label="Назад" title="Назад (K)" onClick=${() => step(-1)} />
        <${Button} onClick=${() => go({ date: today })} disabled=${dates.includes(today) && date === today} title="Сегодня (T)">Сегодня</${Button}>
        <${Button} icon="right" aria-label="Вперёд" title="Вперёд (J)" onClick=${() => step(1)} />
      </div>
      <${DatePicker} value=${date} today=${today} range=${[from, to]} onChange=${(d) => go({ date: d }, d > date ? 1 : -1)} label="Перейти к дате"
        buttonCls="btn cal-datebtn" display=${html`<${Icon} name="calendar" /><span>${MONTHS_SHORT[parseDate(from).getUTCMonth()]}${parseDate(from).getUTCMonth() !== parseDate(to).getUTCMonth() ? "–" + MONTHS_SHORT[parseDate(to).getUTCMonth()] : ""} ${parseDate(to).getUTCFullYear()}</span>`} />
      <span class="grow"></span>
      <span class="cal-hint">Протяните по сетке, чтобы добавить событие</span>
      <${Button} cls="cal-export-m" icon="calExport" aria-label=${`Экспорт ${rangeLabel(from, to)} в .ics`} onClick=${() => download(`/api/schedule.ics?from=${from}&to=${to}`)} disabled=${!data} />
      <${Button} kind="primary" cls="cal-add" icon="plus" onClick=${newEvent} title="Новое событие (C)">Событие</${Button}>
    </div>
    ${allNoData && html`<div class="banner banner-dashed cal-banner"><${Icon} name="info" /><span class="grow">Расписание на эти дни не опубликовано — это не свободные дни.${p0 ? ` Опубликовано: ${dayMonth(p0.from)} – ${dayMonth(p0.to)}.` : ""} Свои события добавлять можно.</span>
      ${p0 && html`<${Button} size="sm" onClick=${() => go({ date: p0.to < today ? p0.from : today }, p0.from < from ? -1 : 1)}>К опубликованным</${Button}>`}</div>`}
    ${error && !data && html`<div class="banner banner-dashed cal-banner" role="alert"><${Icon} name="alert" /><span class="grow">Не удалось загрузить расписание. ${error.network ? "Нет связи с сервером." : error.message}</span><${Button} size="sm" icon="refresh" onClick=${reload}>Повторить</${Button}></div>`}
    <div class=${"cal" + (loading && !data ? " is-loading" : "") + ` cal-n${n}`} ref=${cal} style=${`height:${calH}px;--hh:${H}px`} aria-busy=${loading && !data ? "true" : "false"}>
      <div class="cal-body" ref=${body}>
        <div class="cal-header" ref=${header}>
          <div class="cal-head" style=${cols}>
            <span class="cal-gut-h" aria-hidden="true">${n === 1 ? "" : "GMT+3"}</span>
            ${days.map((d) => html`<button type="button" class=${"cal-dh" + (d.date === today ? " is-today" : "") + (d.state === "no_data" ? " is-nodata" : "")} key=${d.date}
              onClick=${() => view !== "day" && go({ view: "day", date: d.date })} aria-label=${`${longDate(d.date)}${d.state === "no_data" ? ", расписание не опубликовано" : ""}${view !== "day" ? ". Открыть день" : ""}`}>
              <span class="wd">${WD_SHORT[weekday(d.date)]}</span><b>${parseDate(d.date).getUTCDate()}</b>${n === 1 && html`<span class="dm">${MONTHS_GEN[parseDate(d.date).getUTCMonth()]}</span>`}
              ${d.state === "no_data" && html`<span class="nd">нет данных</span>`}</button>`)}
          </div>
          ${hasAllDay && html`<div class="cal-allday" style=${cols}>
            <span class="cal-gut-h cal-gut-ad">весь<br />день</span>
            ${days.map((d) => html`<div class="cal-ad" key=${d.date}>
              ${(d.exams || []).map((x) => html`<${Link} class="cal-chip is-exam" href="/grades?tab=session" title=${`${x.kind}: ${x.subject}, ${x.start}, ${where(x.room, x.building)}`}><b>${x.start}</b> ${x.kind}: ${x.subject}</${Link}>`)}
              ${(d.tasks || []).map((t) => html`<${Link} class=${"cal-chip" + (t.done_at ? " is-done" : "")} href=${withParams("/", { task: t.id })} title=${`Срок: ${t.title}${t.due_time ? ", до " + t.due_time : ""}${t.done_at ? " (выполнено)" : ""}`}>
                <${Icon} name="clock" size=${12} />${t.due_time ? html`<b>${t.due_time}</b> ` : ""}${t.title}</${Link}>`)}
            </div>`)}
          </div>`}
        </div>
        <div class="cal-scroll" ref=${scroller} onScroll=${syncHeader} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${endDrag}>
          <div class="cal-grid" style=${`${cols};height:${24 * H}px`}>
            <div class="cal-gut" aria-hidden="true">${Array.from({ length: 23 }, (_, i) => html`<span style=${`top:${(i + 1) * H}px`}>${hm((i + 1) * 60)}</span>`)}
              ${dates.includes(today) && html`<span class="now" style=${`top:${(nowMin / 60) * H}px`}>${now.slice(11, 16)}</span>`}</div>
            ${days.map((d) => {
              const items = layout([
                ...d.lessons.map((l) => ({ kind: "l", id: "l" + l.id, s: toMin(l.start), e: toMin(l.end), l })),
                ...(d.events || []).map((ev) => ({ kind: "e", id: "e" + ev.id, s: toMin(ev.start), e: Math.max(toMin(ev.start) + 15, toMin(ev.end)), ev })),
              ]);
              const pos = (it) => ({ top: (it.s / 60) * H + 1, height: Math.max(H / 4, ((it.e - it.s) / 60) * H) - 2, style: `left:calc(${(it.col / it.cols) * 100}% + 2px);width:calc(${100 / it.cols}% - ${it.cols > 1 ? 3 : 6}px)` });
              const ghost = drag && drag.date === d.date ? drag : null;
              return html`<div class=${"cal-col" + (d.date === today ? " is-today" : "") + (d.state === "no_data" ? " is-nodata" : "")} key=${d.date} ref=${(el) => { if (el) colRefs.current[d.date] = el; }}
                  role="group" aria-label=${longDate(d.date)}>
                ${d.lessons.filter(movedFrom).map((l) => html`<${WasGhost} key=${"was" + l.id} l=${l} H=${H} shown=${!l.change.acknowledged_at || hot === l.id} />`)}
                ${items.map((it) => it.kind === "l"
                  ? html`<${Lesson} key=${it.id} l=${it.l} now=${now} view=${view} onHot=${setHot} ...${pos(it)} />`
                  : html`<${PersonalEvent} key=${it.id} ev=${it.ev} ...${pos(it)} source=${!!(drag && drag.ev && drag.ev.id === it.ev.id)} onOpen=${openEditor} />`)}
                ${ghost && html`<div class=${"cal-item cal-ev is-ghost" + (ghost.mode.startsWith("create") ? " is-new" : " is-dragging")} aria-hidden="true"
                  style=${`top:${(ghost.s / 60) * H + 1}px;height:${Math.max(H / 4, ((ghost.e - ghost.s) / 60) * H) - 2}px;left:2px;width:calc(100% - 6px)`}>
                  <span class="ci-t">${ghost.ev ? ghost.ev.title : "Новое событие"}</span><span class="ci-m">${hm(ghost.s)}–${hm(ghost.e)}</span></div>`}
                ${editing && !(editing.ev.id > 0) && editing.ev.date === d.date && html`<div class="cal-item cal-ev is-ghost is-new" aria-hidden="true"
                  style=${`top:${(toMin(editing.ev.start) / 60) * H + 1}px;height:${Math.max(H / 4, ((toMin(editing.ev.end) - toMin(editing.ev.start)) / 60) * H) - 2}px;left:2px;width:calc(100% - 6px)`}>
                  <span class="ci-t">Новое событие</span><span class="ci-m">${editing.ev.start}–${editing.ev.end}</span></div>`}
                ${d.date === today && html`<div class="cal-now" style=${`top:${(nowMin / 60) * H}px`} aria-hidden="true"></div>`}
              </div>`;
            })}
          </div>
        </div>
      </div>
    </div>
    <${Button} kind="primary" cls="cal-fab" icon="plus" aria-label="Новое событие" onClick=${newEvent} />
    ${editing && html`<${EventEditor} key=${editing.ev.id || "new"} ev=${editing.ev} anchor=${editing.anchor} today=${today}
      onClose=${() => setEditing(null)} />`}
  </div>`;
}
