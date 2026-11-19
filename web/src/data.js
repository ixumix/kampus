// Данные: API-клиент, кэш ресурсов, глобальное состояние (сеть, сессия, устаревание, тосты).
//
// Правило подтверждённой записи: ответ сервера на изменение сразу вписывается во все
// кэшированные копии объекта. Последующее обновление остальных данных может упасть —
// тогда подтверждённое состояние сохраняется, а устаревшие данные помечаются отдельно.
import { useEffect, useState, useCallback } from "../vendor/preact-htm.js";

export const state = {
  session: null,        // { user, csrf, unread, meta }
  booting: true,
  offline: false,       // последний запрос не дошёл до сервера
  serverError: false,   // сервер ответил ошибкой 5xx — связь есть, это не «офлайн»
  stale: false,         // запись подтверждена, но обновление остального не удалось
  sessionExpired: false,
  toasts: [],
  paletteOpen: false,
  installPrompt: null,  // событие beforeinstallprompt, если браузер предлагает установку
  savedAt: null,        // офлайн: когда сохранены показанные данные (время устройства)
  tour: null,           // знакомство с кабинетом: { step }
  demoPreview: null,    // ползунок дня: «сейчас», пока ручку тянут (до сохранения на сервере)
};

// Сохранённые для офлайна ответы API принадлежат одному аккаунту — при выходе и входе их стираем.
export async function wipeOfflineData() {
  try { if ("caches" in window) await caches.delete("kampus-api"); } catch (e) { /* хранилище недоступно */ }
  setState({ savedAt: null });
}

const listeners = new Set();
let version = 0;
export function emit() { version++; listeners.forEach((fn) => fn(version)); }
export function setState(patch) { Object.assign(state, patch); emit(); }

// ---------------------------------------------------------------- демо-часы
// «Сейчас» кабинета: значение с сервера (demo_clock) плюс время, прошедшее в браузере, если часы идут.
// Не дальше конца того же дня — как и на сервере. Пока тянут ползунок дня — его значение.
let clockSync = { key: null, at: 0, base: 0 };
export function demoNow() {
  if (state.demoPreview) return state.demoPreview;
  const u = state.session && state.session.user;
  if (!u) return "";
  const clock = u.demo_clock || u.demo_now + ":00";
  if (clockSync.key !== clock) clockSync = { key: clock, at: Date.now(), base: Date.parse(clock + "Z") };
  const t = clockSync.base + (u.clock_running ? (Date.now() - clockSync.at) * (u.clock_speed || 1) : 0);
  const iso = new Date(t).toISOString().slice(0, 16), end = clock.slice(0, 10) + "T23:59";
  return iso > end ? end : iso;
}

// Перерисовка, когда меняется минута демо-часов (проверка раз в секунду, без лишних рендеров).
export function useDemoNow() {
  useStore();
  const [, set] = useState(0);
  const fast = fastClock();
  useEffect(() => {
    let last = demoNow();
    // «Прокрутить день»: минута проходит за доли секунды — проверяем чаще
    const id = setInterval(() => { const n = demoNow(); if (n !== last) { last = n; set((x) => x + 1); } }, fast ? 80 : 1000);
    return () => clearInterval(id);
  }, [fast]);
  return demoNow();
}

/** Часы «перематываются» (ползунок дня или «Прокрутить день»): минуты меняются без прокрутки (`Roll`). */
export function fastClock() {
  const u = state.session && state.session.user;
  return !!state.demoPreview || !!(u && u.clock_running && (u.clock_speed || 1) > 1);
}

export function useStore() {
  const [, set] = useState(0);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return state;
}

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, body, network = false) {
    super((body && body.message) || (network ? "Нет связи с сервером" : "Ошибка запроса"));
    this.status = status;
    this.code = network ? "network" : body && body.error;
    this.fields = (body && body.fields) || null;
    this.body = body || {};
    this.network = network;
  }
}

