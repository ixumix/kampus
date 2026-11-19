// Точка входа: загрузка сессии, вход, оболочка, маршруты, глобальные состояния.
import { html, render, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Icon, NavIcon } from "./icons.js";
import { useLiveScript, useMinuteTick, useRing, usePanelGlow, TimelapseBar } from "./live.js";
import { useIndicator } from "./indicator.js";
import { BrandMark, CardsFigure, Wordmark } from "./scenes.js";
import { Button, Dialog, Menu, Toasts, Field } from "./ui.js";
import { Link, navigate, useRoute, visiblePath } from "./router.js";
import { api, applyTheme, clearCache, refreshAll, setState, state, useStore, toast, wipeOfflineData } from "./data.js";
import { setPreferences } from "./actions.js";
import { initials } from "./format.js";
import { TodayPage } from "./views/today.js";
import { SchedulePage } from "./views/schedule.js";
import { LessonDrawer } from "./views/lessons.js";
import { GradesPage, SubjectDrawer } from "./views/grades.js";
import { DocumentsPage, RequestDrawer, RequestForm } from "./views/documents.js";
import { NotificationsPage } from "./views/notifications.js";
import { ProfilePage } from "./views/profile.js";
import { Palette } from "./palette.js";
import { WeekSummary } from "./views/summary.js";
import { Presence, Roll } from "./motion.js";
import { Tour, autostartTour, prepareArrival, runArrival, maybePageTour, pageOf } from "./tour.js";
import "./flip.js"; // сквозные переходы: пары между «Сегодня» и «Расписанием», название пары — в деталь

const SECTIONS = [
  { path: "/", label: "Сегодня", icon: "today" },
  { path: "/schedule", label: "Расписание", icon: "calendar" },
  { path: "/grades", label: "Оценки", icon: "grades", title: "Оценки и сессия" },
  { path: "/documents", label: "Документы", icon: "doc" },
];

function sectionOf(path) {
  const top = "/" + (path.split("/")[1] || "");
  return SECTIONS.find((s) => s.path === top) || (top === "/notifications" ? { path: top, label: "Уведомления" } : top === "/profile" ? { path: top, label: "Профиль" } : null);
}

// ------------------------------------------------------------------ routing
function parse(href) {
  const u = new URL(href, location.origin);
  return { path: u.pathname, search: u.searchParams, href: u.pathname + u.search, state: {} };
}

function matchOverlay(route) {
  const p = route.path;
  let m;
  if ((m = p.match(/^\/schedule\/lesson\/(\d+)$/))) {
    const sp = route.search;
    const parent = `/schedule?view=${sp.get("view") || "day"}${sp.get("date") ? "&date=" + sp.get("date") : ""}`;
    return { parent, el: (bgParent) => html`<${LessonDrawer} key=${"l" + m[1]} id=${m[1]} parentHref=${bgParent} />` };
  }
  if ((m = p.match(/^\/documents\/new\/(study_cert|stipend_cert|dean_appeal)$/))) {
    return { parent: "/documents", el: (bgParent) => html`<${RequestForm} key=${"f" + m[1]} type=${m[1]} parentHref=${bgParent} repeatOf=${route.search.get("from")} />` };
  }
  if ((m = p.match(/^\/documents\/(\d+)$/))) {
    return { parent: "/documents", el: (bgParent) => html`<${RequestDrawer} key=${"r" + m[1]} id=${m[1]} parentHref=${bgParent} />` };
  }
  if (p === "/summary/week") {
    return { parent: "/", el: (bgParent) => html`<${WeekSummary} key="ws" parentHref=${bgParent} />` };
  }
  if ((m = p.match(/^\/grades\/subject\/(\d+)$/))) {
    return { parent: "/grades", el: (bgParent) => html`<${SubjectDrawer} key=${"s" + m[1]} id=${m[1]} parentHref=${bgParent} />` };
  }
  return null;
}

