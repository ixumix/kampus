// Изометрическая линейная графика: проекция, грани коробок, гравировка на крышках.
// Ось x уходит вправо-вниз, y — влево-вниз, z — вверх. Видимы крышка, грань +x и грань +y.
import { html } from "../vendor/preact-htm.js";

export const COS = Math.cos(Math.PI / 6);

export function proj(o, x, y, z = 0) {
  return [o.x + (x - y) * COS * o.s, o.y + (x + y) * 0.5 * o.s - z * o.s];
}

const f1 = (n) => (Math.round(n * 10) / 10).toString();

export function path(o, pts, close = true) {
  return pts.map((p, i) => (i ? "L" : "M") + proj(o, p[0], p[1], p[2] || 0).map(f1).join(" ")).join("") + (close ? "Z" : "");
}

// Точка экрана (в координатах SVG) → точка на земле (z = 0).
export function unproj(o, sx, sy) {
  const u = (sx - o.x) / (COS * o.s), v = (sy - o.y) / (0.5 * o.s);
  return [(u + v) / 2, (v - u) / 2];
}

export function faces(o, x, y, z, w, d, h) {
  const t = z + h;
  return {
    top: path(o, [[x, y, t], [x + w, y, t], [x + w, y + d, t], [x, y + d, t]]),
    right: path(o, [[x + w, y, t], [x + w, y + d, t], [x + w, y + d, z], [x + w, y, z]]),
    left: path(o, [[x, y + d, t], [x + w, y + d, t], [x + w, y + d, z], [x, y + d, z]]),
    sil: path(o, [[x, y, t], [x + w, y, t], [x + w, y, z], [x + w, y + d, z], [x, y + d, z], [x, y + d, t]]),
  };
}

// Коробка: грани закрашены цветом фона (скрывают линии позади), контур — тонкая линия.
export function Box({ o, x, y, z = 0, w, d, h, dashedTop, children }) {
  const f = faces(o, x, y, z, w, d, h);
  return html`<path class="f" d=${f.left} /><path class="f" d=${f.right} /><path class=${"f" + (dashedTop ? " dash" : "")} d=${f.top} />${children}`;
}

// Отрезок или ломаная гравировки на плоскости z.
export function Engrave({ o, pts, cls = "e" }) {
  return html`<path class=${cls} d=${path(o, pts, false)} />`;
}

// Координаты указателя в системе SVG.
export function svgPoint(svg, e) {
  const m = svg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}

export function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}
