// Первый вход и знакомство с кабинетом.
//
// 1. Перелёт. Три изометрические карточки с экрана входа — «Следующая пара», «Изменение», «Справка» —
//    после входа ложатся плоско и улетают на свои настоящие места на «Сегодня»: пара — в строку
//    ближайшей пары, изменение — в «С прошлого визита», справка — в готовый документ.
//    Картинка на входе оказывается самим приложением.
// 2. Знакомство. Подсветка с вырезом перетекает от блока к блоку; тексты собраны из данных аккаунта.
//    Вырез пропускает нажатия: изменение можно подтвердить прямо в подсветке.
//    Пропуск — в любой момент (Esc), повтор — из профиля или поиска. Флаг «пройдено» хранится в аккаунте.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { api, setState, state, useResource, toast, emit } from "./data.js";
import { navigate } from "./router.js";
import { CARDS, CARD_GEOM } from "./scenes.js";
import { countOf, where } from "./format.js";
import { reduced } from "./motion.js";

const EASE = "cubic-bezier(.32,.72,0,1)";
const COS = Math.cos(Math.PI / 6);

// cubic-bezier(.32,.72,0,1) для покадровой интерполяции выреза.
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 6; i++) { const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= (sx(t) - x) / d; }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
const ease = bezier(0.32, 0.72, 0, 1);

const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const first = (sels, used) => {
  for (const s of sels) { const el = document.querySelector(s); if (visible(el) && !(used && used.has(el))) return el; }
  return null;
};

// ------------------------------------------------------------------ перелёт после входа
let arrival = null;
let arrived = Promise.resolve();
export const whenArrived = () => arrived;

// Вызывается сразу после успешного входа, пока экран входа ещё на месте. Возвращает обещание:
// экран входа плавно уходит под фон, и только потом монтируется кабинет — без просвета новой страницы.
export function prepareArrival() {
  const fig = document.querySelector(".login-art .iso-cards");
  if (reduced() || !visible(fig)) return Promise.resolve();
  const layer = document.createElement("div");
  layer.className = "arrival";
  layer.setAttribute("aria-hidden", "true");
  const veil = document.createElement("div");
  veil.className = "arrival-veil";
  layer.append(veil);
  const { CW, CD, s } = CARD_GEOM;
  const ghosts = [];
  fig.querySelectorAll("[data-card]").forEach((g) => {
    const top = g.querySelectorAll("path.f")[2]; // крышка карточки (Box рисует левую, правую грань и крышку)
    if (!top) return;
    const b = top.getBoundingClientRect();
    const k = b.width / ((CW + CD) * COS * s);
    const p0 = { x: b.left + CD * COS * s * k, y: b.top };
    const w = CW * s * k, h = CD * s * k;
    const cx = p0.x + COS * (w - h) / 2, cy = p0.y + (w + h) / 4; // центр крышки на экране
    const base = CARDS.find((c) => c.id === g.dataset.card);
    // верхняя карточка листает примеры — летит тот текст, что виден сейчас
    const v = g.querySelector("[data-v]");
    const card = base.variants && v ? { ...base, ...base.variants[Number(v.dataset.v) || 0] } : base;
    const el = document.createElement("div");
    el.className = "arrival-card";
    const from = `translate(${cx - w / 2}px, ${cy - h / 2}px) rotate(30deg) skewX(-30deg) scale(1, ${COS})`;
    el.style.cssText = `--k:${k.toFixed(3)};width:${w}px;height:${h}px;transform:${from}`;
    const title = Array.isArray(card.title) ? `${card.title[0]}<s>${card.title[1]}</s>${card.title[2]}` : card.title;
    el.innerHTML = `<span class="ac-eyebrow" style="top:${CD * s * 0.29 * k}px">${card.eyebrow}</span>`
      + `<span class="ac-title" style="top:${CD * s * 0.6 * k}px">${title}</span>`
      + `<span class="ac-meta" style="top:${CD * s * 0.86 * k}px">${card.meta}</span>`;
    layer.append(el);
    ghosts.push({ id: card.id, el, w, h, cx, cy, from });
  });
  if (!ghosts.length) return Promise.resolve();
  document.body.append(layer);
  let done;
  arrived = new Promise((r) => (done = r));
  arrival = { layer, veil, ghosts, done };
  return veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).finished.catch(() => {});
}

