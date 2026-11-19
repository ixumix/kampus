// «Уведомления»: список и деталь рядом. Фильтр и выбранная запись — в URL.
// Открытие = прочтение; прочтение ≠ подтверждение изменения и ≠ выполнение дела.
import { html, useEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { Icon } from "../icons.js";
import { Button, Empty, LoadError, Segmented, Skeleton } from "../ui.js";
import { Link, navigate, withParams } from "../router.js";
import { useResource, state, peek, load } from "../data.js";
import { setRead, readAll, ackChange } from "../actions.js";
import { TrayFigure } from "../scenes.js";
import { stamp, countOf, ago } from "../format.js";
import { useDemoNow, fastClock } from "../data.js";

// Время уведомления стареет по демо-часам: «только что» → «2 мин назад» → «10:17» (прокрутка на месте).
function Ago({ at }) {
  const now = useDemoNow();
  const v = ago(at, now);
  return fastClock() ? v : html`<${Roll} value=${v} />`;
}
import { changeText } from "./lessons.js";
import { reduced, Collapse, Roll } from "../motion.js";
import { isFresh } from "../live.js";

// На узком экране список и деталь — два экрана. Уходящий гаснет за 140 мс, входящий проявляется:
// смена экрана без жёсткой подмены (stageshow: «A page swap … crossfades only the body»).
function useScreen(want) {
  const [shown, setShown] = useState(want);
  useEffect(() => {
    if (want === shown) return;
    if (!matchMedia("(max-width: 920px)").matches || reduced()) { setShown(want); return; }
    const t = setTimeout(() => setShown(want), 140);
    return () => clearTimeout(t);
  }, [want, shown]);
  return [shown, want !== shown];
}

const CAT_ICON = { schedule: "calendar", requests: "doc", deadlines: "clock", announcements: "megaphone" };

function target(n) {
  if (n.link_type === "lesson") return { href: `/schedule/lesson/${n.link_id}`, label: "Открыть занятие", overlay: true };
  if (n.link_type === "request") return { href: `/documents/${n.link_id}`, label: "Открыть заявку", overlay: true };
  if (n.link_type === "subject") return { href: `/grades/subject/${n.link_id}`, label: "Открыть дисциплину", overlay: true };
  if (n.link_type === "task") return { href: withParams("/", { task: n.link_id }), label: "Показать срок на главной" };
  if (n.link_type === "exams") return { href: "/grades?tab=session", label: "Открыть сессию" };
  return null;
}

function LessonAck({ id }) {
  const today = peek("today");
  const [lesson, setLesson] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { load(`lesson:${id}`, `/api/lessons/${id}`).then(setLesson).catch(() => {}); }, [id, today]);
  if (!lesson || !lesson.change) return null;
  const c = lesson.change;
  return html`<div class="note" style="margin-top:16px;flex-wrap:wrap">
    <${Icon} name=${c.acknowledged_at ? "check" : "swap"} />
    <span style="flex:1;min-width:200px">${c.acknowledged_at ? "Изменение подтверждено." : html`<b style="color:var(--fg)">${changeText(lesson)} — не подтверждено.</b> Прочтение уведомления не подтверждает изменение.`}</span>
    ${!c.acknowledged_at && html`<${Button} kind="primary" icon="check" busy=${busy} onClick=${async () => { setBusy(true); try { setLesson(await ackChange(lesson)); } catch (e) {} setBusy(false); }}>Подтвердить изменение</${Button}>`}
  </div>`;
}

