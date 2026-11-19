// Свои поля выбора вместо системных <select> и <input type="date">: выглядят как остальной интерфейс
// в обеих темах и ведут себя одинаково во всех браузерах.
//   Select     — список (combobox + listbox, aria-activedescendant); стрелки, Home/End, Enter, Esc, набор букв.
//   TimeSelect — время с шагом 15 минут: тот же список, набор «18» переходит к 18:00.
//   DatePicker — месяц сеткой; стрелки по дням и неделям, PageUp/PageDown по месяцам, Enter, Esc.
// Попап — position: fixed у кнопки (сверху, если снизу не помещается); Esc закрывает попап, а не диалог под ним.
import { html, useEffect, useLayoutEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Icon } from "./icons.js";

let seq = 0;
const uid = (p) => `${p}-${++seq}`;
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WD_FULL = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

// ------------------------------------------------------------------ попап
export function Pop({ anchor, onClose, children, cls = "", align = "start", label, role }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current, p = ref.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect(), h = p.offsetHeight, w = Math.max(p.offsetWidth, r.width);
      const below = innerHeight - r.bottom, up = below < h + 12 && r.top > below;
      let left = align === "end" ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, innerWidth - w - 8));
      setPos({ left, top: up ? Math.max(8, r.top - h - 6) : r.bottom + 6, minW: r.width, up });
    };
    place();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, []);
  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && anchor.current && !anchor.current.contains(e.target)) onClose(); };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
  return html`<div class=${"pop " + cls + (pos && pos.up ? " up" : "")} ref=${ref} role=${role} aria-label=${label}
    style=${pos ? `left:${pos.left}px;top:${pos.top}px;min-width:${pos.minW}px` : "visibility:hidden;left:0;top:0"}>${children}</div>`;
}

// Попап уходит коротким затуханием, а не пропадает скачком.
export function useOpen() {
  const [st, set] = useState("closed"); // closed | open | closing
  const open = () => set("open");
  const close = () => set((s) => (s === "open" ? "closing" : s));
  useEffect(() => { if (st === "closing") { const t = setTimeout(() => set("closed"), 110); return () => clearTimeout(t); } }, [st]);
  return [st, open, close];
}

