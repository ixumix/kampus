// Сквозные переходы (общий элемент, приём перелёта после входа — внутри приложения).
// 1) «Сегодня» ↔ «Расписание»: строки сегодняшних пар отрываются от ленты и ложатся в колонку дня
//    календаря, принимая размер и скругление блоков; назад — так же в обратную сторону.
// 2) Клик по паре: её название перелетает в заголовок открывающейся детали.
// Снимок берётся в роутере до смены страницы (beforeRoute), поэтому работает и для ссылок, и для «Назад».
// Призраки — копии, настоящие блоки проступают под ними в конце полёта. При reduced motion переходов нет.
import { beforeRoute, visiblePath } from "./router.js";
import { reduced } from "./motion.js";

const EASE = "cubic-bezier(.32,.72,0,1)";
const DUR = 460, STAGGER = 30, WAIT = 700;
const SEL = { today: "#day .lesson[data-lesson]", cal: ".cal-col.is-today .cal-lesson[data-lesson]" };
const TARGET = { today: "#day .lesson", cal: ".cal-lesson" };
const kindOf = (p) => (p === "/" ? "today" : p.startsWith("/schedule") ? "cal" : null);

let flights = [];
function stopAll() { flights.forEach((f) => f.stop()); flights = []; }

// Видимая часть: под шапкой, над нижней панелью телефона, внутри прокрутки календаря.
function onScreen(el, r = el.getBoundingClientRect()) {
  const bar = document.querySelector(".topbar");
  const tab = document.querySelector(".tabbar");
  let lo = bar ? bar.getBoundingClientRect().bottom : 0;
  let hi = tab && getComputedStyle(tab).display !== "none" ? tab.getBoundingClientRect().top : innerHeight;
  const sc = el.closest(".cal-scroll");
  if (sc) { const s = sc.getBoundingClientRect(); lo = Math.max(lo, s.top); hi = Math.min(hi, s.bottom); }
  return r.width > 4 && r.height > 4 && r.bottom > lo + 8 && r.top < hi - 8 && r.right > 0 && r.left < innerWidth;
}

// Внешний вид плашки: фон, контур (одна внутренняя тень — чтобы интерполировалась), скругление, прозрачность.
function look(el, kind) {
  const cs = getComputedStyle(el);
  const line = kind === "cal"
    ? (cs.boxShadow === "none" ? "transparent" : getComputedStyle(document.documentElement).getPropertyValue("--line-strong").trim() || "transparent")
    : cs.borderTopColor;
  return { bg: cs.backgroundColor, shadow: `inset 0 0 0 1px ${line}`, radius: (parseFloat(cs.borderTopLeftRadius) || 8) + "px", opacity: cs.opacity };
}

function layer(top) {
  const l = document.createElement("div");
  l.className = "flight" + (top ? " is-top" : "");
  l.setAttribute("aria-hidden", "true");
  document.body.append(l);
  return l;
}

