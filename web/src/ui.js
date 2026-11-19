// Компоненты системы: кнопки, сегменты, диалог, панель, меню, тосты, пустые состояния.
import { html, useEffect, useLayoutEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Icon } from "./icons.js";
import { useIndicator } from "./indicator.js";
import { state, dismissToast, useStore } from "./data.js";
import { AnimatedList, Presence, Roll } from "./motion.js";

export function Spinner() {
  return html`<svg class="spinner" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

export function Button({ kind = "", size = "", icon, iconRight, busy, children, cls = "", ...rest }) {
  const c = ["btn", kind && "btn-" + kind, size && "btn-" + size, !children && "btn-icon", cls].filter(Boolean).join(" ");
  return html`<button type="button" class=${c} aria-busy=${busy ? "true" : undefined} ...${rest} disabled=${rest.disabled || busy}>
    ${busy ? html`<${Spinner} />` : icon && html`<${Icon} name=${icon} />`}${children}${iconRight && html`<${Icon} name=${iconRight} />`}</button>`;
}

// Сегментированный переключатель со скользящим индикатором (transform, 260 мс).
export function Segmented({ options, value, onChange, label, role = "radiogroup" }) {
  const [ref, indicator] = useIndicator(value, '[aria-checked="true"]', options.map(o => o.label).join());
  const keydown = (e) => {
    const i = options.findIndex((o) => o.value === value);
    let n = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % options.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + options.length) % options.length;
    if (n >= 0) { e.preventDefault(); onChange(options[n].value); requestAnimationFrame(() => ref.current.querySelector(`[data-v="${options[n].value}"]`)?.focus()); }
  };
  return html`<div class="seg" ref=${ref} role=${role} aria-label=${label} onKeyDown=${keydown}>
    <span class="seg-ind" ref=${indicator} aria-hidden="true"></span>
    ${options.map((o) => html`<button type="button" class="seg-btn" data-v=${o.value} role="radio" aria-checked=${o.value === value ? "true" : "false"}
      tabindex=${o.value === value ? 0 : -1} onClick=${() => onChange(o.value)}>${o.icon && html`<${Icon} name=${o.icon} />`}${o.label}${o.count != null && html`<span class="muted counter"><${Roll} value=${o.count} /></span>`}</button>`)}
  </div>`;
}

// ------------------------------------------------------------- focus trap
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function useFocusTrap(ref, { initial, active = true, self = false } = {}) {
  useEffect(() => {
    if (!active) return;
    const returnTo = document.activeElement;
    const node = ref.current;
    // self: фокус на самом окне (шторка) — без кольца на крестике при открытии по ссылке; Tab ведёт внутрь.
    const first = self ? node : (initial && node.querySelector(initial)) || node.querySelector("[data-autofocus]") || node.querySelector(FOCUSABLE) || node;
    requestAnimationFrame(() => first && first.focus({ preventScroll: true }));
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const a = items[0], b = items[items.length - 1];
      if (document.activeElement === node) { e.preventDefault(); (e.shiftKey ? b : a).focus(); return; }
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // Возвращаем фокус, только если его никто не забрал (новое действие важнее).
      const ae = document.activeElement;
      if (returnTo && document.contains(returnTo) && (!ae || ae === document.body || node.contains(ae))) {
        requestAnimationFrame(() => returnTo.focus({ preventScroll: true }));
      }
    };
  }, [active]);
}

function useClosing(onClose, busy) {
  const [closing, setClosing] = useState(false);
  // after: что сделать вместо onClose, когда окно доиграло уход (например, перейти в другой раздел).
  const request = (after) => {
    if (busy || closing) return;
    setClosing(true);
    setTimeout(typeof after === "function" ? after : onClose, 130);
  };
  return [closing, request];
}

// Escape закрывает только верхнее модальное окно.
function useEscape(fn, ref) {
  useEffect(() => {
    const h = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (ref && ref.current && modals.length && modals[modals.length - 1] !== ref.current) return;
      e.preventDefault(); fn();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  });
}

function useScrollLock() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    const sw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (sw) document.body.style.paddingRight = sw + "px";
    return () => { document.body.style.overflow = prev; document.body.style.paddingRight = ""; };
  }, []);
}

// Диалог: pending-операция защищена от закрытия крестиком, Escape и фоном.
export function Dialog({ title, subtitle, onClose, busy, size = "", children, footer, initial, labelId = "dlg-title", wrapCls = "", closable = true, z = 60 }) {
  const ref = useRef(null);
  const [closing, request] = useClosing(onClose, busy || !closable);
  useFocusTrap(ref, { initial });
  useEscape(request, ref);
  useScrollLock();
  return html`
    <div class=${"overlay" + (closing ? " is-closing" : "")} style=${`z-index:${z}`} onClick=${request}></div>
    <div class=${"dialog-wrap " + wrapCls} style=${`z-index:${z + 1}`} onMouseDown=${(e) => { if (e.target === e.currentTarget) request(); }}>
      <div class=${"dialog " + size + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-labelledby=${labelId} ref=${ref} tabindex="-1">
        <div class="dialog-head">
          <div class="titles"><h2 class="h1" id=${labelId} style="font-size:17px;line-height:24px">${title}</h2>${subtitle && html`<p class="meta" style="margin-top:2px">${subtitle}</p>`}</div>
          ${closable && html`<${Button} kind="ghost" icon="x" aria-label=${busy ? "Закрыть (недоступно, пока идёт отправка)" : "Закрыть"} onClick=${request} aria-disabled=${busy ? "true" : undefined} />`}
        </div>
        <div class="dialog-body">${children}</div>
        ${footer && html`<div class="dialog-foot">${footer}</div>`}
      </div>
    </div>`;
}

export function Drawer({ crumb, onClose, children, footer, label, busy }) {
  const ref = useRef(null);
  const [closing, request] = useClosing(onClose, busy);
  useFocusTrap(ref, { self: true });
  useEscape(() => request(), ref);
  useScrollLock();
  return html`
    <div class=${"overlay" + (closing ? " is-closing" : "")} onClick=${() => request()}></div>
    <aside class=${"drawer" + (closing ? " is-closing" : "")} role="dialog" aria-modal="true" aria-label=${label} ref=${ref} tabindex="-1">
      <div class="drawer-head"><span class="crumb">${crumb}</span><${Button} kind="ghost" icon="x" aria-label="Закрыть" onClick=${() => request()} /></div>
      <div class="drawer-body">${children}</div>
      ${footer && html`<div class="drawer-foot">${typeof footer === "function" ? footer(request) : footer}</div>`}
    </aside>`;
}

// Поповер-меню с клавиатурой.
export function Menu({ anchor, onClose, children, align = "right", label }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPos({ top: r.bottom + window.scrollY + 6, right: document.documentElement.clientWidth - r.right, left: r.left });
  }, []);
  useEffect(() => {
    const first = ref.current && ref.current.querySelector(".menu-item");
    first && first.focus();
    const down = (e) => { if (ref.current && !ref.current.contains(e.target) && !anchor.contains(e.target)) onClose(); };
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); anchor.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...ref.current.querySelectorAll(".menu-item")];
        const i = items.indexOf(document.activeElement);
        const n = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[n].focus();
      }
      if (e.key === "Tab") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, []);
  if (!pos) return null;
  // Меню лежит в относительном контейнере кнопки — привязываемся к нему, а не к окну.
  const style = align === "right" ? "top:calc(100% + 6px);right:0" : "top:calc(100% + 6px);left:0";
  return html`<div class="menu" role="menu" aria-label=${label} ref=${ref} style=${"position:absolute;" + style}>${children}</div>`;
}

export function Toasts() {
  const s = useStore();
  return html`<div class="toasts" role="status" aria-live="polite">
    <${AnimatedList} items=${s.toasts} keyOf=${(t) => t.id} render=${(t) => html`<div class="toast-slot"><div class="toast">
      <span class="grow">${t.text}</span>
      ${t.action && html`<button class="btn btn-sm" onClick=${() => { dismissToast(t.id); t.action.fn(); }}>${t.action.label}</button>`}
      <button class="btn btn-sm btn-icon" aria-label="Скрыть уведомление" onClick=${() => dismissToast(t.id)}><${Icon} name="x" /></button>
    </div></div>`} />
  </div>`;
}

export function Empty({ scene, title, text, children, compact }) {
  return html`<div class="empty" style=${compact ? "padding:20px 12px" : ""}>
    ${scene}
    <h2 class="h2">${title}</h2>
    ${text && html`<p>${text}</p>`}
    ${children && html`<div class="actions">${children}</div>`}
  </div>`;
}

export function Skeleton({ rows = 4 }) {
  return html`<div aria-busy="true" aria-label="Загрузка">${Array.from({ length: rows }, (_, i) => html`<div class="skel-row" key=${i}>
    <div class="skel skel-line" style="width:44px"></div>
    <div style="display:grid;gap:8px"><div class="skel skel-line" style=${`width:${60 - i * 7}%`}></div><div class="skel skel-line" style="width:38%;height:10px"></div></div></div>`)}</div>`;
}

export function LoadError({ error, onRetry, what = "данные" }) {
  const net = error && error.network;
  const notFound = error && error.status === 404;
  if (notFound) return html`<${Empty} title="Не найдено" text=${error.message + ". Возможно, ссылка устарела или относится к другому аккаунту."} />`;
  return html`<div class="banner banner-dashed" role="alert">
    <${Icon} name=${net ? "wifiOff" : "alert"} />
    <div class="grow"><b>Не удалось загрузить ${what}.</b> ${net ? "Нет связи с сервером." : error ? error.message : ""}</div>
    ${onRetry && html`<${Button} size="sm" icon="refresh" onClick=${onRetry}>Повторить</${Button}>`}
  </div>`;
}

export function Field({ id, label, optional, help, error, children, counter }) {
  return html`<div class="field">
    <label class="label" for=${id}>${label}${optional && html` <span class="opt">— необязательно</span>`}</label>
    ${children}
    <${Presence} show=${!!error}><div class="error-text" id=${id + "-err"}><${Icon} name="alert" size=${14} />${error}</div></${Presence}>
    ${(help || counter) && html`<div class="help" id=${id + "-help"} style="display:flex;gap:12px"><span style="flex:1">${help}</span>${counter}</div>`}
  </div>`;
}

export function describedBy(id, error, help) { return [error && id + "-err", help && id + "-help"].filter(Boolean).join(" ") || undefined; }
