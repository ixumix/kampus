// Примитивы движения. Правила (по скиллу stageshow, references/motion.md):
// ничего не появляется и не исчезает скачком; уходящее остаётся смонтированным до конца выхода;
// соседи уступают место непрерывно; числа и статусы меняются на месте прокруткой;
// данные не «перерастают» заново при каждом показе.
import { html, h, useEffect, useLayoutEffect, useRef, useState } from "../vendor/preact-htm.js";

export const EASE_OUT = "cubic-bezier(.23,1,.32,1)";
export const EASE_IN_OUT = "cubic-bezier(.65,0,.35,1)";
export function reduced() { return matchMedia("(prefers-reduced-motion: reduce)").matches; }
const dur = (ms) => (reduced() ? 1 : ms);

// Один раз за сессию: полосы прогресса и баллов растут при первом показе, а не при каждом возврате.
const seen = new Set();
export function firstTime(key) { if (seen.has(key)) return false; seen.add(key); return true; }

// Высота (или ширина) открывается вместе с содержимым: содержимое проявляется после того,
// как контейнер почти открыт, и гаснет до того, как контейнер начнёт закрываться.
function animateSize(el, dir, axis) {
  // Сначала обрезка, потом замер: с overflow: hidden внешние отступы содержимого (например, margin-bottom у полосы
  // «С прошлого визита») остаются внутри контейнера и уезжают вместе с высотой, а не выпадают скачком в первом кадре.
  el.style.overflow = "hidden";
  const w = el.offsetWidth || el.scrollWidth, hgt = el.offsetHeight || el.scrollHeight;
  const open = {}, shut = {};
  if (axis !== "y") { open.width = w + "px"; shut.width = "0px"; }
  if (axis !== "x") { open.height = hgt + "px"; shut.height = "0px"; }
  // Зазор флекс-контейнера тоже закрывается, иначе в последнем кадре сосед «щёлкает» на его ширину.
  const ps = el.parentElement && getComputedStyle(el.parentElement);
  const prevEl = el.previousElementSibling;
  if (ps && /flex|grid/.test(ps.display) && prevEl) {
    const ownLine = el.offsetTop > prevEl.offsetTop + 2;
    if (axis !== "y" && !ownLine) { open.marginLeft = "0px"; shut.marginLeft = -(parseFloat(ps.columnGap) || 0) + "px"; }
    // На своей строке сужение заставило бы элемент перескочить к соседу — закрываем только по высоте.
    if (axis === "xy" && ownLine) { delete open.width; delete shut.width; }
    if (axis !== "x" && ownLine) { open.marginTop = "0px"; shut.marginTop = -(parseFloat(ps.rowGap) || 0) + "px"; }
  }
  const kf = dir === "in"
    ? [{ ...shut, opacity: 0 }, { opacity: 0, offset: 0.35 }, { ...open, opacity: 1 }]
    : [{ ...open, opacity: 1 }, { opacity: 0, offset: 0.45 }, { ...shut, opacity: 0 }];
  const a = el.animate(kf, { duration: dur(dir === "in" ? 280 : 220), easing: dir === "in" ? EASE_OUT : EASE_IN_OUT, fill: dir === "out" ? "forwards" : "none" });
  return a.finished.then(() => { if (dir === "in") el.style.overflow = ""; }).catch(() => {});
}

export function Collapse({ enter, leaving, onGone, children, axis = "y", inline, cls = "" }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (enter && ref.current) animateSize(ref.current, "in", axis); }, []);
  useLayoutEffect(() => { if (leaving && ref.current) animateSize(ref.current, "out", axis).then(() => onGone && onGone()); }, [leaving]);
  return h(inline ? "span" : "div", { ref, class: ("clp " + (inline ? "clp-inline " : "") + cls).trim(), "aria-hidden": leaving ? "true" : undefined, inert: leaving || undefined }, children);
}