function Detail({ n, today, onBack, visible }) {
  const t = target(n);
  const headRef = useRef(null);
  useEffect(() => { if (visible && matchMedia("(max-width: 920px)").matches) headRef.current && headRef.current.focus({ preventScroll: true }); }, [n.id, visible]);
  return html`<article class="in page" key=${n.id} aria-labelledby="ntf-title">
    <div style="display:flex;gap:8px;margin-bottom:16px" class="mobile-back">
      <${Button} kind="ghost" size="sm" icon="arrowLeft" onClick=${onBack} cls="only-narrow">К списку</${Button}></div>
    <p class="source"><${Icon} name=${CAT_ICON[n.category]} size=${14} /><span>Источник: <b style="color:var(--fg-2)">${n.category_label}</b></span><span>·</span><time datetime=${n.created_at}><${Ago} at=${n.created_at} /></time></p>
    <h2 class="detail-title" id="ntf-title" tabindex="-1" ref=${headRef} style="font-size:20px;line-height:28px">${n.title}</h2>
    <p class="prose" style="margin-top:8px">${n.body}</p>
    ${n.link_type === "lesson" && html`<${LessonAck} id=${n.link_id} />`}
    ${n.link_type === "task" && html`<p class="meta" style="margin-top:12px">Прочтение не отмечает дело выполненным — отметка ставится в списке «Нужно сделать».</p>`}
    <div style="display:flex;gap:8px;margin-top:20px;flex-wrap:wrap">
      ${t && html`<${Link} class="btn btn-primary" href=${t.href} overlay=${t.overlay}>${t.label}<${Icon} name="arrowRight" /></${Link}>`}
      <${Button} icon=${n.read ? "mail" : "mailOpen"} onClick=${() => setRead(n, !n.read).catch(() => {})}>${n.read ? "Вернуть в непрочитанные" : "Отметить прочитанным"}</${Button}>
    </div>
  </article>`;
}

