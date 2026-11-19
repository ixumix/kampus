// Изометрические фигуры «Кампуса» в линейной графике, отзывчивые к указателю.
// Приём взаимодействия — как в иллюстрациях Linear: слой под указателем и всё над ним поднимаются
// одним переходом (0.7 с, cubic-bezier(.32,.72,0,1), задержка между слоями), контур светлеет.
// Графика и сюжеты — свои: карточки дня, неделя, поле расписания, штамп, лоток.
// Вход проигрывается один раз; без указателя фигуры неподвижны; при reduced motion — сразу итог.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Box, COS, Engrave, faces, path, proj, svgPoint, unproj, reducedMotion } from "./iso.js";
import { useResource, useDemoNow } from "./data.js";
import { useAmbient } from "./live.js";
import { addDays, mondayOf, dayMonth, countOf } from "./format.js";

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function useHot() {
  const [hot, setHot] = useState(null);
  const enter = (id) => (e) => { if (e.pointerType === "mouse" || e.pointerType === "pen") setHot(id); };
  const tap = (id) => (e) => { if (e.pointerType === "touch") setHot((h) => (h === id ? null : id)); };
  return [hot, setHot, enter, tap];
}

// ------------------------------------------------------------------ 1. Три карточки (вход)
// Пара, изменение, документ — три плиты стопкой; текст лежит на их плоскости (изометрия).
// Наведение поднимает карточку и прочерчивает её «результат»; движение мыши даёт лёгкий параллакс.
const CW = 10, CD = 3.4, CH = 0.16, GAP = 3.3; // ширина, глубина, толщина, шаг по высоте (в единицах сетки)
export const CARD_GEOM = { CW, CD, s: 23 }; // для перелёта карточек после входа (web/src/tour.js)
export const CARDS = [
  { id: "doc", eyebrow: "Документ", title: "Справка готова", meta: "Справка об обучении · №1", check: true },
  { id: "change", eyebrow: "Изменение", title: ["Аудитория ", "412", " → 318"], meta: "Сегодня, 10:30", strike: true },
  { id: "next", eyebrow: "Следующая пара", title: "Международное право", meta: "10:30 · ауд. 318, корпус Б",
    // Верхняя карточка на экране входа сама листает примеры: кабинет показывает, что он умеет, ещё до входа.
    variants: [
      { eyebrow: "Следующая пара", title: "Международное право", meta: "10:30 · ауд. 318, корпус Б" },
      { eyebrow: "Идёт сейчас", title: "Немецкий язык", meta: "осталось 25 мин · ауд. 207" },
      { eyebrow: "Срок сегодня", title: "Эссе по ТМО", meta: "до 23:59 · «Баланс сил в XXI веке»" },
    ] },
];

// Текст карточки, который сам сменяется (variants): старый уезжает в глубину плоскости и гаснет, новый приезжает.
function CardTextCycle({ o, z, card, hot }) {
  const [x, y] = proj(o, 0, 0, z);
  const ref = useRef(null);
  const [st, setSt] = useState({ i: 0, prev: null });
  useAmbient(ref, () => setSt((p) => ({ i: (p.i + 1) % card.variants.length, prev: p.i })), { every: 4200, delay: 3600, jitter: 0 });
  const s = o.s;
  const lines = (v, cls, key) => html`<g class=${cls} key=${key}>
    <text class="ct-eyebrow" x="16" y=${(CD * s * 0.29).toFixed(1)}>${v.eyebrow}</text>
    <text class="ct-title" x="16" y=${(CD * s * 0.6).toFixed(1)}>${v.title}</text>
    <text class="ct-meta" x="16" y=${(CD * s * 0.86).toFixed(1)}>${v.meta}</text></g>`;
  return html`<g class=${"card-text" + (hot ? " hot" : "")} ref=${ref} data-v=${st.i} transform=${`matrix(0.8660254 0.5 -0.8660254 0.5 ${x.toFixed(1)} ${y.toFixed(1)})`}>
    ${st.prev != null && lines(card.variants[st.prev], "ct-out", "o" + st.prev + "-" + st.i)}
    ${lines(card.variants[st.i], st.prev != null ? "ct-in" : "", "v" + st.i)}
  </g>`;
}

