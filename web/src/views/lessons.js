// Строки занятий и подробности занятия — общие для «Сегодня» и «Расписания».
import { html, useEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { Icon } from "../icons.js";
import { Button, Drawer, LoadError, Skeleton } from "../ui.js";
import { Link, closeTo, navigate, withParams } from "../router.js";
import { useResource, state, toast, demoNow, fastClock, useDemoNow } from "../data.js";
import { Presence, Roll, firstTime } from "../motion.js";
import { ackChange, setTaskDone, download } from "../actions.js";
import { duration, toMin, where, shortTeacher, longDate, relDay, stamp, dayMonth, weekday, WD_SHORT } from "../format.js";

export function lessonHref(l, from) {
  return withParams(`/schedule/lesson/${l.id}`, { view: "day", date: l.date, ...(from || {}) });
}

export function changeText(l) {
  const c = l.change;
  if (!c) return "";
  if (c.kind === "cancelled") return "Занятие отменено";
  if (c.kind === "room") return "Изменена аудитория";
  if (c.kind === "time") return "Перенесено время";
  return "Изменены время и аудитория";
}

export function ChangeTag({ lesson }) {
  if (!lesson.change) return null;
  const acked = lesson.change.acknowledged_at;
  if (lesson.change.kind === "cancelled") return html`<span class="tag tag-dashed">Отменено</span>`;
  return html`<span class=${"tag " + (acked ? "" : "tag-solid")} title=${acked ? "Изменение подтверждено" : "Изменение не подтверждено"}>
    ${acked ? html`<${Icon} name="check" size=${12} />` : html`<${Icon} name="swap" size=${12} />`}${changeText(lesson)}</span>`;
}

// «412, корпус А → 318, корпус Б» / «14:10 → 12:40»
export function ChangeLine({ lesson, compact }) {
  const c = lesson.change;
  if (!c || c.kind === "cancelled") return null;
  if (compact) {
    // В строке занятия новое значение уже показано — здесь только прежнее.
    const old = [];
    if (c.kind === "room" || c.kind === "room_time") old.push(where(c.old.room, c.old.building));
    if (c.kind === "time" || c.kind === "room_time") old.push(`${c.old.start}–${c.old.end}`);
    return html`<div class="change-line"><span class="muted">Было:</span><span class="old">${old.join(", ")}</span></div>`;
  }
  const parts = [];
  if (c.kind === "room" || c.kind === "room_time") parts.push([where(c.old.room, c.old.building), where(lesson.room, lesson.building)]);
  if (c.kind === "time" || c.kind === "room_time") parts.push([`${c.old.start}–${c.old.end}`, `${lesson.start}–${lesson.end}`]);
  return html`<div class="change-line">${parts.map(([a, b]) => html`<span class="old">${a}</span><${Icon} name="arrowRight" size=${14} /><span class="new">${b}</span>`)}</div>`;
}

export function LessonRow({ lesson: l, now, phase, from }) {
  const hm = now.slice(11, 16);
  const cls = ["lesson", phase && "is-" + phase, l.status === "cancelled" && "is-cancelled", (phase === "now" || phase === "next") && "has-state"].filter(Boolean).join(" ");
  // Фаза меняется на глазах, когда идёт демо-время: строка состояния и полоса уезжают/приезжают, минуты прокручиваются.
  const roll = (v) => (fastClock() ? v : html`<${Roll} value=${v} />`);
  let stateLine = null;
  if (phase === "now") {
    stateLine = html`<div class="state"><span class="dot" aria-hidden="true"></span><span>Идёт сейчас · осталось ${roll(duration(toMin(l.end) - toMin(hm)))}</span></div>`;
  } else if (phase === "next") {
    stateLine = html`<div class="state"><span>Следующая · через ${roll(duration(toMin(l.start) - toMin(hm)))}</span></div>`;
  }
  const lastState = useRef(null);
  if (stateLine) lastState.current = stateLine;
  const p = phase === "now" ? Math.min(1, Math.max(0, (toMin(hm) - toMin(l.start)) / (toMin(l.end) - toMin(l.start)))) : 0;
  const pending = l.change && !l.change.acknowledged_at;
  const [busy, setBusy] = useState(false);
  const grow = useRef(null);
  if (grow.current === null) grow.current = phase === "now" && firstTime("progress:" + l.id);
  const ack = async () => {
    setBusy(true);
    try { await ackChange(l); } catch (err) { /* тост уже показан */ } finally { setBusy(false); }
  };
  // Хвост строки (метка изменения, «прошла», «Подтвердить»). На телефоне это отдельная строка карточки —
  // поэтому она тоже приезжает/уезжает, когда пара становится прошедшей на глазах.
  const trailShown = !!l.change || phase === "past";
  const trail = trailShown ? html`<div class="trail">
      <${ChangeTag} lesson=${l} />
      ${phase === "past" && l.status !== "cancelled" && html`<span class="small">прошла</span>`}
      <${Presence} show=${!!pending} axis="xy" inline><${Button} size="sm" kind="primary" icon="check" busy=${busy} onClick=${ack} cls="above"
        aria-label=${`Подтвердить: ${changeText(l).toLowerCase()} — ${l.subject}`}>Подтвердить</${Button}></${Presence}>
    </div>` : null;
  const lastTrail = useRef(null);
  if (trail) lastTrail.current = trail;
  return html`<div class=${cls} data-lesson=${l.id}>
    <${Presence} show=${!!stateLine} cls="state-wrap">${stateLine || lastState.current}</${Presence}>
    <div class="time"><b>${l.start}</b><span>${l.end}</span></div>
    <div class="lesson-content" style="min-width:0">
      <${Link} class="lesson-link title" href=${lessonHref(l, from)} overlay>${l.subject}<span class="sr-only">, ${l.start}–${l.end}, ${l.kind}, ${where(l.room, l.building)}${l.change ? ". " + changeText(l) : ""}${phase === "now" ? ". Идёт сейчас" : phase === "next" ? ". Следующая пара" : ""}</span></${Link}>
      <div class="info">
        <span>${l.kind}</span>
        <span><${Icon} name="pin" size=${14} /><span class=${"where" + (l.status === "cancelled" ? " strike" : "")}>${where(l.room, l.building)}</span></span>
        <span><${Icon} name="teacher" size=${14} />${shortTeacher(l.teacher)}</span>
      </div>
      <${ChangeLine} lesson=${l} compact />
      ${l.status === "cancelled" && l.change && l.change.reason && html`<div class="meta" style="margin-top:6px">${l.change.reason}</div>`}
    </div>
    <${Presence} show=${trailShown} cls="trail-wrap">${trail || lastTrail.current}</${Presence}>
    <${Presence} show=${phase === "now"} cls="progress-wrap"><div class="progress" aria-hidden="true"><i class=${grow.current ? "grow" : ""} style=${`--p:${phase === "now" ? p : 1}`}></i></div></${Presence}>
  </div>`;
}

// Подробности занятия: изменения, подтверждение, сроки, экспорт, ссылка.
export function LessonDrawer({ id, parentHref }) {
  const { data: l, error, loading, reload } = useResource(`lesson:${id}`, `/api/lessons/${id}`);
  const [busy, setBusy] = useState(false);
  const now = demoNow();
  const close = () => closeTo(parentHref);
  // Прямая ссылка без даты: после загрузки дописываем дату занятия, чтобы под окном открылась его неделя, а не текущая.
  useEffect(() => {
    if (l && !new URLSearchParams(location.search).get("date")) navigate(withParams(location.pathname, { view: "day", date: l.date }), { replace: true });
  }, [l && l.date]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.origin + withParams(`/schedule/lesson/${id}`, { view: "day", date: l ? l.date : undefined })); toast("Ссылка на занятие скопирована"); }
    catch (e) { toast("Не удалось скопировать — скопируйте адрес из строки браузера"); }
  };
  let body;
  if (loading && !l) body = html`<${Skeleton} rows=${3} />`;
  else if (error && !l) body = html`<${LoadError} error=${error} onRetry=${reload} what="занятие" />`;
  else {
    const c = l.change;
    const isPast = l.date < now.slice(0, 10) || (l.date === now.slice(0, 10) && l.end <= now.slice(11, 16));
    body = html`
      <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="tag tag-quiet">${l.kind}</span>${l.control && html`<span class="tag tag-quiet" title="Форма итогового контроля по дисциплине">итог: ${l.control.toLowerCase()}</span>`}<${ChangeTag} lesson=${l} /></div>
      <h2 class="detail-title" id="lesson-title">${l.subject}</h2>
      <p class="meta-2">${longDate(l.date)}${relDay(l.date, now.slice(0, 10)) !== dayMonth(l.date) ? " · " + relDay(l.date, now.slice(0, 10)) : ""}${isPast ? " · прошло" : ""}</p>
      ${c && html`<div class="change-box" role="group" aria-label="Изменение">
        <div style="display:flex;align-items:center;gap:8px"><${Icon} name=${c.kind === "cancelled" ? "ban" : "swap"} /><b>${changeText(l)}</b></div>
        ${c.kind !== "cancelled" && html`<div class="change-grid">
          <span class="k">Было</span><span class="strike muted">${c.old.start}–${c.old.end} · ${where(c.old.room, c.old.building)}</span>
          <span class="k">Стало</span><span class="strong">${l.start}–${l.end} · ${where(l.room, l.building)}</span>
        </div>`}
        ${c.reason && html`<p class="meta-2">${c.reason}</p>`}
        <p class="small">Объявлено ${stamp(c.announced_at, now.slice(0, 10))}</p>
        ${(c.acknowledged_at
          ? html`<p class="meta" style="display:flex;gap:6px;align-items:center"><${Icon} name="check" size=${14} />Вы подтвердили изменение ${stamp(c.acknowledged_at, now.slice(0, 10))}</p>`
          : html`<div><${Button} kind="primary" icon="check" busy=${busy} onClick=${async () => { setBusy(true); try { await ackChange(l); } catch (e) {} setBusy(false); }}>Подтвердить изменение</${Button}></div>`)}
      </div>`}
      <dl class="kv" style="margin-top:16px">
        <dt>Время</dt><dd class="num">${l.start}–${l.end}</dd>
        <dt>Где</dt><dd><b class=${l.status === "cancelled" ? "strike" : ""}>${where(l.room, l.building)}</b></dd>
        <dt>Преподаватель</dt><dd>${l.teacher}</dd>
      </dl>
      ${l.tasks && l.tasks.length > 0 && html`<div class="detail-sec"><span class="eyebrow">Сроки по дисциплине</span>
        <div class="panel">${l.tasks.map((t) => html`<${TaskItem} key=${t.id} task=${t} today=${now.slice(0, 10)} />`)}</div></div>`}
      ${l.notifications && l.notifications.length > 0 && html`<div class="detail-sec"><span class="eyebrow">Уведомления</span>
        <div class="list">${l.notifications.map((n) => html`<${Link} class="list-item" href=${withParams("/notifications", { id: n.id })}>
          <span class="lead"><${Icon} name="bell" /></span><span class="body"><span class="h3" style="display:block">${n.title}</span><span class="small">${stamp(n.created_at, now.slice(0, 10))}${n.read ? " · прочитано" : " · не прочитано"}</span></span></${Link}>`)}</div></div>`}
    `;
  }
  return html`<${Drawer} label=${l ? `Занятие: ${l.subject}` : "Занятие"} crumb=${l ? `Расписание · ${WD_SHORT[weekday(l.date)]}, ${dayMonth(l.date)} · ${l.start}` : "Расписание"} onClose=${close}
    footer=${l && html`<${Button} icon="calExport" onClick=${() => download(`/api/lessons/${l.id}.ics`)}>В календарь (.ics)</${Button}>
      <${Button} kind="ghost" icon="link" onClick=${copy}>Скопировать ссылку</${Button}>`}>
    ${body}
  </${Drawer}>`;
}

