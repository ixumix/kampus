// «Сегодня»: что сейчас, что изменилось, что нужно сделать, какой документ готов.
// Каждое занятие показано ровно один раз — в ленте дня; сводка справа содержит только действия.
import { html, useEffect, useState } from "../../vendor/preact-htm.js";
import { Icon } from "../icons.js";
import { Button, Empty, LoadError, Skeleton } from "../ui.js";
import { Link, withParams } from "../router.js";
import { useResource, state, useDemoNow, fastClock } from "../data.js";
import { ackChange, download, setReceived } from "../actions.js";
import { LessonRow, TaskItem, lessonHref, changeText, ChangeLine } from "./lessons.js";
import { WeekFigure, FieldFigure } from "../scenes.js";
import { AnimatedList, Presence, Roll } from "../motion.js";
import { Spark } from "../spark.js";
import { factFor } from "../facts.js";
import { DemoClock } from "../clock.js";
import { longDate, toMin, duration, relDay, dayMonth, shortDate, countOf, plural, where, stamp, addDays, weekday } from "../format.js";

function phaseOf(l, d) {
  if (l.status === "cancelled") return l.end <= d.now.slice(11, 16) ? "past" : null;
  if (l.id === d.current_id) return "now";
  if (l.id === d.next_id) return "next";
  if (l.end <= d.now.slice(11, 16)) return "past";
  return null;
}

// Перерыв между парами. Длинный (от 30 мин) виден всегда; во время перерыва строка оживает: «Перерыв · ещё 12 мин»
// и полоса, которая убывает до начала следующей пары. Короткая перемена появляется только пока идёт.
function BreakLine({ prev, l, hm }) {
  const from = toMin(prev.end), to = toMin(l.start), cur = toMin(hm), gap = to - from;
  const inBreak = from <= cur && cur < to;
  const show = gap >= 30 || inBreak;
  const left = to - cur;
  const body = inBreak
    ? html`<div class="gap-line is-live"><span>Перерыв · ещё ${fastClock() ? duration(left) : html`<${Roll} value=${duration(left)} />`}</span>
        <span class="gap-bar" aria-hidden="true"><i style=${`transform:scaleX(${(left / gap).toFixed(4)})`}></i></span></div>`
    : html`<div class="gap-line">Перерыв ${duration(gap)}</div>`;
  return html`<${Presence} show=${show && gap > 0}>${body}</${Presence}>`;
}

function Agenda({ d }) {
  const items = [];
  const hm = d.now.slice(11, 16);
  d.lessons.forEach((l, i) => {
    const prev = d.lessons[i - 1];
    if (prev && prev.status !== "cancelled" && l.status !== "cancelled") {
      items.push(html`<${BreakLine} key=${"g" + l.id} prev=${prev} l=${l} hm=${hm} />`);
    }
    items.push(html`<${LessonRow} key=${l.id} lesson=${l} now=${d.now} phase=${phaseOf(l, d)} />`);
  });
  return html`<div class="agenda stagger">${items}</div>`;
}

function NextDay({ d }) {
  const l = d.next_day_lesson;
  if (!l) return null;
  return html`<${Link} class="tomorrow" href=${withParams("/schedule", { view: "day", date: l.date })}>
    <${Icon} name="calendar" />
    <span class="grow"><b style="color:var(--fg)">${relDay(l.date, d.date) === "завтра" ? "Завтра" : shortDate(l.date)}</b> — первая пара в ${l.start}: ${l.subject}, ${where(l.room, l.building)}</span>
    <${Icon} name="right" />
  </${Link}>`;
}

// Свободный день: событие «в этот день» из подборки (web/src/facts.js) — просто для настроения.
function DayFact({ date }) {
  const f = factFor(date);
  if (!f) return null;
  return html`<aside class="day-fact" aria-labelledby="fact-h">
    <h3 class="eyebrow" id="fact-h">В этот день · ${f.year}</h3>
    <p>${f.text}</p>
  </aside>`;
}