function CardText({ o, z, card, hot }) {
  if (card.variants) return html`<${CardTextCycle} o=${o} z=${z} card=${card} hot=${hot} />`;
  const [x, y] = proj(o, 0, 0, z);
  const strikeRef = useRef(null);
  const textRef = useRef(null);
  const [strike, setStrike] = useState(null);
  const [titleLen, setTitleLen] = useState(null);
  useEffect(() => {
    // Зачёркивание ровно по «412» и галочка сразу после заголовка: измеряем сам текст (после загрузки шрифта).
    if (!card.strike && !card.check) return;
    const measure = () => {
      const t = textRef.current;
      if (!t) return;
      try {
        if (card.check) setTitleLen(t.getComputedTextLength());
        if (!card.strike) return;
        const start = t.getStartPositionOfChar(card.title[0].length), len = t.getSubStringLength(card.title[0].length, card.title[1].length);
        setStrike({ x1: start.x - 1, x2: start.x + len + 1, y: start.y - 5.5 });
      } catch (e) { /* текст ещё не в раскладке */ }
    };
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  }, []);
  const s = o.s;
  return html`<g class=${"card-text" + (hot ? " hot" : "")} transform=${`matrix(0.8660254 0.5 -0.8660254 0.5 ${x.toFixed(1)} ${y.toFixed(1)})`}>
    <text class="ct-eyebrow" x="16" y=${(CD * s * 0.29).toFixed(1)}>${card.eyebrow}</text>
    <text class="ct-title" x="16" y=${(CD * s * 0.6).toFixed(1)} ref=${textRef}>${Array.isArray(card.title) ? card.title.map((p, i) => html`<tspan class=${i === 1 ? "ct-old" : ""}>${p}</tspan>`) : card.title}</text>
    <text class="ct-meta" x="16" y=${(CD * s * 0.86).toFixed(1)}>${card.meta}</text>
    ${strike && html`<line class=${"ct-strike" + (hot ? " replay" : "")} key=${hot ? "s1" : "s0"} x1=${strike.x1} x2=${strike.x2} y1=${strike.y} y2=${strike.y} pathLength="1" ref=${strikeRef} />`}
    ${/* Галочка лежит на плоскости карточки, как текст: кружок в проекции — эллипс; штрихи подобраны так, что после проекции
         короткий идёт вниз-вправо, а длинный вверх-вправо — галочка читается, а не превращается в «L». */ ""}
    ${card.check && html`<g class=${"ct-check" + (hot ? " replay" : "")} key=${hot ? "c1" : "c0"}
      transform=${`translate(${(16 + (titleLen != null ? titleLen : String(card.title).length * 8.6) + 20).toFixed(1)} ${(CD * s * 0.6 - 5.5).toFixed(1)})`}>
      <circle r="10" /><path d="M-3.2 2.8 1.8 3.8 0.3 -5.8" pathLength="1" /></g>`}
  </g>`;
}