function Page({ route }) {
  const p = route.path;
  if (p === "/") return html`<${TodayPage} route=${route} />`;
  if (p === "/schedule") return html`<${SchedulePage} route=${route} />`;
  if (p === "/grades") return html`<${GradesPage} route=${route} />`;
  if (p === "/documents") return html`<${DocumentsPage} route=${route} />`;
  if (p === "/notifications") return html`<${NotificationsPage} route=${route} />`;
  if (p === "/profile") return html`<${ProfilePage} route=${route} />`;
  return html`<div class="notfound page">
    <h1 class="h1" tabindex="-1" data-page-title>Страница не найдена</h1>
    <p class="meta-2" style="margin:8px 0 16px">Адрес <code>${p}</code> не относится к кабинету. Возможно, ссылка устарела.</p>
    <${Link} class="btn btn-primary" href="/">На главную</${Link}>
  </div>`;
}

// -------------------------------------------------------------------- shell
function NavTabs({ current }) {
  const [ref, indicator] = useIndicator(current, '[aria-current="page"]');
  return html`<nav class="nav" aria-label="Разделы" ref=${ref}>
    ${SECTIONS.map((s) => html`<${Link} href=${s.path} aria-current=${current === s.path ? "page" : undefined}><${NavIcon} name=${s.icon} size=${15} />${s.label}</${Link}>`)}
    <span class="nav-ind" ref=${indicator} aria-hidden="true"></span>
  </nav>`;
}

function AccountMenu({ user }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  const theme = user.theme;
  const setTheme = async (t) => {
    applyTheme(t);
    try { await setPreferences({ theme: t }); } catch (e) { toast("Тема применена, но не сохранена на сервере"); }
  };
  return html`<div style="position:relative">
    <button class="avatar-btn" ref=${btn} aria-haspopup="menu" aria-expanded=${open ? "true" : "false"} aria-label=${`Аккаунт: ${user.short_name}`} onClick=${() => setOpen(!open)}>
      <span class="avatar" aria-hidden="true">${initials(user.short_name)}</span></button>
    ${open && html`<${Menu} anchor=${btn.current} onClose=${() => setOpen(false)} label="Аккаунт">
      <div class="menu-label">${user.full_name}<br />группа ${user.group_name}</div>
      <${Link} class="menu-item" role="menuitem" href="/profile" onClick=${() => setOpen(false)}><${Icon} name="user" />Профиль и настройки</${Link}>
      <div class="menu-sep"></div>
      <div class="menu-label">Тема</div>
      ${[["system", "Системная", "system"], ["light", "Светлая", "sun"], ["dark", "Тёмная", "moon"]].map(([v, l, i]) => html`
        <button class="menu-item" role="menuitemradio" aria-checked=${theme === v ? "true" : "false"} onClick=${() => setTheme(v)}><${Icon} name=${i} />${l}${theme === v && html`<span class="check"><${Icon} name="check" /></span>`}</button>`)}
      <div class="menu-sep"></div>
      <button class="menu-item" role="menuitem" onClick=${logout}><${Icon} name="logout" />Выйти</button>
    </${Menu}>`}
  </div>`;
}

async function logout() {
  try { await api("POST", "/api/auth/logout", {}); } catch (e) { /* сессия и так недействительна */ }
  await wipeOfflineData();
  clearCache();
  setState({ session: null, sessionExpired: false, stale: false, offline: false, serverError: false });
  navigate("/login", { replace: true });
}

function Topbar({ current }) {
  const s = useStore();
  const user = s.session.user;
  const unread = s.session.unread;
  const ring = useRing(unread);
  const tick = useMinuteTick(); // логотип «тикает» на смене минуты демо-часов
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  return html`<header class="topbar"><div class="topbar-in">
    <${Link} class="brand" href="/" aria-label="Кампус — на главную"><${BrandMark} tick=${tick} /><span class="brand-name"><${Wordmark} /></span></${Link}>
    <${NavTabs} current=${current} />
    <span class="spacer"></span>
    <button class="search-trigger" onClick=${() => setState({ paletteOpen: true })} aria-label="Поиск по кабинету" aria-keyshortcuts=${isMac ? "Meta+K" : "Control+K"}>
      <${Icon} name="search" /><span>Поиск</span><span class="kbd">${isMac ? "⌘" : "Ctrl"}</span><span class="kbd">K</span></button>
    <${Link} class="icon-btn" href="/notifications" aria-current=${current === "/notifications" ? "page" : undefined}
      aria-label=${unread ? `Уведомления: ${unread} непрочитанных` : "Уведомления"}><${NavIcon} key=${"bell" + ring} name="bell" cls=${ring ? "ring" : ""} /><${Presence} show=${unread > 0} axis="xy" inline><span class="badge" aria-hidden="true"><${Roll} value=${unread} /></span></${Presence}></${Link}>
    <${AccountMenu} user=${user} />
  </div></header>`;
}