const TARGETS = {
  next: [".lesson.is-next", ".lesson.is-now", ".tomorrow", "#day .lesson", "#day .panel"],
  change: ['#todo [data-arrive="change"]', ".lesson.is-next", ".summary-strip", "#todo"],
  // без готовой справки карточка садится на строку «Справка об обучении» в «Заказать документ», а не на всю панель
  doc: ['#todo [data-arrive="doc"]', '[aria-labelledby="order-h"] a[href="/documents/new/study_cert"]', '[aria-labelledby="order-h"] .section-title', "#todo"],
};

// Вызывается оболочкой после монтирования: ждёт данные «Сегодня» и разводит карточки по местам.
export function runArrival() {
  const a = arrival;
  if (!a) return;
  arrival = null;
  const t0 = performance.now();
  const wait = () => {
    const ready = document.querySelector(".today-grid") || location.pathname !== "/";
    if (!ready && performance.now() - t0 < 2500) { requestAnimationFrame(wait); return; }
    requestAnimationFrame(() => fly(a));
  };
  requestAnimationFrame(wait);
}

// Две фазы. 1) Стопка раскрывается: карточки в изометрии расходятся по высоте, как при наведении на фигуру входа
// (верхняя поднимается выше всех). 2) Каждая летит к своему блоку, на лету ложится плоско и принимает его размер.
// Настоящий блок проступает под карточкой в конце полёта.
function fly({ layer, veil, ghosts, done }) {
  const used = new Set();
  const DUR = 1500, OPEN = 0.3, STAGGER = 100;
  const finishers = [];
  const order = [...ghosts].reverse(); // верхняя карточка первой
  order.forEach((g, i) => {
    const target = first(TARGETS[g.id] || [], used);
    const delay = 40 + i * STAGGER;
    const lift = (order.length - 1 - i) * 30 + 12; // раскрытие: верхняя выше всех, нижняя чуть отрывается от земли
    const open = g.from.replace(/translate\(([^,]+), ([-\d.]+)px\)/, (m, x, y) => `translate(${x}, ${Number(y) - lift}px)`);
    const flat = `translate(${g.cx - g.w / 2}px, ${g.cy - g.h / 2 - lift}px) rotate(0deg) skewX(0deg) scale(1, 1)`;
    if (!target) {
      finishers.push(g.el.animate([
        { transform: g.from, opacity: 1, easing: EASE },
        { transform: open, opacity: 1, offset: 0.4, easing: "cubic-bezier(.45,0,.2,1)" },
        { transform: flat.replace("scale(1, 1)", "scale(0.96, 0.96)"), opacity: 0 },
      ], { duration: 900, delay, fill: "forwards" }).finished);
      return;
    }
    used.add(target);
    const r = target.getBoundingClientRect();
    target.style.opacity = "0";
    const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 8;
    const anim = g.el.animate([
      { transform: g.from, width: g.w + "px", height: g.h + "px", borderRadius: "0px", opacity: 1, easing: EASE },
      { transform: open, width: g.w + "px", height: g.h + "px", borderRadius: "0px", opacity: 1, offset: OPEN, easing: "cubic-bezier(.45,0,.15,1)" },
      { opacity: 1, offset: 0.86 },
      { transform: `translate(${r.left}px, ${r.top}px) rotate(0deg) skewX(0deg) scale(1, 1)`, width: r.width + "px", height: r.height + "px", borderRadius: radius + "px", opacity: 0 },
    ], { duration: DUR, delay, easing: "linear", fill: "forwards" });
    // Текст карточки гаснет до посадки: садится пустая плашка, а настоящий текст блока проступает сам.
    g.el.querySelectorAll("span").forEach((sp) => sp.animate([{ opacity: 1 }, { opacity: 1, offset: 0.52 }, { opacity: 0, offset: 0.72 }, { opacity: 0 }],
      { duration: DUR, delay, easing: "linear", fill: "forwards" }));
    const show = target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, delay: delay + DUR * 0.76, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    finishers.push(Promise.all([anim.finished, show.finished]).then(() => { target.style.opacity = ""; show.cancel(); }));
  });
  // Страница проступает, когда карточки уже легли и начали полёт.
  veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 760, delay: 40 + DUR * OPEN, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
  Promise.allSettled(finishers).then(() => { layer.remove(); done(); });
}