// Список, в котором уходящие строки закрываются на своём месте, а новые открываются.
export function AnimatedList({ items, keyOf, render, cls = "", appear = false }) {
  const prev = useRef(null);
  const leaving = useRef(new Map());
  const mounted = useRef(false);
  const [, force] = useState(0);
  useEffect(() => { mounted.current = true; }, []);
  const cur = items.map((it) => ({ key: keyOf(it), item: it }));
  const curKeys = new Set(cur.map((e) => e.key));
  const prevKeys = new Set((prev.current || []).map((e) => e.key));
  (prev.current || []).forEach((e, i) => { if (!curKeys.has(e.key) && !leaving.current.has(e.key)) leaving.current.set(e.key, { item: e.item, index: i }); });
  leaving.current.forEach((_, k) => { if (curKeys.has(k)) leaving.current.delete(k); });
  const merged = cur.map((e) => ({ ...e, enter: (mounted.current || appear) && prev.current !== null && !prevKeys.has(e.key) }));
  [...leaving.current.entries()].sort((a, b) => a[1].index - b[1].index)
    .forEach(([key, v]) => merged.splice(Math.min(v.index, merged.length), 0, { key, item: v.item, gone: true }));
  prev.current = cur;
  return html`<div class=${cls}>${merged.map((e) => html`<${Collapse} key=${e.key} enter=${e.enter} leaving=${!!e.gone}
    onGone=${() => { leaving.current.delete(e.key); force((x) => x + 1); }}>${render(e.item)}</${Collapse}>`)}</div>`;
}

// Один элемент, который появляется и уходит плавно (ошибка поля, кнопка «Подтвердить»).
export function Presence({ show, children, axis = "y", inline, cls = "" }) {
  const last = useRef(children);
  const gen = useRef(0);
  const [gone, setGone] = useState(!show);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  if (show) last.current = children;
  useLayoutEffect(() => { if (show && gone) { gen.current++; setGone(false); } }, [show]);
  if (!show && gone) return null;
  return html`<${Collapse} key=${gen.current} axis=${axis} inline=${inline} cls=${cls} enter=${show && mounted.current} leaving=${!show}
    onGone=${() => setGone(true)}>${last.current}</${Collapse}>`;
}

// Число «дорастает» от нуля до значения при первом показе за сессию (баллы), в такт полосе; дальше — сразу значение.
export function CountUp({ value, id, duration = 700, format = String }) {
  const ref = useRef(null);
  const first = useRef(null);
  if (first.current === null) first.current = firstTime("count:" + id);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !first.current || reduced() || typeof value !== "number") return;
    const decimals = Number.isInteger(value) ? 0 : 1, t0 = performance.now();
    let raf = 0;
    // Пишем в тот же текстовый узел, которым владеет Preact: замена textContent подменяет узел,
    // и при следующем рендере в span оказывались два числа («4141 из 50»).
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / duration), e = 1 - Math.pow(1 - k, 4); // как --ease-out
      node.nodeValue = format(k < 1 ? Number((value * e).toFixed(decimals)) : value);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    node.nodeValue = format(0);
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); node.nodeValue = format(value); };
  }, []);
  return html`<span class="count-up" ref=${ref}>${format(value)}</span>`;
}

// Значение меняется на месте: старое уезжает, новое приезжает, ширина плавно подстраивается.
export function Roll({ value, cls = "" }) {
  const ref = useRef(null);
  const prev = useRef(value);
  const prevW = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prev.current !== value && el.isConnected) {
      const up = typeof value === "number" && typeof prev.current === "number" ? value > prev.current : true;
      const old = document.createElement("span");
      old.className = "roll-old";
      old.setAttribute("aria-hidden", "true");
      old.textContent = String(prev.current);
      el.appendChild(old);
      const newW = el.querySelector(".roll-cur").offsetWidth;
      const opts = { duration: dur(260), easing: EASE_OUT };
      if (prevW.current && prevW.current !== newW) el.animate([{ width: prevW.current + "px" }, { width: newW + "px" }], opts);
      el.querySelector(".roll-cur").animate([{ transform: `translateY(${up ? 70 : -70}%)`, opacity: 0 }, { transform: "none", opacity: 1 }], opts);
      old.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${up ? -70 : 70}%)`, opacity: 0 }], opts).finished.then(() => old.remove(), () => old.remove());
    }
    prev.current = value;
    prevW.current = el.querySelector(".roll-cur").offsetWidth;
  }, [value]);
  return html`<span class=${("roll " + cls).trim()} ref=${ref}><span class="roll-cur">${value}</span></span>`;
}