export function TaskItem({ task: t, today, highlight, hideSubject }) {
  const [busy, setBusy] = useState(false);
  const [striking, setStriking] = useState(false);
  // Уходящая копия строки (в списке открытых) остаётся зачёркнутой; в окне занятия строка остаётся — там сбрасываем.
  useEffect(() => { if (t.done_at) setStriking(false); }, [t.done_at]);
  // Срок — по демо-часам: в последний час минуты прокручиваются, в свою минуту строка сама становится просроченной.
  const now = useDemoNow();
  const day = today;
  const dueAt = t.due_date ? `${t.due_date}T${t.due_time || "23:59"}` : null;
  const live = now.slice(0, 10) === today;
  const overdue = !t.done_at && !!dueAt && (live ? now >= dueAt : t.due_date < today);
  const left = live && dueAt && !overdue && t.due_date === day ? toMin(dueAt.slice(11, 16)) - toMin(now.slice(11, 16)) : null;
  const soon = !t.done_at && left != null && left <= 60;
  const wasOverdue = useRef(overdue);
  const justOverdue = useRef(false);
  if (overdue && !wasOverdue.current) justOverdue.current = true;
  wasOverdue.current = overdue;
  const label = t.done_at ? "выполнено"
    : !t.due_date ? "без срока"
    : overdue ? (t.due_date === day ? `срок прошёл в ${t.due_time || "23:59"}` : `срок прошёл ${dayMonth(t.due_date)}`)
    : soon ? `срок: через ${duration(Math.max(1, left))}`
    : `срок: ${relDay(t.due_date, day)}${t.due_time ? ", " + t.due_time : ""}`;
  const id = `task-${t.id}`;
  const toggle = async (e) => {
    const on = e.target.checked;
    setBusy(true);
    // Отметка: галочка рисуется, название зачёркивается слева направо — и только потом строка уходит в «Выполнено».
    if (on && !matchMedia("(prefers-reduced-motion: reduce)").matches) { setStriking(true); await new Promise((r) => setTimeout(r, 440)); }
    try { await setTaskDone(t, on); }
    catch (err) { e.target.checked = !!t.done_at; setStriking(false); }
    setBusy(false);
  };
  return html`<div class=${"todo" + (t.done_at ? " is-done" : "") + (striking && !t.done_at ? " is-striking" : "") + (highlight ? " is-highlight" : "") + (justOverdue.current && overdue ? " just-overdue" : "")} id=${id}>
    <span class="lead"><input type="checkbox" class="checkbox" id=${id + "-cb"} checked=${!!t.done_at || striking} disabled=${busy} onChange=${toggle} /></span>
    <div class="body">
      <label class="title" for=${id + "-cb"} style="cursor:pointer;display:block"><span class="tt">${t.title}</span></label>
      ${/* просрочка выделена только на подписи срока (знак «!» + жирный), предмет остаётся метаданными */ ""}
      <div class=${"meta" + (soon ? " soon" : "")}><span class=${overdue ? "overdue" : ""}>${overdue && html`<${Icon} name="alert" size=${12} />`}${fastClock() ? label : html`<${Roll} value=${label} />`}</span>${t.subject && !hideSubject ? "\u00a0· " + t.subject : ""}</div>
      ${t.note && !t.done_at && html`<div class="small" style="margin-top:2px">${t.note}</div>`}
    </div>
  </div>`;
}
