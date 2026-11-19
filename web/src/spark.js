// Искра сводки: вращается сам векторный контур, без растеризации SVG-слоя.
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
  const ref = useRef(null), idRef = useRef(null), pose = useRef({ main: 0, moon: 0, scale: 1 });
  if (!idRef.current) idRef.current = "spk" + ++uid;
  const id = idRef.current;
  useLayoutEffect(() => {
    const svg = ref.current, host = svg.parentElement, mq = matchMedia("(prefers-reduced-motion: reduce)");
    const main = svg.querySelectorAll(".spark-main path"), moon = svg.querySelectorAll(".spark-moon path");
    let raf = 0;
    const draw = (p) => {
      pose.current = p;
      const m = star(10, 12.5, 8.5, .16, p.main), n = star(19, 4.75, 3.25, .2, p.moon, p.scale);
      main.forEach((el) => el.setAttribute("d", m)); moon.forEach((el) => el.setAttribute("d", n));
    };
    const animate = () => {
      cancelAnimationFrame(raf);
      if (mq.matches) { draw({ main: 0, moon: 0, scale: 1 }); return; }
      const hot = host.matches(":hover") || host.matches(":focus-visible");
      const from = { ...pose.current }, start = performance.now();
      if (Math.abs(from.main) > 180) from.main %= 90;
      const to = { main: hot ? 90 : 0, moon: hot ? -90 : 0, scale: hot ? 1.25 : 1 };
      if (!busy && Object.keys(to).every((k) => Math.abs(from[k] - to[k]) < .000001)) { draw(to); return; }
      const frame = (now) => {
        const elapsed = now - start;
        if (busy) {
          const phase = elapsed / 1600, pulse = (1 - Math.cos(phase * Math.PI * 2)) / 2;
          draw({ main: from.main + phase * 180, moon: from.moon, scale: 1 - .4 * pulse });
          raf = requestAnimationFrame(frame);
        } else {
          const t = Math.min(1, elapsed / 700), q = t === 1 ? 1 : ease(t);
          draw({ main: from.main + (to.main - from.main) * q, moon: from.moon + (to.moon - from.moon) * q, scale: from.scale + (to.scale - from.scale) * q });
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
    <g class="spark-main"><path d=${star(10, 12.5, 8.5)} /><path class="spark-tint" d=${star(10, 12.5, 8.5)} fill=${`url(#${id})`} /></g>
    <g class="spark-moon"><path d=${star(19, 4.75, 3.25, .2)} /><path class="spark-tint" d=${star(19, 4.75, 3.25, .2)} fill=${`url(#${id})`} /></g>
  </svg>`;
}