export function NotificationsPage({ route }) {
  const { data, error, loading, reload } = useResource("notifications", "/api/notifications");
  const filter = route.search.get("filter") === "unread" ? "unread" : "all";
  const cat = state.session.meta.categories[route.search.get("cat")] ? route.search.get("cat") : null;
  const selId = Number(route.search.get("id")) || null;
  const today = state.session.user.demo_now.slice(0, 10);
  // Записи, прочитанные в этом просмотре, остаются в фильтре «Непрочитанные» до смены фильтра.
  const sticky = useRef(new Set());
  const lastFilter = useRef(filter + cat);
  if (lastFilter.current !== filter + cat) { sticky.current = new Set(); lastFilter.current = filter + cat; }
  const all = data ? data.notifications : [];
  const selected = all.find((n) => n.id === selId);
  const [detailShown, switching] = useScreen(!!selected);
  const list = all.filter((n) => (!cat || n.category === cat) && (filter === "all" || !n.read || sticky.current.has(n.id)));
  const selectedHidden = selected && !list.some((n) => n.id === selected.id);
  const unread = all.filter((n) => !n.read && (!cat || n.category === cat)).length;
  // Лоток реагирует на почту: если «Непрочитанных нет» и пришло новое, сначала в лоток падает карточка, потом открывается список.
  const allFresh = list.length > 0 && list.every((n) => isFresh(n.id));
  const wasEmpty = useRef(list.length === 0);
  const [trayHold, setTrayHold] = useState(false);
  useEffect(() => {
    if (allFresh && wasEmpty.current && filter === "unread" && !reduced()) {
      setTrayHold(true);
      const t = setTimeout(() => setTrayHold(false), 1100);
      return () => clearTimeout(t);
    }
  }, [allFresh]);
  useEffect(() => { wasEmpty.current = list.length === 0; });
  const href = (p) => withParams("/notifications", { filter: filter === "unread" ? "unread" : undefined, cat, id: selId, ...p });

  // Открытие = прочтение (тихо, без тоста).
  useEffect(() => {
    if (selected && !selected.read) { sticky.current.add(selected.id); setRead(selected, true, { silent: true }).catch(() => {}); }
  }, [selId, !!data]);
  // Выбранная запись видима в списке (в том числе при прямой ссылке).
  useEffect(() => {
    if (!selId) return;
    const el = document.querySelector(`[data-ntf="${selId}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selId, !!data, filter, cat]);

  const onKeyList = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = list.findIndex((n) => n.id === selId);
    const next = list[e.key === "ArrowDown" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) { e.preventDefault(); navigate(href({ id: next.id }), { replace: true }); requestAnimationFrame(() => document.querySelector(`[data-ntf="${next.id}"]`)?.focus()); }
  };

  return html`<div class=${"page page-ntf" + (detailShown ? " ntf-has-detail" : "") + (switching ? " ntf-switching" : "")}>
    <div class="page-head"><div class="titles"><h1 class="h1" tabindex="-1" data-page-title>Уведомления</h1>
      <p class="meta">${data ? (unread ? countOf(unread, "непрочитанное", "непрочитанных", "непрочитанных") : "Все прочитаны") + (cat ? ` · ${state.session.meta.categories[cat]}` : "") : " "}</p></div>
      <div class="actions"><${Button} icon="check" disabled=${!unread} onClick=${() => readAll(cat).catch(() => {})}>Прочитать все${cat ? html`<span class="wide-only"> в категории</span>` : ""}</${Button}></div></div>
    <div class="toolbar">
      <${Segmented} label="Показать" value=${filter} onChange=${(v) => navigate(href({ filter: v === "unread" ? "unread" : undefined }), { replace: true })}
        options=${[{ value: "all", label: "Все" }, { value: "unread", label: "Непрочитанные", count: data ? all.filter((n) => !n.read).length : null }]} />
      <div class="chips" role="group" aria-label="Категория">
        <${Link} class="chip" replace href=${href({ cat: undefined })} aria-current=${!cat ? "true" : undefined}>Все категории</${Link}>
        ${Object.entries(state.session.meta.categories).map(([k, l]) => html`<${Link} class="chip" replace href=${href({ cat: k })} aria-current=${cat === k ? "true" : undefined}><${Icon} name=${CAT_ICON[k]} size=${14} />${l}</${Link}>`)}
      </div>
    </div>
    ${loading && !data ? html`<div class="panel"><${Skeleton} rows=${5} /></div>`
      : error && !data ? html`<${LoadError} error=${error} onRetry=${reload} what="уведомления" />`
      : html`<div class=${"inbox" + (detailShown ? " has-detail" : "")}>
        <div class="inbox-list">
          ${selectedHidden && html`<div class="banner banner-dashed inbox-note"><${Icon} name="info" /><span class="grow">Открытое уведомление не входит в текущий фильтр.</span>
            <${Link} class="btn btn-sm" replace href=${withParams("/notifications", { id: selId })}>Показать все</${Link}></div>`}
          <div class="scroller" role="list" aria-label="Список уведомлений" onKeyDown=${onKeyList}>
            ${list.length === 0 || trayHold
              ? (filter === "unread"
                ? html`<${Empty} scene=${html`<${TrayFigure} incoming=${trayHold} />`} title=${trayHold ? "Новое уведомление" : "Непрочитанных нет"} text="Все уведомления прочитаны. Прочтение не отмечает дела выполненными."><${Link} class="btn" replace href=${href({ filter: undefined })}>Показать все</${Link}></${Empty}>`
                : html`<${Empty} title="В этой категории пусто" text="Уведомлений этой категории нет." />`)
              : list.map((n) => html`<div role="listitem" key=${n.id}><${Collapse} enter=${isFresh(n.id)}><${Link} class=${"ntf" + (n.read ? "" : " is-unread") + (isFresh(n.id) ? " is-fresh" : "")} replace data-ntf=${n.id}
                  href=${href({ id: n.id })} aria-current=${n.id === selId ? "true" : undefined}>
                  <span class="ud" aria-hidden="true"></span>
                  <span class="title">${n.title}<span class="sr-only">${n.read ? ", прочитано" : ", не прочитано"}</span></span>
                  <span class="ex">${n.body}</span>
                  <span class="mt"><span>${n.category_label}</span><span><${Ago} at=${n.created_at} /></span>${n.read && sticky.current.has(n.id) && filter === "unread" && html`<span>· прочитано</span>`}</span>
                </${Link}></${Collapse}></div>`)}
          </div>
        </div>
        <div class="inbox-detail" aria-live="polite">
          ${selected ? html`<${Detail} n=${selected} today=${today} visible=${detailShown} onBack=${() => navigate(href({ id: undefined }), { replace: true })} />`
            : selId ? html`<${Empty} title="Уведомление не найдено" text="Возможно, ссылка устарела или относится к другому аккаунту." />`
            : html`<${Empty} title="Выберите уведомление" text="Подробности и переход к занятию или заявке появятся здесь. Стрелки ↑↓ переключают записи." />`}
        </div>
      </div>`}
  </div>`;
}