// Текущая и следующая пара — по демо-часам в браузере: когда время идёт или ползунок тянут, фазы меняются на лету.
function withClock(d, now) {
  if (!d || now.slice(0, 10) !== d.date) return d;
  const hm = now.slice(11, 16), act = d.lessons.filter((l) => l.status !== "cancelled");
  const cur = act.find((l) => l.start <= hm && hm < l.end), nxt = act.find((l) => l.start > hm);
  return { ...d, now, current_id: cur ? cur.id : null, next_id: nxt ? nxt.id : null };
}

function DayBlock({ d }) {
  const hm = d.now.slice(11, 16);
  const active = d.lessons.filter((l) => l.status !== "cancelled");
  if (!d.lessons.length) {
    return d.published
      ? html`<div class="panel"><${Empty} scene=${html`<${WeekFigure} today=${weekday(d.date)} date=${d.date} />`} title="Сегодня пар нет" text="Это свободный день по опубликованному расписанию.">
          <${Link} class="btn" href="/schedule?view=week">Расписание недели</${Link}></${Empty}>
          <${DayFact} date=${d.date} /></div>
          ${d.next_day_lesson ? html`<${NextDay} d=${d} />` : html`<p class="meta" style="margin-top:12px;padding:0 2px">Следующих пар в опубликованном расписании нет — данные после этой недели ещё не опубликованы.</p>`}`
      : html`<div class="panel"><${Empty} scene=${html`<${FieldFigure} />`} title="Расписание на сегодня не опубликовано"
          text="Данных за этот день нет — это не то же самое, что свободный день. Проверьте позже или откройте опубликованную неделю." /></div>`;
  }
  const finished = active.length && active.every((l) => l.end <= hm);
  return html`
    <${Presence} show=${!!finished}><div class="banner" style="margin-bottom:8px"><${Icon} name="check" /><span class="grow">Пары на сегодня закончились.</span></div></${Presence}>
    <${Agenda} d=${d} />
    ${/* «Завтра» всегда в конце ленты: день виден целиком, и левая колонка не обрывается посреди экрана */ ""}
    <${Presence} show=${!!d.next_day_lesson}><${NextDay} d=${d} /></${Presence}>
    ${!d.next_day_lesson && html`<p class="meta" style="margin-top:12px;padding:0 2px">Следующих пар в опубликованном расписании нет — данные после этой недели ещё не опубликованы.</p>`}
  `;
}

function ChangeItem({ l, today }) {
  const [busy, setBusy] = useState(false);
  return html`<div class="todo" data-arrive="change">
    <span class="lead"><${Icon} name="swap" /></span>
    <div class="body">
      <div class="title">${changeText(l)}: ${l.subject}</div>
      <div class="meta">${relDay(l.date, today) === "завтра" ? "Завтра, " : ""}${shortDate(l.date)} · ${l.start}–${l.end}</div>
      <${ChangeLine} lesson=${l} />
      <div class="acts">
        <${Button} size="sm" kind="primary" icon="check" busy=${busy} onClick=${async () => { setBusy(true); try { await ackChange(l); } catch (e) {} setBusy(false); }}
          aria-label=${`Подтвердить: ${changeText(l).toLowerCase()} — ${l.subject}, ${shortDate(l.date)}`}>Подтвердить</${Button}>
        <${Link} class="btn btn-sm btn-ghost" href=${lessonHref(l)} overlay aria-label=${`Открыть занятие: ${l.subject}, ${shortDate(l.date)}`}>Открыть</${Link}>
      </div>
    </div>
  </div>`;
}