function TabBar({ current }) {
  return html`<nav class="tabbar" aria-label="Разделы">
    ${SECTIONS.map((s) => html`<${Link} href=${s.path} aria-current=${current === s.path ? "page" : undefined}><${NavIcon} name=${s.icon} size=${20} /><span>${s.label}</span></${Link}>`)}
  </nav>`;
}

function GlobalBanners() {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const retry = async () => { setBusy(true); const ok = await refreshAll(); setBusy(false); if (ok) toast("Данные обновлены"); };
  if (!s.offline && !s.stale && !s.serverError) return null;
  return html`<div class="global-banners" role="status">
    ${s.offline && html`<div class="banner banner-strong"><${Icon} name="wifiOff" /><span class="grow"><b>Нет связи с сервером.</b> ${s.savedAt
      ? html`Показаны данные, сохранённые на устройстве ${savedText(s.savedAt)}.` : ""} Изменения не отправляются.</span>
      <${Button} size="sm" icon="refresh" busy=${busy} onClick=${retry}>Повторить</${Button}></div>`}
    ${!s.offline && s.serverError && html`<div class="banner banner-strong"><${Icon} name="alert" /><span class="grow"><b>Сервер временно не отвечает.</b> Попробуйте ещё раз через минуту.</span>
      <${Button} size="sm" icon="refresh" busy=${busy} onClick=${retry}>Повторить</${Button}></div>`}
    ${!s.offline && !s.serverError && s.stale && html`<div class="banner banner-dashed"><${Icon} name="info" /><span class="grow"><b>Действие сохранено.</b> Обновить остальные данные не удалось — они могут быть устаревшими.</span>
      <${Button} size="sm" icon="refresh" busy=${busy} onClick=${retry}>Обновить</${Button}></div>`}
  </div>`;
}

function savedText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getDate()}.${p(d.getMonth() + 1)} в ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function SessionExpired() {
  const s = useStore();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!s.sessionExpired) return null;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await api("POST", "/api/auth/login", { login: s.session.user.login, password });
      setState({ session: res, sessionExpired: false });
      setPassword("");
      refreshAll();
      toast("Вы снова вошли. Открытая страница и черновики сохранены.");
    } catch (e2) { setErr(e2.network ? "Нет связи с сервером" : e2.message); }
    setBusy(false);
  };
  return html`<${Dialog} title="Сессия истекла" subtitle="Войдите снова — открытая страница и черновики форм сохранятся." onClose=${() => {}} closable=${false} z=${90} size="dialog-sm" labelId="expired-title">
    <form onSubmit=${submit} id="relogin">
      ${err && html`<div class="banner banner-strong" role="alert" style="margin-bottom:12px"><${Icon} name="alert" /><span class="grow">${err}</span></div>`}
      <${Field} id="re-login" label="Логин"><input class="input" id="re-login" value=${s.session.user.login} readonly /></${Field}>
      <${Field} id="re-pass" label="Пароль"><input class="input" id="re-pass" type="password" autocomplete="current-password" value=${password} data-autofocus
        onInput=${(e) => setPassword(e.target.value)} required /></${Field}>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <${Button} kind="primary" type="submit" busy=${busy}>Войти</${Button}>
        <${Button} kind="ghost" onClick=${logout}>Выйти из кабинета</${Button}>
      </div>
    </form>
  </${Dialog}>`;
}