// ------------------------------------------------------------------ знакомство
// «Пройти снова»: главное знакомство сейчас, знакомства с разделами — снова при первом заходе в каждый.
// Запросы знакомства идут по очереди: сброс («Пройти снова») не должен обогнать отметку «пройдено» и наоборот.
let tourSync = Promise.resolve();
const tourPost = (body) => (tourSync = tourSync.then(() => api("POST", "/api/tour", body, { quiet: true })).catch(() => { /* без связи — только на этом устройстве */ }));

export function startTour() {
  const u = state.session && state.session.user;
  if (u) { u.tour_done = false; u.tours_seen = []; emit(); }
  tourPost({ reset: true });
  if (location.pathname !== "/") navigate("/");
  setState({ tour: { step: 0, page: "today" } });
}

export function autostartTour() {
  whenArrived().then(() => {
    const u = state.session && state.session.user;
    if (u && !u.tour_done && !state.tour && location.pathname === "/") setState({ tour: { step: 0, page: "today" } });
    document.documentElement.setAttribute("data-tour-ready", "");
  });
}

// ------------------------------------------------------------------ знакомство с разделами
// При первом заходе в раздел — 2–4 коротких шага по его главным элементам. Показывается один раз на аккаунт
// (флаг на сервере, отмечается в момент показа); уход в другой раздел закрывает знакомство.
export const pageOf = (path) => (path === "/" ? "today" : (path.match(/^\/(schedule|grades|documents|notifications|profile)(\/|$)/) || [])[1] || null);
const PAGE_LABEL = { today: "Знакомство", schedule: "Расписание", grades: "Оценки", documents: "Документы", notifications: "Уведомления", profile: "Профиль" };

function pageSteps(page, onlyVisible = true) {
  const phone = innerWidth < 760;
  const all = {
    schedule: [
      { id: "views", target: [".cal-toolbar .seg"], title: "День, 3 дня, неделя",
        text: phone ? "Вид переключается здесь, свайп по сетке листает дни. «Сегодня» возвращает к текущему дню."
          : "Вид — здесь или клавишами D, 3 и W. J и K листают вперёд и назад, T возвращает к сегодняшнему дню." },
      { id: "grid", target: [".cal-scroll"], title: "Свои события", // видимая часть сетки: колонка дня выше экрана
        text: phone ? "Долгое нажатие на сетке создаёт своё событие; так же его можно перенести. Касание по паре открывает её."
          : "Протяните по пустой сетке — появится своё событие. Его можно перенести и растянуть, Delete удаляет. Клавиша C создаёт событие сразу." },
      { id: "changed", target: [".cal-lesson.is-changed"], title: "Изменения в расписании",
        text: "Полоса слева — изменение, которое вы ещё не подтвердили. Пунктир «было» показывает, откуда пару перенесли." },
      { id: "export", target: [".page-cal .page-head .actions", ".cal-export-m"], title: "В свой календарь",
        text: "Экспорт показанных дней в .ics или подписка по ссылке — тогда календарь телефона будет обновляться сам." },
    ],
    grades: [
      { id: "tabs", target: [".page .toolbar .seg"], title: "Баллы, сессия, итоги",
        text: "Текущий балл — сумма уже проверенных работ, это не итоговая оценка. В «Сессии» — экзамены и допуск, в «Итогах» — прошлые семестры." },
      { id: "attention", target: ['.chips a[href*="attention"]'], title: "Требуют внимания",
        text: "Дисциплины с замечаниями — причина написана прямо в строке." },
      { id: "subject", target: [".gtable tbody tr"], title: "Дисциплина целиком",
        text: "Нажмите на строку — откроются работы, сроки и форма контроля. Все баллы можно скачать кнопкой «Баллы в CSV»." },
    ],
    documents: [
      { id: "types", target: [".doc-types"], title: "Новая заявка",
        text: "Справки и обращение в деканат. Черновик сохраняется сам — форму можно закрыть и вернуться к ней позже." },
      { id: "ready", target: ['[aria-labelledby="ready-h"]'], title: "Готово к получению",
        text: "«Скачать» и «Получено» — разные действия: скачивание само ничего не отмечает." },
      { id: "list", target: ['[aria-labelledby="all-h"]'], title: "Заявки и статусы",
        text: "Принята, в работе, готова. Принятую заявку можно отменить, завершённую — повторить в один клик." },
    ],
    notifications: [
      { id: "filters", target: [".page-ntf .toolbar"], title: "Фильтры",
        text: "Только непрочитанные или одна категория: расписание, заявки, сроки, объявления." },
      { id: "list", target: [".inbox-list"], title: "Прочитано ≠ подтверждено",
        text: "Открытие отмечает уведомление прочитанным, но изменение пары не подтверждает — это делается в самом занятии." },
    ],
    profile: [
      { id: "demo", target: ["#demo"], title: "Демо-время",
        text: "«Сейчас» кабинета — не часы компьютера. Здесь готовые моменты недели; на «Сегодня» бейдж демо-времени открывает ползунок дня." },
      { id: "calendar", target: ["#calendar"], title: "Подписка на календарь",
        text: "Секретная ссылка для Apple Календаря или Outlook: расписание обновляется само, перевыпуск гасит старую ссылку." },
      { id: "tour", target: ["#tour"], title: "Знакомства",
        text: "Главное знакомство и знакомства с разделами можно пройти снова — отсюда." },
    ],
  }[page] || [];
  return onlyVisible ? all.filter((st) => first(st.target)) : all;
}