export function CardsFigure() {
  const o = { x: 174, y: 180, s: 23 };
  const [hot, setHot] = useState(null);
  const [par, setPar] = useState(0);
  const svg = useRef(null);
  const move = (e) => {
    if (e.pointerType === "touch" || reducedMotion()) return;
    const r = svg.current.getBoundingClientRect();
    setPar(Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2)));
  };
  // Порядок рисования снизу вверх: верхняя карточка перекрывает нижние.
  const zOf = (i) => i * GAP;
  const top = zOf(CARDS.length - 1) + CH;
  const corners = [[0, 0], [CW, 0], [CW, CD], [0, CD]];
  return html`<svg class="iso iso-cards" viewBox="0 0 480 360" fill="none" aria-hidden="true" ref=${svg}
      onPointerMove=${move} onPointerLeave=${() => { setHot(null); setPar(0); }}>
    <path class="g" d=${path(o, [[-0.8, -0.8], [CW + 0.8, -0.8], [CW + 0.8, CD + 0.8], [-0.8, CD + 0.8]])} />
    ${corners.map(([cx, cy], k) => html`<path class="g in-fade" style="--in:700ms" key=${"g" + k} d=${path(o, [[cx, cy, 0], [cx, cy, top]], false)} />`)}
    ${CARDS.map((c, i) => {
      const z = zOf(i), isHot = hot === c.id, dim = hot && !isHot;
      const hi = CARDS.findIndex((x) => x.id === hot);
      // Как в иллюстрациях Linear: всё, что выше наведённой карточки, поднимается и открывает её.
      const lift = hot == null ? 0 : i > hi ? -16 : isHot && hi === CARDS.length - 1 ? -8 : 0;
      return html`<g class="in-drop" style=${`--in:${i * 130}ms;--from:-34px`} key=${c.id}>
        <g class="par" style=${`transform:translateX(${(par * (i + 1) * 2.5).toFixed(2)}px)`}>
          <g class="breathe" style=${`--b:${i}`}>
          <g class=${"lift" + (isHot ? " hot" : "") + (dim ? " dim" : "")} data-card=${c.id} style=${`transform:translateY(${lift}px);--d:${hi >= 0 ? Math.max(0, i - hi - 1) * 40 : 0}ms`}>
            <${Box} o=${o} x=${0} y=${0} z=${z} w=${CW} d=${CD} h=${CH} />
            <${CardText} o=${o} z=${z + CH} card=${c} hot=${isHot} />
          </g>
          </g>
        </g>
      </g>`;
    })}
    <g class="hits">${CARDS.map((c, i) => html`<path key=${"h" + c.id} d=${faces(o, 0, 0, zOf(i), CW, CD, CH + (i < CARDS.length - 1 ? GAP - CH : 0)).sil}
      onPointerEnter=${(e) => { if (e.pointerType !== "touch") setHot(c.id); }} onPointerDown=${(e) => { if (e.pointerType === "touch") setHot((h) => (h === c.id ? null : c.id)); }} />`)}</g>
  </svg>`;
}

// ------------------------------------------------------------------ 2. Неделя (свободный день)
// Неделя по настоящему расписанию: семь плиток по диагонали, на каждой — столбик из брусков-пар
// (отменённая — пунктиром). Сегодняшняя плитка пустая, на ней солнце. Наведение (касание) приподнимает день,
// остальные тускнеют, подпись справа сверху — «Пн, 16 ноября · 4 пары · 09:00–15:30». Без указателя — сегодня.
const WT = 1, WP = 1.25, WH = 0.14, BH = 0.24, BG = 0.07, BI = 0.14; // плитка, шаг, толщина; брусок, зазор, отступ

// Солнце по демо-часам: восход в 07:00 слева, полдень впереди, закат в 21:00 справа; ночью — месяц.
// s — направление на солнце в плоскости земли (y — к зрителю), elev — высота над горизонтом (радианы).
function sunAt(iso) {
  const h = iso ? Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60 : 12;
  const t = (h - 7) / 14;
  const day = t > 0 && t < 1;
  const phi = Math.PI * (5 / 6 - (2 / 3) * Math.min(1, Math.max(0, t))); // 150° → 30°
  return { day, t, s: [Math.cos(phi), Math.sin(phi)], elev: day ? Math.max(0.12, Math.sin(Math.PI * t) * 0.95) : 0 };
}
// Тень бруска (x0..x1, y0..y1, высота h) на земле: выпуклая оболочка основания и его сдвига от солнца.
function shadowPts(x0, y0, x1, y1, h, sun) {
  const len = Math.min(2.6, h / Math.tan(sun.elev));
  const dx = -sun.s[0] * len, dy = -sun.s[1] * len;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0 + dx, y0 + dy], [x1 + dx, y0 + dy], [x1 + dx, y1 + dy], [x0 + dx, y1 + dy]];
  // оболочка (монотонная цепь)
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.slice().reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