function DocItem({ r }) {
  const [busy, setBusy] = useState(false);
  return html`<div class="todo" data-arrive="doc">
    <span class="lead"><${Icon} name="doc" /></span>
    <div class="body">
      <div class="title">${r.type_label} готова</div>
      <div class="meta">Заявка №${r.id}${r.payload.language === "en" ? " · на английском" : ""} · демо-образец .txt</div>
      <div class="acts">
        <${Button} size="sm" kind="primary" icon="download" onClick=${() => download(`/api/requests/${r.id}/document`)}
          aria-label=${`Скачать: ${r.type_label}, заявка №${r.id}`}>Скачать</${Button}>
        <${Button} size="sm" icon="check" busy=${busy} onClick=${async () => { setBusy(true); try { await setReceived(r, true); } catch (e) {} setBusy(false); }}
          aria-label=${`Отметить получение: ${r.type_label}, заявка №${r.id}`}>Получено</${Button}>
      </div>
    </div>
  </div>`;
}

function Side({ d, highlightTask }) {
  const todayIds = new Set(d.lessons.map((l) => l.id));
  const changes = d.changes.filter((l) => !todayIds.has(l.id));
  const open = d.tasks.filter((t) => !t.done_at).sort((a, b) => (a.due_date + (a.due_time || "")).localeCompare(b.due_date + (b.due_time || "")));
  const done = d.tasks.filter((t) => t.done_at);
  const actions = changes.length + d.documents.length + d.answers.length;
  return html`<div class="today-side">
    ${/* заголовки секций — над плашками, как «Пары сегодня» слева: подписи и верх плашек обеих колонок на одной линии */ ""}
    <section class="side-sec" id="todo" aria-labelledby="todo-h">
      <div class="section-title"><h2 class="h2" id="todo-h">Нужно сделать</h2><span class="count count-quiet"><${Roll} value=${actions + open.length} /></span></div>
      <div class="panel">
      <${Presence} show=${actions === 0 && open.length === 0}><p class="empty-inline">Срочных дел нет: изменений, готовых документов и сроков на неделю нет.</p></${Presence}>
      <${AnimatedList} cls="divided" keyOf=${(it) => it.key} items=${[
        ...d.documents.map((r) => ({ key: "r" + r.id, kind: "doc", r })),
        ...d.answers.map((r) => ({ key: "a" + r.id, kind: "answer", r })),
        ...changes.map((l) => ({ key: "c" + l.id, kind: "change", l })),
        ...open.map((t) => ({ key: "t" + t.id, kind: "task", t })),
      ]} render=${(it) => it.kind === "doc" ? html`<${DocItem} r=${it.r} />`
        : it.kind === "answer" ? html`<div class="todo"><span class="lead"><${Icon} name="message" /></span><div class="body">
            <div class="title">Ответ деканата: ${it.r.title}</div><div class="meta">${stamp(it.r.updated_at, d.date)}</div>
            <div class="acts"><${Link} class="btn btn-sm" href=${`/documents/${it.r.id}`} overlay>Прочитать ответ</${Link}></div></div></div>`
        : it.kind === "change" ? html`<${ChangeItem} l=${it.l} today=${d.date} />`
        : html`<${TaskItem} task=${it.t} today=${d.date} highlight=${highlightTask === it.t.id} />`} />
      <${Presence} show=${done.length > 0}><details class="done-tasks"><summary class="meta"><${Icon} name="right" size=${14} cls="dt-chev" />Выполнено: <${Roll} value=${done.length} /></summary>
        <${AnimatedList} cls="divided" items=${done} keyOf=${(t) => t.id} render=${(t) => html`<${TaskItem} task=${t} today=${d.date} highlight=${highlightTask === t.id} />`} /></details></${Presence}>
      </div>
    </section>
    <section class="side-sec" aria-labelledby="order-h">
      <div class="section-title"><h2 class="h2" id="order-h">Заказать документ</h2><${Link} class="btn btn-sm btn-ghost panel-head-action" href="/documents">Все заявки</${Link}></div>
      <div class="panel"><div class="panel-body quick">
        <${Link} href="/documents/new/study_cert" overlay><${Icon} name="book" /><span class="grow">Справка об обучении</span><${Icon} name="plus" /></${Link}>
        <${Link} href="/documents/new/stipend_cert" overlay><${Icon} name="coin" /><span class="grow">Справка о стипендии</span><${Icon} name="plus" /></${Link}>
        <${Link} href="/documents/new/dean_appeal" overlay><${Icon} name="message" /><span class="grow">Обращение в деканат</span><${Icon} name="plus" /></${Link}>
      </div></div>
    </section>
  </div>`;
}