export async function api(method, url, body, { idempotencyKey, quiet } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && state.session) headers["X-CSRF-Token"] = state.session.csrf;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store" });
  } catch (e) {
    if (!quiet) setState({ offline: true });
    throw new ApiError(0, null, true);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  const saved = res.headers.get("X-Kampus-Saved");
  if (method === "GET" && !quiet) {
    if (saved && saved !== state.savedAt) setState({ savedAt: saved, offline: true });
    else if (!saved && state.savedAt) setState({ savedAt: null });
  }
  if (!saved && state.offline && res.status < 500) setState({ offline: false });
  if (res.status < 500 && state.serverError) setState({ serverError: false });
  if (res.status === 401 && url !== "/api/auth/login" && url !== "/api/session") {
    if (state.session) setState({ sessionExpired: true });
  }
  if (res.status >= 500 && !quiet && method === "GET") setState({ serverError: true });
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function newKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- cache
const cache = new Map(); // key -> { url, data, error, loading, promise }
let cacheGen = 0;         // растёт при clearCache: открытые экраны заново запрашивают свои данные, а не висят на скелетах

function entry(key, url) {
  let e = cache.get(key);
  if (!e) { e = { url, data: undefined, error: null, loading: false, promise: null }; cache.set(key, e); }
  if (url) e.url = url;
  return e;
}

export function load(key, url, { force = false } = {}) {
  const e = entry(key, url);
  if (e.promise) return e.promise;
  if (e.data !== undefined && !force) return Promise.resolve(e.data);
  e.loading = true;
  e.promise = api("GET", e.url)
    .then((d) => { e.data = d; e.error = null; return d; })
    .catch((err) => { e.error = err; throw err; })
    .finally(() => { e.loading = false; e.promise = null; emit(); });
  emit();
  return e.promise;
}

export function useResource(key, url) {
  useStore();
  const e = key ? entry(key, url) : null;
  useEffect(() => {
    if (key && e.data === undefined && !e.promise && !e.error) load(key, url).catch(() => {});
  }, [key, cacheGen]);
  const reload = useCallback(() => key && load(key, url, { force: true }).catch(() => {}), [key, url]);
  return e ? { data: e.data, error: e.error, loading: e.loading || (e.data === undefined && !e.error), reload } : { data: undefined, loading: false, reload };
}

export function peek(key) { const e = cache.get(key); return e && e.data; }

// Вписать подтверждённые данные во все кэшированные копии.
export function patchAll(fn) {
  cache.forEach((e, key) => {
    if (e.data !== undefined) {
      const next = fn(key, e.data);
      if (next !== undefined) e.data = next;
    }
  });
  emit();
}

// Обновить ресурсы после подтверждённой записи. Ошибка обновления ≠ ошибка записи.
export async function refreshAfterWrite(match) {
  const keys = [...cache.keys()].filter((k) => match.some((m) => k === m || k.startsWith(m + ":")));
  const results = await Promise.allSettled(keys.map((k) => load(k, null, { force: true })));
  const failed = results.some((r) => r.status === "rejected");
  setState({ stale: failed });
  if (!failed) refreshUnread();
  return !failed;
}

export async function refreshAll() {
  const keys = [...cache.keys()];
  const results = await Promise.allSettled(keys.map((k) => load(k, null, { force: true })));
  const failed = results.some((r) => r.status === "rejected");
  setState({ stale: failed, offline: failed ? state.offline : false, serverError: failed ? state.serverError : false });
  if (!failed) refreshUnread();
  return !failed;
}

export function clearCache() { cache.clear(); cacheGen++; emit(); }

export async function refreshUnread() {
  try {
    const s = await api("GET", "/api/session", undefined, { quiet: true });
    if (state.session) { state.session.unread = s.unread; state.session.user = s.user; emit(); }
  } catch (e) { /* не критично */ }
}

export function setUnread(n) { if (state.session && typeof n === "number") { state.session.unread = n; emit(); } }

// ---------------------------------------------------------------- toasts
let toastId = 0;
export function toast(text, { action, timeout = 5000 } = {}) {
  const id = ++toastId;
  state.toasts = [...state.toasts.slice(-2), { id, text, action }];
  emit();
  if (timeout) setTimeout(() => dismissToast(id), timeout);
  return id;
}
export function dismissToast(id) { state.toasts = state.toasts.filter((t) => t.id !== id); emit(); }

// ---------------------------------------------------------------- theme
export function applyTheme(theme) {
  const root = document.documentElement;
  const set = () => { if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme); else root.removeAttribute("data-theme"); };
  // Смена темы — короткое перетекание (View Transitions), а не мигание; без поддержки или при reduced motion — сразу.
  const changed = (root.getAttribute("data-theme") || "system") !== (theme === "light" || theme === "dark" ? theme : "system");
  if (changed && document.startViewTransition && state.session && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(set);
  else set();
  try { localStorage.setItem("kampus.theme", theme || "system"); } catch (e) { /* нет хранилища */ }
}

// ---------------------------------------------------------------- local mirror of drafts
export function localDraft(uid, type, value) {
  const k = `kampus.draft.${uid}.${type}`;
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(k) || "null");
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(value));
  } catch (e) { return null; }
  return null;
}