export function WeekFigure({ today = 5, date }) {
  const o = { x: -116.9, y: 74, s: 36 }; // ряд по центру: середина недели (x 4.25, y .5) — в нуле
  const [hot, setHot, enter, tap] = useHot();
  const mon = date ? mondayOf(date) : null;
  const sched = useResource(mon ? `schedule:${mon}:${addDays(mon, 6)}` : null, mon ? `/api/schedule?from=${mon}&to=${addDays(mon, 6)}` : null).data;
  const days = WD.map((_, i) => {
    const d = sched && sched.days.find((x) => x.date === (mon && addDays(mon, i)));
    const lessons = d ? [...d.lessons].sort((a, b) => a.start.localeCompare(b.start)) : [];
    return { date: mon && addDays(mon, i), lessons, live: lessons.filter((l) => l.status !== "cancelled"), noData: d && d.state === "no_data" };
  });
  const open = hot == null ? today : hot;
  const od = days[open];
  const sub = !sched ? " "
    : od.noData ? "расписание не опубликовано"
    : !od.live.length ? (open === today ? "сегодня · пар нет" : "пар нет")
    : `${open === today ? "сегодня · " : ""}${countOf(od.live.length, "пара", "пары", "пар")} · ${od.live[0].start}–${od.live[od.live.length - 1].end}`
      + (od.lessons.length > od.live.length ? ` · ${od.lessons.length - od.live.length} отменена` : "");
  const plane = (x, y, z = 0) => { const [px, py] = proj(o, x, y, z); return `matrix(.8660254 .5 -.8660254 .5 ${px.toFixed(1)} ${py.toFixed(1)})`; };
  const tall = (i) => WH + Math.max(1, days[i].lessons.length) * (BH + BG) + 0.3;
  const sun = sunAt(useDemoNow());
  const tx = today * WP + WT / 2, ty = WT / 2; // центр сегодняшней плитки
  // Солнце висит над сегодняшней плиткой: со стороны, откуда светит, тем выше, чем выше над горизонтом.
  const sz = WH + 1.05 + (sun.day ? sun.elev * 1.1 : 0.9);
  const sunXY = sun.day ? [tx + sun.s[0] * 0.3, ty + sun.s[1] * 0.3] : [tx, ty];
  const [sx, sy] = proj(o, sunXY[0], sunXY[1], sz), [gx, gy] = proj(o, sunXY[0], sunXY[1], WH);
  return html`<svg class="iso scene scene-week" viewBox="-220 4 440 266" fill="none" aria-hidden="true">
    ${/* тени столбиков на земле — под плитками; поворачиваются вслед за солнцем */ ""}
    ${sun.day && html`<g class="week-shadows">${days.map((d, i) => d.live.length > 0 && html`<path class=${"week-shadow" + (hot != null && i !== open ? " dim" : "")} key=${"sh" + i}
      d=${path(o, shadowPts(i * WP + BI, BI, i * WP + WT - BI, WT - BI, WH + (d.lessons.map((l) => l.status !== "cancelled").lastIndexOf(true) + 1) * (BH + BG), sun).map(([x, y]) => [x, y, 0]))} />`)}</g>`}
    <g class="week-cap" transform="translate(40 26)">
      <text class="week-cap-t in-fade" key=${"t" + open} style="--in:0ms">${WD[open]}${od.date ? ", " + dayMonth(od.date) : ""}</text>
      <text class="week-cap-s in-fade" key=${"s" + open + sub} style="--in:60ms" y="18">${sub}</text>
    </g>
    ${days.map((d, i) => {
      const x0 = i * WP, isToday = i === today;
      return html`<g class=${"week-layer lift" + (i === open ? " hot" : "") + (hot != null && i !== open ? " dim" : "")} data-week-day=${i} key=${i}
        style=${`transform:translateY(${i === open && hot != null ? -6 : 0}px)`}>
        <g class="in-fade" style=${`--in:${i * 40}ms`}>
          <${Box} o=${o} x=${x0} y=${0} z=${0} w=${WT} d=${WT} h=${WH} />
          <text class=${"week-day" + (isToday ? " is-today" : "")} transform=${plane(x0 + WT / 2, WT + 0.42)} text-anchor="middle">${WD[i]}</text>

        </g>
        ${d.lessons.map((l, k) => html`<g class=${"week-block in-drop" + (l.status === "cancelled" ? " is-off" : "")} key=${l.id}
            style=${`--in:${220 + i * 50 + k * 70}ms;--from:-14px`}>
          <${Box} o=${o} x=${x0 + BI} y=${BI} z=${WH + k * (BH + BG)} w=${WT - 2 * BI} d=${WT - 2 * BI} h=${BH} dashedTop=${l.status === "cancelled"} />
        </g>`)}
      </g>`;
    })}
    ${!days[today].lessons.length && html`<g class=${"week-sky" + (sun.day ? " is-day" : " is-night")}>
      <line class="week-sky-drop" x1=${sx.toFixed(1)} y1=${(sy + 9).toFixed(1)} x2=${gx.toFixed(1)} y2=${gy.toFixed(1)} />
      <ellipse class="week-sky-spot" cx=${gx.toFixed(1)} cy=${gy.toFixed(1)} rx="5" ry="2.9" />
      <g class="week-sun" transform=${`translate(${sx.toFixed(1)} ${sy.toFixed(1)})`}>
        ${sun.day ? html`<circle r="5.4" /><g class="week-sun-rays">${Array.from({ length: 8 }, (_, n) => { const a = n * Math.PI / 4; return html`<line key=${n} x1=${(Math.cos(a) * 8.4).toFixed(2)} y1=${(Math.sin(a) * 8.4).toFixed(2)} x2=${(Math.cos(a) * 11.4).toFixed(2)} y2=${(Math.sin(a) * 11.4).toFixed(2)} />`; })}</g>`
          : html`<path class="week-moon" d="M3.2 -5.6A6.2 6.2 0 1 0 5.6 3.4 4.8 4.8 0 0 1 3.2 -5.6Z" />`}
      </g>
    </g>`}
    ${/* попадание — вертикальные полосы по экранному X: дни идут слева направо, полосы не пересекаются (в отличие от силуэтов столбиков) */ ""}
    <g class="hits week-hits" onPointerLeave=${(e) => { if (e.pointerType !== "touch") setHot(null); }}>${days.map((_, i) => {
      const band = WP * COS * o.s, cx = proj(o, i * WP + WT / 2, WT / 2)[0];
      const top = proj(o, i * WP, 0, tall(i))[1] - 4, bottom = proj(o, i * WP + WT / 2, WT + 0.42)[1] + 10;
      return html`<rect key=${i} x=${(cx - band / 2).toFixed(1)} y=${top.toFixed(1)} width=${band.toFixed(1)} height=${(bottom - top).toFixed(1)}
        onPointerEnter=${enter(i)} onPointerDown=${tap(i)} />`;
    })}</g>
  </svg>`;
}