function markPage(page) {
  const u = state.session && state.session.user;
  if (u) { u.tours_seen = [...new Set([...(u.tours_seen || []), page])]; emit(); }
  tourPost({ page, seen: true }); // без связи — покажется ещё раз
}

let pageWait = 0;
export function maybePageTour(path, blocked) {
  cancelAnimationFrame(pageWait); pageWait = 0;
  const page = pageOf(path);
  const u = state.session && state.session.user;
  if (!page || page === "today" || blocked || !u || (u.tours_seen || []).includes(page) || state.tour) return;
  whenArrived().then(() => {
    const t0 = performance.now();
    // ждём, пока раздел загрузится и проявится: без скелетов, цели шагов на месте, поверх ничего не открыто
    const tick = () => {
      if (pageOf(location.pathname) !== page || state.tour || (state.session.user.tours_seen || []).includes(page)) return;
      const busy = state.paletteOpen || document.querySelector('[aria-modal="true"]') || document.querySelector("#main .skel");
      const n = pageSteps(page).length, want = Math.min(2, pageSteps(page, false).length);
      if ((busy || n < want || performance.now() - t0 < 500) && performance.now() - t0 < 4000) { pageWait = requestAnimationFrame(tick); return; }
      if (busy || !n) return;
      markPage(page);
      setState({ tour: { step: 0, page } });
    };
    pageWait = requestAnimationFrame(tick);
  });
}

function markDone() {
  if (state.session) { state.session.user.tour_done = true; emit(); }
  tourPost({ done: true }); // без связи — тур покажется снова
}

function firstName(u) { const p = (u.full_name || "").split(" "); return p[1] || u.short_name; }

