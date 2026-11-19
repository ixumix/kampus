// Маршрутизация на History API. Состояние экрана (дата, вид, фильтр, выбранный объект) — в URL.
import { html, useEffect, useState } from "../vendor/preact-htm.js";

const subs = new Set();
function current() { return { path: location.pathname, search: new URLSearchParams(location.search), href: location.pathname + location.search, state: history.state || {} }; }

// «Видимая» страница: для оверлея — страница под ним. Прокрутка сбрасывается только при смене раздела.
export function visiblePath(r) { return r.state.overlay && r.state.bg ? r.state.bg.split("?")[0] : r.path; }
let lastVisible = visiblePath(current());
// Слушатели «до смены экрана»: DOM ещё старый (сквозные переходы снимают положение блоков). (прежняя видимая страница, новый маршрут)
export const beforeRoute = new Set();
function notify() {
  const r = current();
  const v = visiblePath(r);
  beforeRoute.forEach((fn) => { try { fn(lastVisible, r); } catch (e) { /* переход — украшение, навигацию не ломает */ } });
  const changed = v.split("/")[1] !== lastVisible.split("/")[1];
  lastVisible = v;
  subs.forEach((fn) => fn(r));
  if (changed) window.scrollTo(0, 0);
}
window.addEventListener("popstate", notify);

export function navigate(href, { replace = false, state = {} } = {}) {
  const prev = history.state || {};
  const st = { ...state, inApp: true, depth: (prev.depth || 0) + (replace ? 0 : 1) };
  // Оверлей (деталь, форма) помнит страницу под собой, чтобы показать её фоном и вернуться к ней.
  if (st.overlay) st.bg = prev.overlay ? prev.bg : location.pathname + location.search;
  if (replace) history.replaceState(st, "", href);
  else history.pushState(st, "", href);
  notify();
}

// Закрыть вложенный экран (деталь). Если открыт изнутри приложения — шаг назад,
// чтобы Back не открывал его снова; при прямом входе — замена на родительский адрес.
export function closeTo(parentHref) {
  if (history.state && history.state.inApp && history.state.overlay) history.back();
  else navigate(parentHref, { replace: true });
}

export function useRoute() {
  const [r, set] = useState(current);
  useEffect(() => { subs.add(set); return () => subs.delete(set); }, []);
  return r;
}

export function withParams(path, params) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") sp.set(k, v); });
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

function onLinkClick(e, href, replace, overlay, onClick) {
  if (onClick) onClick(e);
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(href, { replace, state: overlay ? { overlay: true, keepScroll: true } : {} });
}

export function Link({ href, replace, overlay, onClick, children, ...rest }) {
  return html`<a href=${href} onClick=${(e) => onLinkClick(e, href, replace, overlay, onClick)} ...${rest}>${children}</a>`;
}