// ------------------------------------------------------------------ 3. Поле (нет данных)
export function FieldFigure() {
  const o = { x: 120, y: 40, s: 18 };
  const N = 7;
  const svg = useRef(null);
  const dotEls = useRef([]);
  const st = useRef({ target: null, ripple: null, cur: new Float32Array((N + 1) * (N + 1)), raf: 0 });
  const pts = [];
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) pts.push([i, j]);
  useEffect(() => () => cancelAnimationFrame(st.current.raf), []);
  const loop = () => {
    const s = st.current;
    let busy = false;
    // Капля: без указателя по сетке сама расходится волна (раз в 7–10 с, «Живой интерфейс»).
    const rp = s.ripple, age = rp ? (performance.now() - rp.t0) / 1000 : 0;
    if (rp && age > 2.2) s.ripple = null; else if (rp) busy = true;
    pts.forEach(([i, j], k) => {
      let goal = 0;
      if (s.target) {
        const dd = Math.hypot(i - s.target[0], j - s.target[1]);
        goal = 14 * Math.max(0, 1 - dd / 2.6) ** 2;
      } else if (s.ripple) {
        const dd = Math.hypot(i - rp.c[0], j - rp.c[1]);
        goal = 7 * (1 - age / 2.2) * Math.exp(-((dd - age * 3.4) ** 2) / 0.5);
      }
      const c = s.cur[k] + (goal - s.cur[k]) * 0.16;
      if (Math.abs(goal - c) > 0.05) busy = true;
      s.cur[k] = Math.abs(goal - c) > 0.05 ? c : goal;
      const el = dotEls.current[k];
      if (el) { el.style.transform = `translateY(${-s.cur[k].toFixed(2)}px)`; el.style.opacity = (0.55 + s.cur[k] / 30).toFixed(2); }
    });
    s.raf = busy ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => { if (!st.current.raf && !reducedMotion()) st.current.raf = requestAnimationFrame(loop); };
  useAmbient(svg, () => {
    if (st.current.target) return; // под указателем — своя волна
    st.current.ripple = { c: [1 + Math.random() * (N - 2), 1 + Math.random() * (N - 2)], t0: performance.now() };
    kick();
  }, { every: 8500, delay: 2600 });
  const move = (e) => {
    const p = svgPoint(svg.current, e);
    if (!p) return;
    st.current.target = unproj(o, p[0], p[1]);
    kick();
  };
  return html`<svg class="iso scene" viewBox="0 0 240 176" fill="none" aria-hidden="true" ref=${svg}
      onPointerMove=${move} onPointerLeave=${() => { st.current.target = null; kick(); }}>
    <path class="g" d=${path(o, [[0, 0], [N, 0], [N, N], [0, N]])} />
    ${pts.map(([i, j], k) => {
      const [x, y] = proj(o, i, j);
      return html`<circle class="dot in-fade" style=${`--in:${(i + j) * 22}ms`} cx=${x} cy=${y} r="1.3" ref=${(el) => (dotEls.current[k] = el)} />`;
    })}
    <g class="in-drop" style="--in:500ms">
      <path class="wire" d=${faces(o, 2, 2, 1.4, 3, 3, 0.6).left} />
      <path class="wire" d=${faces(o, 2, 2, 1.4, 3, 3, 0.6).right} />
      <path class="wire" d=${faces(o, 2, 2, 1.4, 3, 3, 0.6).top} />
      <${Engrave} o=${o} cls="g" pts=${[[2, 5, 1.4], [2, 5, 0]]} />
      <${Engrave} o=${o} cls="g" pts=${[[5, 5, 1.4], [5, 5, 0]]} />
      <${Engrave} o=${o} cls="g" pts=${[[5, 2, 1.4], [5, 2, 0]]} />
    </g>
  </svg>`;
}

