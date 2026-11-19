// Общая геометрия плашек: выбор анимируется, изменение ширины применяется до отрисовки.
// Анимируем left, а не SVG/композитный transform: в конце не меняется способ сглаживания рамки.
import { useLayoutEffect, useRef } from "../vendor/preact-htm.js";

export function useIndicator(selection, selector, content = "") {
  const track = useRef(null), indicator = useRef(null);
  const selected = useRef(selector), update = useRef(null);
  selected.current = selector;
  useLayoutEffect(() => {
    const root = track.current, marker = indicator.current;
    let last = null, animation = null, disposed = false;
    const measure = (animate = false) => {
      if (disposed) return;
      const item = root.querySelector(selected.current);
      if (!item || !root.getClientRects().length || !item.getClientRects().length) {
        marker.style.visibility = "hidden"; last = null; return;
      }
      const r = root.getBoundingClientRect(), b = item.getBoundingClientRect();
      const next = { x: b.left - r.left - root.clientLeft + root.scrollLeft, w: b.width };
      marker.style.visibility = "visible";
      if (last && Math.abs(next.x - last.x) < .01 && Math.abs(next.w - last.w) < .01) return;
      const current = getComputedStyle(marker);
      const from = { left: current.left, width: current.width };
      if (animation) animation.cancel();
      marker.style.left = next.x + "px";
      marker.style.width = next.w + "px";
      if (animate && last && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        animation = marker.animate([from, { left: next.x + "px", width: next.w + "px" }],
          { duration: 320, easing: "cubic-bezier(.22,.8,.2,1)" });
      }
      last = next;
    };
    update.current = measure;
    measure();
    const resize = () => measure(false);
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    [...root.children].filter(el => el !== marker).forEach(el => observer.observe(el));
    window.addEventListener("resize", resize);
    if (document.fonts) document.fonts.ready.then(resize);
    return () => {
      disposed = true; observer.disconnect(); window.removeEventListener("resize", resize);
      if (animation) animation.cancel(); update.current = null;
    };
  }, []);
  useLayoutEffect(() => { if (update.current) update.current(true); }, [selection, content]);
  return [track, indicator];
}