// ------------------------------------------------------------------ список
export function Select({ id, value, options, onChange, placeholder = "Выберите…", invalid, describedBy, disabled, cls = "", style, listCls = "" }) {
  const myId = useRef(id || uid("sel")).current;
  const [st, openPop, closePop] = useOpen();
  const [active, setActive] = useState(-1);
  const btn = useRef(null), list = useRef(null);
  const typed = useRef({ s: "", t: 0 });
  const open = st === "open";
  const selIdx = options.findIndex((o) => o.value === value);
  const sel = options[selIdx];

  const show = () => { if (disabled) return; setActive(selIdx >= 0 ? selIdx : 0); openPop(); };
  const hide = (focus = true) => { closePop(); if (focus) btn.current && btn.current.focus({ preventScroll: true }); };
  const pick = (i) => { const o = options[i]; if (!o || o.disabled) return; hide(); if (o.value !== value) onChange(o.value); };
  // Выбранный (или подсвеченный) пункт — в видимой части списка.
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    const el = list.current.querySelector(`[data-i="${active}"]`);
    if (el) { const l = list.current; if (el.offsetTop < l.scrollTop) l.scrollTop = el.offsetTop - 4; else if (el.offsetTop + el.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = el.offsetTop + el.offsetHeight - l.clientHeight + 4; }
  }, [open, active]);
  const typeahead = (ch) => {
    const now = Date.now();
    typed.current = { s: (now - typed.current.t < 700 ? typed.current.s : "") + ch.toLowerCase(), t: now };
    const q = typed.current.s;
    const start = open ? active : selIdx;
    const order = options.map((_, i) => (start + 1 + i) % options.length);
    const hit = [...(q.length > 1 ? [start] : []), ...order].find((i) => i >= 0 && options[i].label.toLowerCase().startsWith(q));
    if (hit != null) { if (open) setActive(hit); else if (options[hit].value !== value) onChange(options[hit].value); }
  };
  const key = (e) => {
    const k = e.key;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(k)) { e.preventDefault(); show(); }
      else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(k);
      return;
    }
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (k === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (k === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (k === "Home") { e.preventDefault(); setActive(0); }
    else if (k === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (k === "PageDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 8)); }
    else if (k === "PageUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 8)); }
    else if (k === "Enter" || k === " ") { e.preventDefault(); pick(active); }
    else if (k === "Tab") hide(false);
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey) typeahead(k);
  };
  return html`<div class=${"pick " + cls} style=${style}>
    <button type="button" class="select pick-btn" id=${myId} ref=${btn} role="combobox" aria-haspopup="listbox" aria-expanded=${open ? "true" : "false"}
      aria-controls=${myId + "-list"} aria-activedescendant=${open && active >= 0 ? `${myId}-o${active}` : undefined}
      aria-invalid=${invalid ? "true" : undefined} aria-describedby=${describedBy} disabled=${disabled}
      onClick=${() => (open ? hide() : show())} onKeyDown=${key}>
      <span class=${"pick-val" + (sel ? "" : " ph")}>${sel ? sel.label : placeholder}</span></button>
    ${st !== "closed" && html`<${Pop} anchor=${btn} onClose=${() => hide(false)} cls=${"pop-list" + (st === "closing" ? " closing" : "") + (listCls ? " " + listCls : "")}>
      <ul class="pick-list" role="listbox" id=${myId + "-list"} ref=${list} tabindex="-1" aria-labelledby=${myId}>
        ${options.map((o, i) => html`<li role="option" id=${`${myId}-o${i}`} data-i=${i} key=${o.value}
          class=${"pick-opt" + (i === active ? " active" : "") + (o.disabled ? " disabled" : "")} aria-selected=${o.value === value ? "true" : "false"} aria-disabled=${o.disabled ? "true" : undefined}
          onPointerMove=${() => active !== i && setActive(i)} onPointerDown=${(e) => e.preventDefault()} onClick=${() => pick(i)}>
          <span class="grow">${o.label}</span>${o.hint && html`<span class="pick-hint">${o.hint}</span>`}${o.value === value && html`<${Icon} name="check" />`}</li>`)}
      </ul></${Pop}>`}
  </div>`;
}

// ------------------------------------------------------------------ время
export const TIMES = Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

export function TimeSelect({ value, onChange, min, max, withEnd = false, ...rest }) {
  const list = TIMES.filter((t) => (withEnd || t !== "24:00") && (!min || t > min) && (!max || t < max));
  return html`<${Select} ...${rest} value=${value} onChange=${onChange} cls="pick-time" listCls="pop-time"
    options=${list.map((t) => ({ value: t, label: t }))} />`;
}

// ------------------------------------------------------------------ дата
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + "T00:00:00Z");
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const wdOf = (s) => (parse(s).getUTCDay() + 6) % 7;
export function dateLabel(s, { year = true } = {}) {
  const d = parse(s);
  return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}${year ? " " + d.getUTCFullYear() : ""}`;
}

export function DatePicker({ id, value, onChange, today, range, display, buttonCls = "select pick-btn", invalid, describedBy, disabled, label = "Выбор даты" }) {
  const myId = useRef(id || uid("date")).current;
  const [st, openPop, closePop] = useOpen();
  const [cursor, setCursor] = useState(value);
  const btn = useRef(null), grid = useRef(null);
  const open = st === "open";
  const show = () => { if (disabled) return; setCursor(value); openPop(); };
  const hide = (focus = true) => { closePop(); if (focus) btn.current && btn.current.focus({ preventScroll: true }); };
  const pick = (d) => { hide(); if (d !== value) onChange(d); };
  useEffect(() => { if (open && grid.current) { const el = grid.current.querySelector(`[data-d="${cursor}"]`); el && el.focus({ preventScroll: true }); } }, [open, cursor]);

  const c = parse(cursor);
  const first = iso(new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), 1)));
  const start = addDays(first, -wdOf(first));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weeks = cells.slice(35)[0].slice(5, 7) !== first.slice(5, 7) ? 5 : 6;
  const shiftMonth = (n) => { const d = parse(cursor); const day = d.getUTCDate(); const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); const last = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate(); m.setUTCDate(Math.min(day, last)); setCursor(iso(m)); };
  const key = (e) => {
    const k = e.key;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (k in moves) { e.preventDefault(); setCursor(addDays(cursor, moves[k])); }
    else if (k === "Home") { e.preventDefault(); setCursor(addDays(cursor, -wdOf(cursor))); }
    else if (k === "End") { e.preventDefault(); setCursor(addDays(cursor, 6 - wdOf(cursor))); }
    else if (k === "PageUp") { e.preventDefault(); shiftMonth(e.shiftKey ? -12 : -1); }
    else if (k === "PageDown") { e.preventDefault(); shiftMonth(e.shiftKey ? 12 : 1); }
    else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
  };
  const inRange = (d) => range && d >= range[0] && d <= range[1];
  return html`<div class="pick pick-date">
    <button type="button" class=${buttonCls} id=${myId} ref=${btn} aria-haspopup="dialog" aria-expanded=${open ? "true" : "false"}
      aria-invalid=${invalid ? "true" : undefined} aria-describedby=${describedBy} disabled=${disabled}
      onClick=${() => (open ? hide() : show())} onKeyDown=${(e) => { if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(); } }}>
      ${display || html`<span class="pick-val">${dateLabel(value)}</span>`}</button>
    ${st !== "closed" && html`<${Pop} anchor=${btn} onClose=${() => hide(false)} cls=${"pop-date" + (st === "closing" ? " closing" : "")} role="dialog" label=${label}>
      <div class="cal-mini" onKeyDown=${key}>
        <div class="cm-head">
          <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="Предыдущий месяц" onClick=${() => shiftMonth(-1)}><${Icon} name="left" /></button>
          <span class="cm-title" aria-live="polite">${MONTHS[c.getUTCMonth()][0].toUpperCase() + MONTHS[c.getUTCMonth()].slice(1)} ${c.getUTCFullYear()}</span>
          <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="Следующий месяц" onClick=${() => shiftMonth(1)}><${Icon} name="right" /></button>
        </div>
        <div class="cm-grid" ref=${grid} role="grid" aria-label=${label}>
          <div class="cm-row" role="row">${WD.map((w) => html`<span class="cm-wd" role="columnheader" aria-label=${WD_FULL[WD.indexOf(w)]}>${w}</span>`)}</div>
          ${Array.from({ length: weeks }, (_, w) => html`<div class="cm-row" role="row" key=${w}>${cells.slice(w * 7, w * 7 + 7).map((d) => html`<span role="gridcell" key=${d}>
            <button type="button" data-d=${d} tabindex=${d === cursor ? 0 : -1}
              class=${"cm-day" + (d.slice(5, 7) !== first.slice(5, 7) ? " out" : "") + (d === today ? " today" : "") + (d === value ? " sel" : "") + (inRange(d) ? " in" : "") + (range && d === range[0] ? " rs" : "") + (range && d === range[1] ? " re" : "")}
              aria-label=${`${WD_FULL[wdOf(d)]}, ${dateLabel(d)}${d === today ? ", сегодня" : ""}`} aria-pressed=${d === value ? "true" : "false"}
              onClick=${() => pick(d)}>${parse(d).getUTCDate()}</button></span>`)}</div>`)}
        </div>
        ${today && html`<div class="cm-foot"><button type="button" class="btn btn-sm btn-ghost" onClick=${() => pick(today)}>Сегодня</button></div>`}
      </div></${Pop}>`}
  </div>`;
}