// ------------------------------------------------------------------ 4. Штамп (заявка принята)
export function StampFigure() {
  const o = { x: 104, y: 64, s: 22 };
  const [hot, setHot, enter] = useHot();
  const z0 = 0.12;
  const check = path(o, [[2.55, 1.95, z0], [2.95, 2.3, z0], [3.7, 1.25, z0]], false);
  return html`<svg class="iso scene iso-stamp" viewBox="0 0 220 170" fill="none" aria-hidden="true"
      onPointerEnter=${enter("s")} onPointerLeave=${() => setHot(null)}>
    <g class="in-drop"><${Box} o=${o} x=${0} y=${0} z=${0} w=${4.4} d=${3} h=${z0}>
      ${[0.7, 1.15, 1.6].map((yy, k) => html`<${Engrave} o=${o} pts=${[[0.45, yy, z0], [k === 2 ? 1.5 : 2.1, yy, z0]]} />`)}
      <path class="imprint" d=${path(o, [[2.35, 0.95, z0], [3.95, 0.95, z0], [3.95, 2.55, z0], [2.35, 2.55, z0]])} />
      <path class="check" d=${check} pathLength="1" />
    </${Box}></g>
    <g class="stamp">
      <g class="lift" style=${`transform:translateY(${hot ? -10 : 0}px)`}>
        <${Box} o=${o} x=${2.35} y=${0.95} z=${z0} w=${1.6} d=${1.6} h=${0.42} />
        <${Box} o=${o} x=${2.95} y=${1.55} z=${z0 + 0.42} w=${0.4} d=${0.4} h=${0.75} />
        <${Box} o=${o} x=${2.7} y=${1.3} z=${z0 + 1.17} w=${0.9} d=${0.9} h=${0.24} />
      </g>
    </g>
  </svg>`;
}