// Страница-приёмник проявляется без сдвига на 4 px: иначе цель уезжала бы из-под садящейся плашки.
function calmPageIn() {
  const pg = document.querySelector("#main > .page, #main .page");
  if (!pg) return;
  pg.getAnimations().forEach((a) => {
    if (!String(a.animationName).startsWith("page-in")) return;
    const o = +getComputedStyle(pg).opacity;
    a.cancel();
    pg.animate([{ opacity: o }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  });
}

// ---------------------------------------------------------------- «Сегодня» ↔ «Расписание»
function capturePages(from, to) {
  const items = [];
  document.querySelectorAll(SEL[from]).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (items.length >= 8 || !onScreen(el, r)) return;
    items.push({ id: el.dataset.lesson, el, r, look: look(el, from) });
  });
  if (!items.length) return;
  const root = layer(false);
  items.forEach((it) => {
    const g = document.createElement("div");
    g.className = "flight-card";
    g.style.cssText = `width:${it.r.width}px;height:${it.r.height}px;transform:translate(${it.r.left}px,${it.r.top}px);`
      + `border-radius:${it.look.radius};background-color:${it.look.bg};box-shadow:${it.look.shadow}`;
    const c = it.el.cloneNode(true);
    c.removeAttribute("href"); c.removeAttribute("aria-label"); c.removeAttribute("data-lesson");
    c.querySelectorAll(".sr-only").forEach((x) => x.remove());
    c.style.cssText = `position:absolute;left:0;top:0;width:${it.r.width}px;height:${it.r.height}px;margin:0;opacity:1;`
      + "background:transparent;box-shadow:none;border-color:transparent;transform:none;animation:none;transition:none";
    g.append(c);
    root.append(g);
    it.g = g; it.c = c;
  });
  const shown = [];
  let raf = 0, done = false;
  const finish = () => {
    if (done) return; done = true;
    cancelAnimationFrame(raf);
    root.remove();
    shown.forEach(({ t, a }) => { a.cancel(); t.style.opacity = ""; });
    flights = flights.filter((f) => f !== flight);
  };
  const flight = { stop: finish };
  flights.push(flight);

  const t0 = performance.now();
  let calmed = false;
  const tick = () => {
    const waited = performance.now() - t0;
    if (items.some((it) => it.el.isConnected) && waited < WAIT) { raf = requestAnimationFrame(tick); return; }
    if (!calmed) { calmed = true; calmPageIn(); }
    const found = items.map((it) => {
      const t = document.querySelector(`${TARGET[to]}[data-lesson="${it.id}"]`);
      return t && onScreen(t) ? t : null;
    });
    if (found.some((t) => !t) && waited < WAIT) { raf = requestAnimationFrame(tick); return; }
    launch(found);
  };
  const launch = (found) => {
    const runs = [];
    items.forEach((it, i) => {
      const t = found[i], delay = i * STAGGER;
      if (!t) { // цели нет (другая неделя, не загрузилось) — плашка гаснет на месте
        runs.push(it.g.animate([{ opacity: 1 }, { opacity: 0, transform: `translate(${it.r.left}px,${it.r.top + 6}px)` }],
          { duration: 200, delay, easing: "ease-out", fill: "forwards" }).finished);
        return;
      }
      const R = t.getBoundingClientRect(), end = look(t, to);
      t.style.opacity = "0";
      runs.push(it.g.animate([
        { transform: `translate(${it.r.left}px,${it.r.top}px)`, width: it.r.width + "px", height: it.r.height + "px",
          borderRadius: it.look.radius, backgroundColor: it.look.bg, boxShadow: it.look.shadow },
        { transform: `translate(${R.left}px,${R.top}px)`, width: R.width + "px", height: R.height + "px",
          borderRadius: end.radius, backgroundColor: end.bg, boxShadow: end.shadow },
      ], { duration: DUR, delay, easing: EASE, fill: "forwards" }).finished);
      // текст копии гаснет на лету: садится пустая плашка, настоящий блок проступает под ней
      it.c.animate([{ opacity: 1 }, { opacity: 1, offset: 0.12 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], { duration: DUR, delay, fill: "forwards" });
      it.g.animate([{ opacity: 1 }, { opacity: 1, offset: 0.72 }, { opacity: 0 }], { duration: DUR, delay, fill: "forwards" });
      const a = t.animate([{ opacity: 0 }, { opacity: end.opacity }], { duration: DUR * 0.42, delay: delay + DUR * 0.58, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
      shown.push({ t, a });
      runs.push(a.finished);
    });
    Promise.allSettled(runs).then(finish);
  };
  raf = requestAnimationFrame(tick);
}

beforeRoute.add((prevVisible, r) => {
  stopAll();
  if (reduced()) return;
  // Деталь пары: название не перелетает — шторка въезжает справа уже со своим заголовком (просьба пользователя, 22 ноября).
  if (r.state.overlay) return;
  const a = kindOf(prevVisible), b = kindOf(visiblePath(r));
  if (a && b && a !== b && !r.state.overlay) capturePages(a, b);
});
