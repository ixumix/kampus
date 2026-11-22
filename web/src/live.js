// «Живой интерфейс»: экран меняется сам, без действий пользователя.
//
// 1. Сценарий по демо-часам. Сервер знает ближайшее событие сценария (`user.next_live_at`): статус заявки
//    или новое уведомление. Когда демо-«сейчас» доходит до этой минуты, данные подтягиваются один раз,
//    новое уведомление показывается тостом, колокольчик звенит, строка списка открывается на своём месте.
// 2. Тихий фон сцен (волна в «Поле», дыхание стопки на входе, тени недели). Медленно, один цикл на экран,
//    на паузе, когда вкладка скрыта или сцена вне экрана. Выключается в Профиле («Живой интерфейс»)
//    и при prefers-reduced-motion: так соблюдается WCAG 2.2.2 (движение дольше 5 с можно остановить).
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, demoNow, refreshAfterWrite, state, toast, emit, useDemoNow, useStore, load } from "./data.js";
import { setPreferences } from "./actions.js";
import { Icon } from "./icons.js";
import { Presence } from "./motion.js";
import { navigate } from "./router.js";

// ------------------------------------------------------------------ настройка
const KEY = "kampus.alive";
function readPref() { try { return localStorage.getItem(KEY) !== "off"; } catch (e) { return true; } }
let pref = readPref();
const sync = () => document.documentElement.toggleAttribute("data-still", !pref);
sync();

export function aliveOn() { return pref; }
export function setAlive(on) {
  pref = !!on;
  try { localStorage.setItem(KEY, pref ? "on" : "off"); } catch (e) { /* нет хранилища — только на эту вкладку */ }
  sync();
  emit();
}
const reducedMq = matchMedia("(prefers-reduced-motion: reduce)");
/** Можно ли сейчас играть фоновое движение (без действий пользователя). */
export function ambientOn() { return pref && !reducedMq.matches && !document.hidden; }

/**
 * Фоновый цикл элемента: колбэк вызывается раз в `every` мс, пока элемент виден на экране, вкладка открыта
 * и «Живой интерфейс» включён. Первый вызов — после `delay` (вход сцены успевает доиграть).
 */
export function useAmbient(ref, fn, { every = 8000, delay = 2400, jitter = 0.35 } = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let visible = false, timer = 0, dead = false;
    const next = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
    const tick = () => {
      if (dead) return;
      if (visible && ambientOn()) fnRef.current();
      next(every * (1 - jitter / 2 + Math.random() * jitter));
    };
    const io = "IntersectionObserver" in window ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; }) : null;
    if (io) io.observe(el); else visible = true;
    next(delay);
    return () => { dead = true; clearTimeout(timer); io && io.disconnect(); };
  }, []);
}

// ------------------------------------------------------------- сценарий по демо-часам
const fresh = new Map(); // id уведомления → когда пришло (время устройства)
/** Уведомление только что пришло по сценарию: строка списка открывается на своём месте. */
export function isFresh(id) { const t = fresh.get(id); return !!t && Date.now() - t < 4000; }

let busy = false, retryAt = 0;
async function arrive(due) {
  busy = true;
  try {
    const [session, notes] = await Promise.all([
      api("GET", "/api/session", undefined, { quiet: true }),
      api("GET", "/api/notifications", undefined, { quiet: true }),
    ]);
    if (!state.session) return;
    const now = demoNow();
    const news = notes.notifications.filter((n) => n.created_at >= due && n.created_at <= now);
    news.forEach((n) => fresh.set(n.id, Date.now()));
    state.session.user = session.user;
    state.session.unread = session.unread;
    emit();
    // Подтягиваем то, что могло измениться: списки, «Сегодня», сводки, открытую заявку.
    await refreshAfterWrite(["notifications", "requests", "request", "today", "summary"]);
    news.slice(0, 2).forEach((n) => toast(n.title, {
      timeout: 7000,
      action: {
        label: "Открыть",
        fn: () => n.link_type === "request"
          ? navigate(`/documents/${n.link_id}`, { state: { overlay: true, keepScroll: true } })
          : navigate(`/notifications?id=${n.id}`),
      },
    }));
  } catch (e) {
    retryAt = Date.now() + 15000; // сеть: попробуем позже, без шума
  } finally {
    busy = false;
  }
}

/** В оболочке кабинета: следит за демо-часами и подтягивает события сценария ровно в их минуту. */
export function useLiveScript() {
  useEffect(() => {
    const id = setInterval(() => {
      const u = state.session && state.session.user;
      const due = u && u.next_live_at;
      if (!due || busy || state.demoPreview || Date.now() < retryAt) return;
      if (demoNow() >= due) arrive(due);
    }, 1000);
    return () => clearInterval(id);
  }, []);
}

/** Счётчик вырос — колокольчик качается (раз). Возвращает ключ, которым перезапускается анимация. */
export function useRing(count) {
  const prev = useRef(count);
  const [ring, setRing] = useState(0);
  useEffect(() => {
    if (typeof count === "number" && typeof prev.current === "number" && count > prev.current) setRing((r) => r + 1);
    prev.current = count;
  }, [count]);
  return ring;
}