// ------------------------------------------------------------------ 5. Лоток (всё прочитано)
export function TrayFigure({ incoming = false }) {
  const o = { x: 110, y: 50, s: 22 };
  const [hot, setHot, enter] = useHot();
  const W = 4, D = 3, T = 0.12, H = 0.8;
  // incoming: пришло новое уведомление — сверху в лоток падает ещё одна карточка (потом откроется список)
  const cards = incoming ? [0, 1, 2, 3] : [0, 1, 2];
  return html`<svg class="iso scene" viewBox="0 0 220 170" fill="none" aria-hidden="true"
      onPointerEnter=${enter("t")} onPointerLeave=${() => setHot(null)}>
    <${Box} o=${o} x=${0} y=${0} z=${0} w=${W} d=${D} h=${0.1} />
    <${Box} o=${o} x=${0} y=${0} z=${0.1} w=${W} d=${T} h=${H} />
    <${Box} o=${o} x=${0} y=${0} z=${0.1} w=${T} d=${D} h=${H} />
    ${cards.map((i) => {
      const z = 0.12 + i * 0.13, t = z + 0.08;
      return html`<g class=${"in-drop" + (i === 3 ? " tray-new" : "")} style=${`--in:${i === 3 ? 0 : 200 + i * 140}ms;--from:${i === 3 ? -70 : -46}px`} key=${i}>
        <g class="lift" style=${`transform:translateY(${hot ? -(i + 1) * 9 : 0}px);--d:${Math.max(0, cards.length - 1 - i) * 40}ms`}>
          <${Box} o=${o} x=${0.5} y=${0.45} z=${z} w=${3} d=${2.1} h=${0.08}>
            ${i === 3 && html`<${Engrave} o=${o} pts=${[[0.85, 0.8, t], [2.1, 0.8, t]]} />`}
            ${i === 2 && !incoming && html`<path class="check on" d=${path(o, [[1.55, 1.55, t], [1.9, 1.85, t], [2.5, 1.0, t]], false)} />`}
            ${i === 2 && html`<${Engrave} o=${o} pts=${[[0.85, 0.8, t], [1.6, 0.8, t]]} />`}
          </${Box}>
        </g>
      </g>`;
    })}
    <${Box} o=${o} x=${W - T} y=${0} z=${0.1} w=${T} d=${D} h=${H} />
    <${Box} o=${o} x=${0} y=${D - T} z=${0.1} w=${W} d=${T} h=${H} />
  </svg>`;
}

// Совместимость со старыми именами.
export const GridScene = CardsFigure;
export const OrbitScene = WeekFigure;
export const ScanScene = FieldFigure;
export const FoldScene = StampFigure;
export const StackScene = TrayFigure;

// Логотип: стопка дней — залитая верхняя плита и края двух нижних.
// При наведении плиты расходятся тем же переходом, что и в фигурах (0.7 с, cubic-bezier(.32,.72,0,1)),
// при нажатии — прижимаются.
export function BrandMark({ size = 22, tick = 0 }) {
  return html`<svg class=${"brand-mark" + (tick ? " tick" + (tick % 2) : "")} width=${size} height=${size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path class="bm-plate bm-3" d="M2.5 15.25 12 20l9.5-4.75" />
    <path class="bm-plate bm-2" d="M2.5 11.5 12 16.25l9.5-4.75" />
    <path class="bm-plate bm-1 solid" d="M12 3l9.5 4.75L12 12.5 2.5 7.75Z" />
  </svg>`;
}

export function Wordmark() {
  return html`<span class="wordmark">Кампус</span>`;
}