function Shell() {
  const route = useRoute();
  const s = useStore();
  const overlay = matchOverlay(route);
  const bgHref = overlay ? (route.state.overlay && route.state.bg) || overlay.parent : null;
  const base = overlay ? parse(bgHref) : route;
  const section = sectionOf(base.path);
  const current = section ? section.path : null;
  const firstRender = useRef(true);
  const lastSection = useRef(current);
  // Направленный переход: раздел правее в навигации въезжает справа, левее — слева.
  const ORDER = ["/", "/schedule", "/grades", "/documents", "/notifications", "/profile"];
  const dirRef = useRef({ path: base.path, sec: current, dir: "" });
  if (dirRef.current.path !== base.path) {
    const a = ORDER.indexOf(dirRef.current.sec), b = ORDER.indexOf(current);
    dirRef.current = { path: base.path, sec: current, dir: a >= 0 && b >= 0 && a !== b ? (b > a ? "dir-fwd" : "dir-back") : "" };
  }

  useEffect(() => {
    const sec = sectionOf(visiblePath(route));
    document.title = (sec ? (sec.title || sec.label) + " — " : "") + "Кампус";
    if (firstRender.current) { firstRender.current = false; return; }
    if (!overlay && lastSection.current !== current) {
      requestAnimationFrame(() => { const h = document.querySelector("[data-page-title]"); h && h.focus({ preventScroll: true }); });
    }
    lastSection.current = current;
  }, [route.href]);

  // Шапка полупрозрачная; волосяная граница появляется, когда под ней есть прокрученный контент.
  useEffect(() => {
    let raf = 0;
    const sync = () => { raf = 0; document.documentElement.toggleAttribute("data-scrolled", window.scrollY > 2); };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(sync); };
    sync();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); document.documentElement.removeAttribute("data-scrolled"); };
  }, []);

  // Первый вход: карточки с экрана входа долетают до своих мест, затем — знакомство (если не пройдено).
  useEffect(() => { runArrival(); autostartTour(); }, []);
  // «Живой» сценарий демо: события наступают по демо-часам (уведомление, готовая справка).
  useLiveScript();
  // Подсветка контура панели за указателем (мышь).
  usePanelGlow();
  // Первый заход в раздел — его короткое знакомство; уход в другой раздел закрывает знакомство с прежним.
  useEffect(() => {
    const t = state.tour;
    if (t && t.page && t.page !== "today" && pageOf(base.path) !== t.page) setState({ tour: null });
    maybePageTour(base.path, !!overlay);
  }, [base.path, !!overlay]);

  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setState({ paletteOpen: !state.paletteOpen }); }
      else if (e.key === "/" && !typing && !document.querySelector('[aria-modal="true"]')) { e.preventDefault(); setState({ paletteOpen: true }); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return html`<div class="shell">
    <a class="skip-link" href="#main">К содержимому</a>
    <${Topbar} current=${current} />
    <main class=${"main " + dirRef.current.dir} id="main" tabindex="-1">
      <${GlobalBanners} />
      <${Page} key=${base.path} route=${base} />
    </main>
    <${TabBar} current=${current} />
    ${overlay && overlay.el(bgHref)}
    ${s.paletteOpen && html`<${Palette} onClose=${() => setState({ paletteOpen: false })} />`}
    ${s.tour && html`<${Tour} key=${s.tour.page || "today"} paused=${!!overlay || pageOf(base.path) !== (s.tour.page || "today") || s.paletteOpen || s.sessionExpired} />`}
    <${SessionExpired} />
    <${TimelapseBar} />
    <${Toasts} />
  </div>`;
}

// -------------------------------------------------------------------- login
const DEMO = [
  { login: "belova", password: "kampus-anna", name: "Анна Белова", meta: "2 курс · Международные отношения · 2МО-3" },
  { login: "galiev", password: "kampus-timur", name: "Тимур Галиев", meta: "3 курс · Экономика · 3ЭК-1" },
];

