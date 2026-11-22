// Искра сводки: одна четырёхконечная звезда (спутник убран по просьбе пользователя, 22 ноября);
// вращается сам векторный контур, без растеризации SVG-слоя. Поворот на 90° даёт ту же фигуру — в конце нет скачка.
import { html, useLayoutEffect, useRef } from "../vendor/preact-htm.js";

let uid = 0;
function star(cx, cy, r, k = .16, angle = 0, scale = 1) {
  const a = r * k, t = angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const p = (x, y) => `${+(cx + (x * c - y * s) * scale).toFixed(6)} ${+(cy + (x * s + y * c) * scale).toFixed(6)}`;
  return `M${p(0, -r)}C${p(a, -a)} ${p(a, -a)} ${p(r, 0)}C${p(a, a)} ${p(a, a)} ${p(0, r)}C${p(-a, a)} ${p(-a, a)} ${p(-r, 0)}C${p(-a, -a)} ${p(-a, -a)} ${p(0, -r)}Z`;
}
// Та же кривая (.32,.72,0,1), что у изометрических фигур.
function ease(x) {
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 14; i++) {
    t = (lo + hi) / 2;
    const bx = 3 * (1 - t) ** 2 * t * .32 + t ** 3;
    if (bx < x) lo = t; else hi = t;
  }
  return 3 * (1 - t) ** 2 * t * .72 + 3 * (1 - t) * t ** 2 + t ** 3;
}

export function Spark({ size = 16, busy = false, cls = "" }) {
  const ref = useRef(null), idRef = useRef(null), pose = useRef({ main: 0 });
  if (!idRef.current) idRef.current = "spk" + ++uid;
  const id = idRef.current;
  useLayoutEffect(() => {
    const svg = ref.current, host = svg.parentElement, mq = matchMedia("(prefers-reduced-motion: reduce)");
    const main = svg.querySelectorAll(".spark-main path");
    let raf = 0;
    const draw = (p) => {
      pose.current = p;
      const m = star(12, 12, 10, .16, p.main);
      main.forEach((el) => el.setAttribute("d", m));
    };
    const animate = () => {
      cancelAnimationFrame(raf);
      if (mq.matches) { draw({ main: 0 }); return; }
      const hot = host.matches(":hover") || host.matches(":focus-visible");
      const from = { ...pose.current }, start = performance.now();
      if (Math.abs(from.main) > 180) from.main %= 90;
      const to = { main: hot ? 90 : 0 };
      if (!busy && Object.keys(to).every((k) => Math.abs(from[k] - to[k]) < .000001)) { draw(to); return; }
      const frame = (now) => {
        const elapsed = now - start;
        if (busy) {
          draw({ main: from.main + (elapsed / 1600) * 180 });
          raf = requestAnimationFrame(frame);
        } else {
          const t = Math.min(1, elapsed / 700), q = t === 1 ? 1 : ease(t);
          draw({ main: from.main + (to.main - from.main) * q });
          if (t < 1) raf = requestAnimationFrame(frame);
        }
      };
      raf = requestAnimationFrame(frame);
    };
    const events = ["pointerenter", "pointerleave", "focusin", "focusout"];
    events.forEach((name) => host.addEventListener(name, animate)); mq.addEventListener("change", animate);
    animate();
    return () => { cancelAnimationFrame(raf); events.forEach((name) => host.removeEventListener(name, animate)); mq.removeEventListener("change", animate); };
  }, [busy]);
  return html`<svg ref=${ref} class=${"spark" + (busy ? " busy" : "") + (cls ? " " + cls : "")} width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">
    <defs><linearGradient id=${id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="t1" /><stop offset="1" class="t2" /></linearGradient></defs>
    <g class="spark-main"><path d=${star(12, 12, 10)} /><path class="spark-tint" d=${star(12, 12, 10)} fill=${`url(#${id})`} /></g>
  </svg>`;
}
