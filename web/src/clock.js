// «Время идёт»: бейдж демо-времени на «Сегодня» — живые часы и ползунок дня.
// Клик по бейджу открывает шкалу 07:00–22:00 с парами дня. Тянешь ручку — «Сегодня» пересчитывается на лету
// (пара становится прошедшей, следующая — текущей, появляется «Пары закончились»); отпустил — время сохраняется
// в аккаунте и часы идут дальше от него. Здесь же — переключатель «Время идёт» и другие демо-дни.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Icon } from "./icons.js";
import { Pop, useOpen } from "./pickers.js";
import { setState, state, useDemoNow, clearCache, load, toast, fastClock } from "./data.js";
import { startTimelapse } from "./live.js";
import { setPreferences } from "./actions.js";
import { Roll } from "./motion.js";
import { toMin, shortDate } from "./format.js";

const FROM = 7 * 60, TO = 22 * 60, STEP = 5;
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function DemoClock({ day }) {
  const now = useDemoNow();
  const u = state.session.user;
  const [st, openPop, closePop] = useOpen();
  const btn = useRef(null), track = useRef(null);
  const [busy, setBusy] = useState(false);
  const date = now.slice(0, 10), min = toMin(now.slice(11, 16));
  const scrubbing = fastClock();

  // Esc закрывает окно, где бы ни был фокус (после перетаскивания мышью он остаётся на странице).
  useEffect(() => {
    if (st !== "open") return;
    const k = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); closePop(); btn.current && btn.current.focus({ preventScroll: true }); } };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [st]);
  const minAt = (x) => {
    const r = track.current.getBoundingClientRect();
    return clamp(Math.round((FROM + ((x - r.left) / r.width) * (TO - FROM)) / STEP) * STEP, FROM, TO);
  };
  const preview = (m) => setState({ demoPreview: `${date}T${hm(m)}` });
  const commit = async (iso) => {
    setBusy(true);
    try {
      await setPreferences({ demo_now: iso });
      // данные дня пересчитываются сервером (изменения, сроки) — подтягиваем, не показывая пустой кадр
      await load("today", null, { force: true }).catch(() => {});
    } catch (e) { toast(e.network ? "Нет связи — демо-время не сохранено" : e.message); }
    setState({ demoPreview: null });
    setBusy(false);
  };
  const onDown = (e) => {
    e.preventDefault();
    track.current.setPointerCapture(e.pointerId);
    preview(minAt(e.clientX));
  };
  const onMove = (e) => { if (track.current.hasPointerCapture(e.pointerId)) preview(minAt(e.clientX)); };
  const onUp = (e) => {
    if (!track.current.hasPointerCapture(e.pointerId)) return;
    track.current.releasePointerCapture(e.pointerId);
    commit(state.demoPreview || now);
  };
  const key = (e) => {
    const d = { ArrowLeft: -STEP, ArrowDown: -STEP, ArrowRight: STEP, ArrowUp: STEP, PageDown: -60, PageUp: 60 }[e.key];
    if (d != null) { e.preventDefault(); commit(`${date}T${hm(clamp(min + (e.shiftKey ? d * 6 : d), FROM, TO))}`); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); commit(`${date}T${hm(e.key === "Home" ? FROM : TO)}`); }
  };
  const toggleFlow = async () => {
    setBusy(true);
    try { await setPreferences({ time_flow: !u.time_flow }); } catch (e) { toast(e.network ? "Нет связи" : e.message); }
    setBusy(false);
  };
  const pickDay = async (iso) => {
    closePop();
    try { await setPreferences({ demo_now: iso }); clearCache(); } catch (e) { toast(e.network ? "Нет связи" : e.message); }
  };

  const lessons = (day && day.date === date ? day.lessons : []).filter((l) => l.status !== "cancelled");
  const pos = (m) => `${((clamp(m, FROM, TO) - FROM) / (TO - FROM)) * 100}%`;
  // другие демо-дни: по одному на дату (время дня выбирается ползунком)
  const byDate = {};
  u.demo_now_presets.forEach((p) => { const d = p.value.slice(0, 10); if (d !== date && (!byDate[d] || p.value.endsWith("10:15"))) byDate[d] = p; });
  const days = Object.values(byDate);
  const label = now.slice(11, 16);
  return html`<span class="demo-clock">
    <button type="button" class=${"demo-badge" + (u.clock_running ? " is-running" : "")} ref=${btn} aria-haspopup="dialog" aria-expanded=${st === "open" ? "true" : "false"}
      onClick=${() => (st === "open" ? closePop() : openPop())} title="Демо-время: «сейчас» кабинета, а не часы компьютера">
      <${Icon} name="clock" size=${13} /><span class="num">Демо-время ${scrubbing ? label : html`<${Roll} value=${label} />`} МСК</span>
      ${u.clock_running && html`<span class="live" aria-label="часы идут"></span>`}
    </button>
    ${st !== "closed" && html`<${Pop} anchor=${btn} onClose=${closePop} cls=${"pop-clock" + (st === "closing" ? " closing" : "")} role="dialog" label="Демо-время">
      <div class="dc" onKeyDown=${(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(); btn.current.focus(); } }}>
        <div class="dc-head">
          <div><div class="eyebrow">Демо-время · ${shortDate(date)}</div><div class="dc-time">${label}</div></div>
          <button type="button" class="dc-flow" role="switch" aria-checked=${u.time_flow ? "true" : "false"} onClick=${toggleFlow} disabled=${busy}>
            <span class="sw" aria-hidden="true"><i></i></span>Время идёт</button>
        </div>
        <div class="dc-track" ref=${track} role="slider" tabindex="0" aria-label="Время дня" aria-valuemin=${FROM} aria-valuemax=${TO} aria-valuenow=${min}
          aria-valuetext=${label} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onKeyDown=${key}>
          <div class="dc-rail">${lessons.map((l) => html`<i class=${"dc-l" + (l.start <= label && label < l.end ? " on" : l.end <= label ? " past" : "")}
            style=${`left:${pos(toMin(l.start))};width:calc(${pos(toMin(l.end))} - ${pos(toMin(l.start))})`} title=${`${l.start}–${l.end} ${l.subject}`}></i>`)}</div>
          ${[8, 10, 12, 14, 16, 18, 20].map((h) => html`<span class="dc-tick" style=${`left:${pos(h * 60)}`}>${String(h).padStart(2, "0")}</span>`)}
          <span class=${"dc-handle" + (scrubbing ? " is-active" : "")} style=${`left:${pos(min)}`} aria-hidden="true"></span>
        </div>
        <p class="dc-hint">Потяните — «Сегодня» пересчитается на лету. Стрелки — по 5 минут.</p>
        <button type="button" class="btn btn-sm dc-lapse" onClick=${() => { closePop(); startTimelapse(date); }} disabled=${busy}>
          <${Icon} name="play" />Прокрутить день<span class="meta">08:00 → 19:00 за 40 с</span></button>
        ${days.length > 0 && html`<div class="dc-days"><span class="eyebrow">Другой день</span>${days.map((p) => html`<button type="button" class="chip" onClick=${() => pickDay(p.value)}>${shortDate(p.value.slice(0, 10))}</button>`)}</div>`}
      </div>
    </${Pop}>`}
  </span>`;
}