function Login() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(null);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const errRef = useRef(null);
  useEffect(() => { document.title = "Вход — Кампус"; }, []);
  const submit = async (e) => {
    e.preventDefault();
    const f = {};
    if (!login.trim()) f.login = "Введите логин";
    if (!password) f.password = "Введите пароль";
    setFields(f);
    if (Object.keys(f).length) { setErr(null); document.getElementById(f.login ? "login" : "password").focus(); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api("POST", "/api/auth/login", { login, password });
      await wipeOfflineData();
      await prepareArrival();
      applyTheme(res.user.theme);
      setState({ session: res, offline: false });
      const next = new URLSearchParams(location.search).get("next");
      navigate(next && next.startsWith("/") && !next.startsWith("//") && next !== "/login" ? next : "/", { replace: true });
    } catch (e2) {
      setErr(e2.network ? "Нет связи с сервером. Проверьте, что сервер запущен." : e2.message);
      setBusy(false);
      requestAnimationFrame(() => errRef.current && errRef.current.focus());
    }
  };
  const fill = (a) => { setLogin(a.login); setPassword(a.password); setFields({}); setErr(null); document.getElementById("password").focus(); };
  return html`<div class="login">
    <div class="login-form">
      <div class="brand brand-login"><${BrandMark} size=${26} /><${Wordmark} /></div>
      <div><h1 class="display">Вход в кабинет</h1><p class="meta-2" style="margin-top:6px">Пары, изменения и документы — в одном месте.</p></div>
      <form onSubmit=${submit} noValidate>
        ${err && html`<div class="banner banner-strong" role="alert" tabindex="-1" ref=${errRef}><${Icon} name="alert" /><span class="grow">${err}</span></div>`}
        <${Field} id="login" label="Логин" error=${fields.login}>
          <input class="input" id="login" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value=${login}
            aria-invalid=${fields.login ? "true" : undefined} aria-describedby=${fields.login ? "login-err" : undefined} onInput=${(e) => setLogin(e.target.value)} /></${Field}>
        <${Field} id="password" label="Пароль" error=${fields.password}>
          <div class="input-group">
            <input class="input" id="password" name="password" type=${show ? "text" : "password"} autocomplete="current-password" value=${password} style="padding-right:40px"
              aria-invalid=${fields.password ? "true" : undefined} aria-describedby=${fields.password ? "password-err" : undefined} onInput=${(e) => setPassword(e.target.value)} />
            <${Button} kind="ghost" icon=${show ? "eyeOff" : "eye"} aria-label=${show ? "Скрыть пароль" : "Показать пароль"} aria-pressed=${show ? "true" : "false"} onClick=${() => setShow(!show)} />
          </div></${Field}>
        <${Button} kind="primary" size="lg" type="submit" busy=${busy} cls="btn-block">Войти</${Button}>
      </form>
      <section class="demo-accounts" aria-labelledby="demo-h">
        <h2 class="eyebrow" id="demo-h">Демо-доступ · данные вымышлены</h2>
        ${DEMO.map((a) => html`<button type="button" class="demo-acc" onClick=${() => fill(a)} aria-label=${`Подставить демо-аккаунт: ${a.name}`}>
          <span class="avatar" aria-hidden="true">${initials(a.name)}</span>
          <span class="body"><span class="h3" style="display:block">${a.name}</span><span class="small">${a.meta}</span><br /><code>${a.login} / ${a.password}</code></span>
          <${Icon} name="arrowRight" /></button>`)}
      </section>
      <p class="small" style="max-width:380px">Неофициальный учебный проект для MGIMO AI Challenge 2026. Не связан с информационными системами вуза; документы — демонстрационные образцы.</p>
    </div>
    <div class="login-art"><${CardsFigure} /><p class="caption">Демо-неделя 16–22 ноября 2026</p></div>
  </div>`;
}

// --------------------------------------------------------------------- root
function App() {
  const s = useStore();
  const route = useRoute();
  useEffect(() => {
    api("GET", "/api/session", undefined, { quiet: true })
      .then((res) => { applyTheme(res.user.theme); setState({ session: res, booting: false }); if (location.pathname === "/login") navigate("/", { replace: true }); })
      .catch((e) => {
        setState({ booting: false, offline: e.network });
        if (location.pathname !== "/login") navigate("/login" + (location.pathname !== "/" ? "?next=" + encodeURIComponent(location.pathname + location.search) : ""), { replace: true });
      });
  }, []);
  if (s.booting) return html`<div class="boot" aria-busy="true"></div>`;
  if (!s.session || route.path === "/login") {
    if (s.session && route.path === "/login") { navigate("/", { replace: true }); return null; }
    return html`<${Login} />`;
  }
  return html`<${Shell} />`;
}

// Офлайн и установка: service worker кэширует оболочку и открытые данные (см. web/sw.js).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => { /* офлайн просто недоступен */ }); });
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); setState({ installPrompt: e }); });
window.addEventListener("appinstalled", () => setState({ installPrompt: null }));
window.addEventListener("online", () => { if (state.offline) refreshAll(); });

render(html`<${App} />`, document.getElementById("app"));