function buildSteps(d, u) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const cur = d.lessons.find((l) => l.id === d.current_id), nxt = d.lessons.find((l) => l.id === d.next_id);
  const l = cur || nxt;
  const todayIds = new Set(d.lessons.map((x) => x.id));
  // как в блоке «Нужно сделать»: изменения сегодняшних пар показаны в ленте, здесь — только остальные
  const changes = d.changes.filter((x) => !todayIds.has(x.id)).length;
  const tasks = d.tasks.filter((t) => !t.done_at).length;
  const todo = [
    changes && countOf(changes, "изменение", "изменения", "изменений"),
    d.documents.length && countOf(d.documents.length, "готовый документ", "готовых документа", "готовых документов"),
    d.answers.length && countOf(d.answers.length, "ответ деканата", "ответа деканата", "ответов деканата"),
    tasks && countOf(tasks, "срок", "срока", "сроков"),
  ].filter(Boolean);
  const list = todo.length > 1 ? todo.slice(0, -1).join(", ") + " и " + todo[todo.length - 1] : todo[0];
  const steps = [
    { id: "hello", target: null, title: `Привет, ${firstName(u)}!`,
      text: "Это Кампус: пары, изменения и документы в одном месте. Покажу главное за полминуты — на ваших данных." },
    { id: "day", target: [".lesson.is-now", ".lesson.is-next", "#day .lesson", "#day .panel"],
      title: cur ? "Пара идёт сейчас" : nxt ? "Ближайшая пара" : "Пары сегодня",
      text: l
        ? `${l.subject}, ${l.start}–${l.end}, ${where(l.room, l.building)}.${l.change && !l.change.acknowledged_at ? " Изменение видно прямо в строке: старое зачёркнуто." : ""} Нажмите на пару — откроются преподаватель, материалы и история изменений.`
        : d.lessons.some((x) => x.status !== "cancelled")
          ? "Пары на сегодня закончились. Ниже — первая пара следующего учебного дня."
          : "Сегодня пар нет — это свободный день по расписанию. Ниже — первая пара следующего учебного дня." },
    { id: "todo", target: ["#todo"], title: "Нужно сделать",
      text: todo.length
        ? `Сейчас здесь ${list}. Всё делается на месте: подтвердить, скачать, отметить. Подсветка пропускает нажатия — можно попробовать.`
        : "Сейчас дел нет. Сюда попадут изменения, готовые документы и сроки — только то, что требует действия." },
    { id: "search", target: [".search-trigger"], title: "Поиск и команды",
      text: `Пары, оценки, заявки и действия в одном поле — попробуйте «справка» или «среда». ${innerWidth < 760 ? "Открывается кнопкой с лупой." : `Открывается по ${isMac ? "⌘K" : "Ctrl+K"} или «/».`}` },
    { id: "nav", target: [".topbar .nav", ".tabbar"], title: "Разделы",
      text: "Расписание недели, оценки и сессия, документы. У каждого экрана и каждой пары своя ссылка — обновление страницы ничего не теряет." },
    { id: "profile", target: [".avatar-btn"], title: "Профиль",
      text: "Подписка на календарь, тема, установка на телефон. Отсюда же можно пройти знакомство снова." },
  ].filter(Boolean);
  return steps.filter((st) => !st.target || first(st.target));
}