export function TodayPage({ route }) {
  const { data: raw, error, loading, reload } = useResource("today", "/api/today");
  const now = useDemoNow();
  const d = withClock(raw, now);
  const highlightTask = Number(route.search.get("task")) || null;
  useEffect(() => {
    if (highlightTask && d) {
      const el = document.getElementById(`task-${highlightTask}`);
      el && el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [highlightTask, !!d]);
  const user = state.session.user;
  const date = d ? d.date : user.demo_now.slice(0, 10);
  const todayIds = d ? new Set(d.lessons.map((l) => l.id)) : new Set();
  const otherChanges = d ? d.changes.filter((l) => !todayIds.has(l.id)).length : 0;
  const todayChange = d ? d.lessons.filter((l) => l.change && !l.change.acknowledged_at).length : 0;
  const openTasks = d ? d.tasks.filter((t) => !t.done_at).length : 0;
  return html`<div class="page page-today">
    <div class="page-head">
      ${/* заголовок и бейдж демо-времени — одной строкой с кнопками: шапка ровная, без «подвешенных» кнопок */ ""}
      <div class="titles title-row">
        <h1 class="h1" tabindex="-1" data-page-title>${longDate(date)}</h1>
        <${DemoClock} day=${raw} />
      </div>
      <div class="actions">
        <${Link} class="btn btn-ai" href="/summary/week" overlay><${Spark} />Сводка недели<span class="ai-go" aria-hidden="true"><${Icon} name="arrowRight" size=${14} /></span></${Link}>
        <${Link} class="btn hide-narrow" href=${withParams("/schedule", { view: "week", date })}><${Icon} name="calendar" />Вся неделя</${Link}>
      </div>
    </div>
    <${Presence} show=${!!(d && (todayChange + otherChanges + d.documents.length + openTasks > 0))}>${d && html`<nav class="summary-strip" aria-label="Коротко о дне">
      ${todayChange + otherChanges > 0 && html`<a class="chip" href=${todayChange ? "#day" : "#todo"}><${Icon} name="swap" size=${14} />${countOf(todayChange + otherChanges, "изменение", "изменения", "изменений")}</a>`}
      ${d.documents.length > 0 && html`<a class="chip" href="#todo" aria-label=${`${d.documents.length} ${plural(d.documents.length, "документ готов", "документа готовы", "документов готовы")}`}><${Icon} name="doc" size=${14} />${countOf(d.documents.length, "документ", "документа", "документов")}</a>`}
      ${openTasks > 0 && html`<a class="chip" href="#todo"><${Icon} name="clock" size=${14} />${countOf(openTasks, "срок", "срока", "сроков")}</a>`}
    </nav>`}</${Presence}>
    ${loading && !d ? html`<div class="today-grid"><div class="panel"><${Skeleton} rows=${4} /></div><div class="panel"><${Skeleton} rows=${3} /></div></div>`
      : error && !d ? html`<${LoadError} error=${error} onRetry=${reload} what="день" />`
      : html`<div class="today-grid">
        <section aria-labelledby="day-h" id="day">
          <div class="section-title"><h2 class="h2" id="day-h">Пары сегодня</h2>
            <span class="meta">${d.lessons.length ? countOf(d.lessons.filter((l) => l.status !== "cancelled").length, "пара", "пары", "пар") : ""}</span></div>
          <${DayBlock} d=${d} />
        </section>
        <${Side} d=${d} highlightTask=${highlightTask} />
      </div>`}
  </div>`;
}