/** Номер смены минуты демо-часов (0 до первой смены): пока часы идут, логотип коротко «тикает». */
export function useMinuteTick() {
  const now = useDemoNow();
  const prev = useRef(now);
  const n = useRef(0);
  if (prev.current !== now) {
    const running = state.session && state.session.user.clock_running && !state.demoPreview;
    if (running && (state.session.user.clock_speed || 1) <= 1 && now > prev.current) n.current++;
    prev.current = now;
  }
  return n.current;
}

/**
 * «Прожектор» за мышью: пятно света радиусом ~260 px идёт за указателем и задевает контуры всех плашек рядом —
 * светлеет не только плашка под курсором, но и соседние. Плашка, от которой курсор ушёл дальше радиуса,
 * гаснет плавно: пятно сжимается переходом --glow-r (0,6 с). Один слушатель на документ, обновление раз в кадр.
 */
const GLOW_SEL = ".panel, .doc-type, .lesson.is-now, .lesson.is-next";
const GLOW_R = 300;
export function usePanelGlow() {
  useEffect(() => {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let raf = 0, ev = null, lit = new Set();
    const timers = new WeakMap();
    const fade = (el) => {
      el.classList.add("glow-out");
      el.classList.remove("is-glow");
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(() => { if (!el.classList.contains("is-glow")) el.classList.remove("glow-out"); }, 640));
    };
    const apply = () => {
      raf = 0;
      if (!ev) return;
      const x = ev.clientX, y = ev.clientY, now = new Set();
      document.querySelectorAll(GLOW_SEL).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
        if (Math.hypot(dx, dy) > GLOW_R * 0.8) return;
        el.style.setProperty("--gx", (x - r.left).toFixed(0) + "px");
        el.style.setProperty("--gy", (y - r.top).toFixed(0) + "px");
        el.classList.remove("glow-out");
        el.classList.add("is-glow");
        now.add(el);
      });
      lit.forEach((el) => { if (!now.has(el)) fade(el); });
      lit = now;
    };
    const move = (e) => { if (e.pointerType !== "mouse") return; ev = e; if (!raf) raf = requestAnimationFrame(apply); };
    const leave = () => { lit.forEach(fade); lit = new Set(); ev = null; };
    document.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => { document.removeEventListener("pointermove", move); document.documentElement.removeEventListener("pointerleave", leave); cancelAnimationFrame(raf); };
  }, []);
}

// ------------------------------------------------------------- «Прокрутить день»
// Таймлапс для показа: демо-часы идут в ~1000 раз быстрее, и весь учебный день проходит за 40 секунд —
// пары становятся текущими и прошедшими, приходят события сценария, линия «сейчас» едет по календарю.
// Скорость хранится на сервере (clock_speed), поэтому сервер и экран считают одно и то же «сейчас».
const LAPSE_FROM = "08:00", LAPSE_TO = "19:00", LAPSE_SECONDS = 40;
const LAPSE_SPEED = Math.round(((11 * 60) * 60) / LAPSE_SECONDS); // 11 часов за 40 с ≈ 990×

export function lapseActive() {
  const u = state.session && state.session.user;
  return !!(u && u.clock_running && (u.clock_speed || 1) > 1);
}

export async function startTimelapse(date) {
  try {
    await setPreferences({ demo_now: `${date}T${LAPSE_FROM}`, time_flow: true, clock_speed: LAPSE_SPEED });
    await load("today", null, { force: true }).catch(() => {});
  } catch (e) { toast(e.network ? "Нет связи — прокрутка не запущена" : e.message); }
}

let stopping = false;
export async function stopTimelapse(at) {
  if (stopping) return;
  stopping = true;
  try {
    await setPreferences(at ? { demo_now: at, clock_speed: 1 } : { clock_speed: 1 });
    await refreshAfterWrite(["today", "notifications", "requests", "summary", "schedule"]);
  } catch (e) { toast(e.network ? "Нет связи — прокрутка не остановлена" : e.message); }
  stopping = false;
}

/** Плашка прокрутки внизу экрана: время, ход дня и «Стоп». В конце дня прокрутка останавливается сама. */
export function TimelapseBar() {
  useStore();
  const on = lapseActive();
  const now = useDemoNow();
  const end = now.slice(0, 10) + "T" + LAPSE_TO;
  useEffect(() => { if (on && now >= end) stopTimelapse(end); }, [on, now >= end]);
  const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const p = Math.max(0, Math.min(1, (m(now.slice(11, 16)) - m(LAPSE_FROM)) / (m(LAPSE_TO) - m(LAPSE_FROM))));
  return html`<${Presence} show=${on} cls="lapse-wrap"><div class="lapse" role="status" aria-label="Прокрутка дня">
    <${Icon} name="play" size=${14} />
    <span class="lapse-t">Прокрутка дня</span>
    <b class="lapse-now num">${now.slice(11, 16)}</b>
    <span class="lapse-bar" aria-hidden="true"><i style=${`transform:scaleX(${p.toFixed(4)})`}></i></span>
    <button type="button" class="btn btn-sm" onClick=${() => stopTimelapse()}>Стоп</button>
  </div></${Presence}>`;
}