export function Tour({ paused }) {
  const page = (state.tour && state.tour.page) || "today";
  const today = useResource("today", "/api/today");
  const u = state.session.user;
  const [ids, setIds] = useState(null);
  const [i, setI] = useState(0);
  const [closing, setClosing] = useState(false);
  const root = useRef(null), hole = useRef(null), ring = useRef(null), pop = useRef(null), body = useRef(null);
  const cur = useRef(null);
  const posRef = useRef(null);
  const returnFocus = useRef(document.activeElement);
  const ready = page === "today" ? !!today.data : true;
  // Список шагов фиксируется при старте; тексты пересчитываются по живым данным.
  useEffect(() => { if (ready && !ids) setIds((page === "today" ? buildSteps(today.data, u) : pageSteps(page)).map((x) => x.id)); }, [ready]);
  const all = ready ? (page === "today" ? buildSteps(today.data, u) : pageSteps(page, false)) : [];
  const steps = ids ? ids.map((id) => all.find((x) => x.id === id) || { id, target: null, title: "", text: "" }) : [];
  const step = steps[i];
  const last = i === steps.length - 1;

  const close = (skipped) => {
    if (closing) return;
    setClosing(true);
    if (page === "today") markDone();
    if (skipped) toast(page === "today" ? "Знакомство можно пройти снова — в профиле или через поиск" : "Знакомства с разделами можно пройти снова — в профиле");
    const mine = state.tour; // закрываем только своё: «Пройти снова» во время ухода уже запустило новое знакомство
    const end = () => {
      if (state.tour === mine) setState({ tour: null });
      const f = returnFocus.current;
      if (f && f.isConnected && f !== document.body) f.focus({ preventScroll: true });
    };
    if (root.current && !reduced()) root.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" }).finished.then(end, end);
    else end();
  };
  const go = (n) => {
    if (n < 0 || n >= steps.length) return;
    const el = body.current;
    if (!el || reduced()) { setI(n); return; }
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: "ease-in", fill: "forwards" }).finished.then(() => setI(n));
  };

  // Содержимое нового шага проявляется; фокус — на карточку шага.
  useEffect(() => {
    if (!step || paused) return;
    if (body.current) { body.current.getAnimations().forEach((a) => a.cancel()); if (!reduced()) body.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" }); }
    pop.current && pop.current.focus({ preventScroll: true });
  }, [i, ids, paused]);

  // Покадрово и одним движением: страница докручивается до цели, вырез перетекает к ней, карточка шага едет рядом —
  // всё по одной кривой и за одно время. Сторона карточки (снизу, сверху, сбоку) выбирается один раз на шаг —
  // по тому, где цель окажется после прокрутки, — поэтому карточка не перескакивает сверху вниз на ходу.
  useEffect(() => {
    if (!step || paused) return;
    const DUR = reduced() ? 1 : 680;
    const M = 12, E = 16, TOP = 52 + 8;
    const botOf = () => innerHeight - (innerWidth < 760 ? 60 + 8 : E);
    const padOf = (el) => (el.closest(".topbar,.tabbar") ? 4 : 6);
    const rectOf = (el, dy = 0) => {
      const b = el.getBoundingClientRect(), pad = padOf(el);
      return { x: b.left - pad, y: b.top - pad - dy, w: b.width + pad * 2, h: b.height + pad * 2 };
    };
    const pe = pop.current;
    const el0 = step.target && first(step.target);
    const pinned = el0 && !!el0.closest(".topbar,.tabbar");

    // Куда прокрутить: цель видна целиком и рядом есть место для карточки шага.
    const sy0 = scrollY;
    let sy1 = sy0;
    const sideFor = (r) => {
      const W = innerWidth, pw = pe.offsetWidth, ph = pe.offsetHeight, BOT = botOf();
      if (!r) return "center";
      if (r.y + r.h + M + ph <= BOT) return "below";
      if (r.y - M - ph >= TOP) return "above";
      if (W >= 760 && r.x + r.w + M + pw <= W - E) return "right";
      if (W >= 760 && r.x - M - pw >= E) return "left";
      return "dock";
    };
    if (el0 && !pinned) {
      const r = rectOf(el0), ph = pe.offsetHeight, BOT = botOf(), avail = BOT - TOP;
      const visibleNow = r.y >= TOP && r.y + r.h <= BOT;
      if (!(visibleNow && sideFor(r) !== "dock")) {
        let top;
        if (r.h + M + ph <= avail) top = TOP + (avail - (r.h + M + ph)) / 2; // блок и карточка под ним — по центру
        else if (r.h <= avail) top = TOP + (avail - r.h) / 2;
        else top = TOP;
        const max = document.documentElement.scrollHeight - innerHeight;
        sy1 = Math.max(0, Math.min(max, sy0 + r.y - top));
      }
    }
    let side = sideFor(el0 ? rectOf(el0, sy1 - sy0) : null);
    const onResize = () => { const el = step.target && first(step.target); side = sideFor(el ? rectOf(el) : null); };
    window.addEventListener("resize", onResize);

    const place = (r) => {
      const W = innerWidth, H = innerHeight, pw = pe.offsetWidth, ph = pe.offsetHeight, BOT = botOf();
      const clampX = (x) => Math.min(Math.max(E, x), W - pw - E), clampY = (y) => Math.min(Math.max(TOP, y), BOT - ph);
      switch (side) {
        case "below": return { x: clampX(r.x), y: clampY(r.y + r.h + M) };
        case "above": return { x: clampX(r.x), y: clampY(r.y - M - ph) };
        case "right": return { x: r.x + r.w + M, y: clampY(r.y) };
        case "left": return { x: r.x - M - pw, y: clampY(r.y) };
        case "dock": return { x: clampX((W - pw) / 2), y: BOT - ph };
        default: return { x: (W - pw) / 2, y: (H - ph) / 2 };
      }
    };

    const t0 = performance.now();
    const from = cur.current, pFrom = posRef.current;
    let raf = 0;
    const frame = (now) => {
      // Текст следующего шага уже отрисован, а этот цикл ещё не снят: не двигаем карточку по чужой высоте.
      if (pe.dataset.step !== step.id) { raf = requestAnimationFrame(frame); return; }
      const W = innerWidth, H = innerHeight;
      const p = Math.min(1, (now - t0) / DUR), e = ease(p);
      if (sy1 !== sy0 && p < 1) window.scrollTo({ top: sy0 + (sy1 - sy0) * e, behavior: "instant" });
      else if (sy1 !== sy0 && p === 1 && Math.abs(scrollY - sy1) > 0.5 && now - t0 < DUR + 40) window.scrollTo({ top: sy1, behavior: "instant" });
      const el = step.target && first(step.target);
      const goal = el ? rectOf(el) : { x: W / 2, y: H / 2, w: 0, h: 0 };
      const r = from && p < 1 ? { x: from.x + (goal.x - from.x) * e, y: from.y + (goal.y - from.y) * e, w: from.w + (goal.w - from.w) * e, h: from.h + (goal.h - from.h) * e } : goal;
      cur.current = r;
      const rad = Math.min(10, r.w / 2, r.h / 2);
      hole.current.setAttribute("d", `M0 0H${W}V${H}H0Z` + (r.w > 1 && r.h > 1
        ? `M${r.x + rad} ${r.y}H${r.x + r.w - rad}A${rad} ${rad} 0 0 1 ${r.x + r.w} ${r.y + rad}V${r.y + r.h - rad}A${rad} ${rad} 0 0 1 ${r.x + r.w - rad} ${r.y + r.h}H${r.x + rad}A${rad} ${rad} 0 0 1 ${r.x} ${r.y + r.h - rad}V${r.y + rad}A${rad} ${rad} 0 0 1 ${r.x + rad} ${r.y}Z` : ""));
      Object.entries({ x: r.x, y: r.y, width: Math.max(0, r.w), height: Math.max(0, r.h), rx: rad }).forEach(([k, v]) => ring.current.setAttribute(k, v));
      ring.current.style.opacity = r.w > 1 ? 1 : 0;
      const pos = place(goal); // от конечной цели, а не от промежуточного выреза: путь карточки без разворотов
      const q = pFrom && p < 1 ? { x: pFrom.x + (pos.x - pFrom.x) * e, y: pFrom.y + (pos.y - pFrom.y) * e } : pos;
      posRef.current = q;
      pe.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px)`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, [i, ids, paused, step && step.id]);

  useEffect(() => {
    if (paused || !ids) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(true); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (typing) return;
      if (e.key === "ArrowRight") { e.preventDefault(); last ? close(false) : go(i + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [i, ids, paused, closing]);

  if (!ids || !step) return null;
  return html`<div class=${"tour" + (paused ? " paused" : "")} ref=${root}>
    <svg class="tour-mask" aria-hidden="true"><path class="tour-dim" fill-rule="evenodd" ref=${hole} /><rect class="tour-ring" ref=${ring} /></svg>
    <div class=${"tour-pop" + (step.target ? "" : " centered")} role="dialog" aria-modal="false" aria-labelledby="tour-t" aria-describedby="tour-d" tabindex="-1" data-step=${step.id} ref=${pop}>
      <div ref=${body}>
        <div class="tour-meta"><span class="eyebrow">${PAGE_LABEL[page]} · ${i + 1} из ${steps.length}</span>
          <span class="tour-dots" aria-hidden="true">${steps.map((_, k) => html`<i class=${k === i ? "on" : k < i ? "past" : ""} />`)}</span></div>
        <h2 class="tour-title" id="tour-t">${step.title}</h2>
        <p class="tour-text" id="tour-d">${step.text}</p>
      </div>
      <div class="tour-acts">
        ${!last && html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => close(true)}>Пропустить</button>`}
        <span class="grow"></span>
        ${i > 0 && html`<button type="button" class="btn btn-sm" onClick=${() => go(i - 1)}>Назад</button>`}
        <button type="button" class="btn btn-sm btn-primary" onClick=${() => (last ? close(false) : go(i + 1))}>${i === 0 && page === "today" ? "Показать" : last ? "Готово" : "Дальше"}</button>
      </div>
    </div>
  </div>`;
}
