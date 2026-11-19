// «Оценки и сессия»: текущие баллы (не итог), сессия с допуском, завершённые аттестации.
import { html, useRef } from "../../vendor/preact-htm.js";
import { firstTime, CountUp } from "../motion.js";
import { Icon } from "../icons.js";
import { Button, Drawer, Empty, LoadError, Segmented, Skeleton } from "../ui.js";
import { Link, navigate, closeTo, withParams } from "../router.js";
import { useResource, state } from "../data.js";
import { download } from "../actions.js";
import { TaskItem } from "./lessons.js";
import { dayMonth, dayMonthYear, MONTHS_SHORT, parseDate, WD_SHORT, weekday, countOf, daysBetween, where, shortTeacher } from "../format.js";

const ADM = {
  admitted: { label: "Допуск есть", icon: "check" },
  not_admitted: { label: "Допуска нет", icon: "ban" },
  pending: { label: "Допуск решается", icon: "clock" },
};

function fmt(n) { return Number.isInteger(n) ? String(n) : String(n).replace(".", ","); }

function Score({ s }) {
  const p = s.score_max_so_far ? s.score / s.score_max_so_far : 0;
  const grow = useRef(null);
  if (grow.current === null) grow.current = firstTime("score:" + s.id);
  return html`<div class="score">
    <span class="v"><${CountUp} value=${s.score} id=${"score:" + s.id} format=${fmt} /> <span class="cap">из ${fmt(s.score_max_so_far)} за проверенные работы</span></span>
    <span class="bar" aria-hidden="true"><i class=${grow.current ? "grow" : ""} style=${`--p:${p}`}></i></span>
    <span class="small">максимум за семестр —\u00a0${s.semester_max}</span>
  </div>`;
}

// Допуск: статус строкой, пояснение — отдельной строкой под ним (без висящего тире при переносе).
function Admission({ e, cls = "" }) {
  const a = ADM[e.admission] || ADM.pending;
  return html`<div class=${"adm-wrap " + cls}><p class="adm"><${Icon} name=${a.icon} size=${14} />${a.label}</p>
    ${e.admission_note && html`<p class="adm-note">${e.admission_note}</p>`}</div>`;
}

function CurrentTab({ data, filter }) {
  const attention = data.subjects.filter((s) => s.attention);
  const list = filter === "attention" ? attention : data.subjects;
  return html`
    <div class="note" style="margin-bottom:16px"><${Icon} name="info" />
      <span><b style="color:var(--fg)">Текущий балл — не итоговая оценка.</b> Это сумма баллов за уже проверенные работы в демо-данных. Правила перевода в оценку и итог аттестации здесь не рассчитываются.</span></div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Фильтр дисциплин">
        <${Link} class="chip" replace href=${withParams("/grades", { tab: "current" })} aria-current=${filter !== "attention" ? "true" : undefined}>Все <span class="count">${data.subjects.length}</span></${Link}>
        <${Link} class="chip" replace href=${withParams("/grades", { tab: "current", filter: "attention" })} aria-current=${filter === "attention" ? "true" : undefined}><${Icon} name="alert" size=${14} />Требуют внимания <span class="count">${attention.length}</span></${Link}>
      </div>
      <span class="grow"></span>
      <${Button} icon="download" onClick=${() => download("/api/grades.csv")}>Баллы в CSV</${Button}>
    </div>
    ${list.length === 0 ? html`<div class="panel"><${Empty} title="Нет дисциплин, требующих внимания" text="По демо-данным все дисциплины идут без замечаний."><${Link} class="btn" replace href="/grades">Показать все</${Link}></${Empty}></div>`
      : html`<div class="panel" style="overflow:hidden"><table class="gtable">
        <thead><tr><th scope="col">Дисциплина</th><th scope="col">Контроль</th><th scope="col">Текущий балл</th></tr></thead>
        <tbody class="stagger">${list.map((s) => html`<tr key=${s.id} onClick=${(e) => { if (!e.target.closest("a")) navigate(`/grades/subject/${s.id}`, { state: { overlay: true } }); }}>
          <td class="subj"><${Link} href=${`/grades/subject/${s.id}`} overlay>${s.title}</${Link}>
            <div class="small" style="margin-top:2px">${shortTeacher(s.teacher)}</div>
            ${s.attention && html`<div class="attn"><${Icon} name="alert" size=${14} />${s.attention}</div>`}</td>
          <td class="ctl">${s.control}</td>
          <td><${Score} s=${s} /></td>
        </tr>`)}</tbody></table></div>`}
  `;
}

function SessionTab({ data }) {
  const today = state.session.user.demo_now.slice(0, 10);
  return html`
    <div class="toolbar">
      <p class="meta" style="flex:1;min-width:220px">Зимняя сессия: ${countOf(data.exams.length, "контрольное мероприятие", "контрольных мероприятия", "контрольных мероприятий")}. Допуск указан так, как он задан в демо-данных.</p>
      <${Button} icon="calExport" onClick=${() => download("/api/exams.ics")}>Вся сессия (.ics)</${Button}>
    </div>
    <div class="panel stagger">${data.exams.map((e) => {
      const d = parseDate(e.date);
      const left = daysBetween(today, e.date);
      return html`<div class="exam" key=${e.id}>
        <div class="date" aria-hidden="true"><b>${d.getUTCDate()}</b><span>${MONTHS_SHORT[d.getUTCMonth()]}</span></div>
        <div style="min-width:0">
          <div class="small">${e.kind} · ${WD_SHORT[weekday(e.date)]}, ${dayMonthYear(e.date)}\u00a0· через ${countOf(left, "день", "дня", "дней")}</div>
          <div class="h3" style="margin:2px 0 4px">${e.subject}</div>
          <div class="meta-2" style="display:flex;flex-wrap:wrap;gap:4px 12px">
            <span>${e.start}</span><span>${where(e.room, e.building)}</span><span>${shortTeacher(e.teacher)}</span></div>
          <${Admission} e=${e} cls="adm-mt" />
        </div>
        <div class="acts"><${Button} size="sm" icon="calExport" onClick=${() => download(`/api/exams/${e.id}.ics`)} aria-label=${`Добавить в календарь: ${e.kind}, ${e.subject}`}>.ics</${Button}></div>
      </div>`;
    })}</div>`;
}

function ResultsTab({ data }) {
  const groups = {};
  data.past_results.forEach((r) => { (groups[r.semester] = groups[r.semester] || []).push(r); });
  return html`
    <div class="note" style="margin-bottom:16px"><${Icon} name="info" /><span><b style="color:var(--fg)">Завершённые аттестации</b> — итоговые результаты прошлых сессий (демо-данные). Текущие баллы этого семестра сюда не входят.</span></div>
    ${Object.entries(groups).map(([sem, rows]) => html`<section class="section" key=${sem}>
      <div class="section-title"><h2 class="h2">${sem}</h2></div>
      <div class="panel" style="overflow:hidden"><table class="gtable is-static">
        <colgroup><col /><col class="c-ctl" /><col class="c-res" /></colgroup>
        <thead><tr><th scope="col">Дисциплина</th><th scope="col">Форма</th><th scope="col">Итог</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr key=${r.id}><td>${r.title}<div class="small">${dayMonthYear(r.date)}</div></td><td class="ctl">${r.control}</td><td class="strong">${r.result}</td></tr>`)}</tbody>
      </table></div></section>`)}`;
}

export function GradesPage({ route }) {
  const { data, error, loading, reload } = useResource("grades", "/api/grades");
  const tab = ["current", "session", "results"].includes(route.search.get("tab")) ? route.search.get("tab") : "current";
  const filter = route.search.get("filter");
  return html`<div class="page">
    <div class="page-head"><div class="titles"><h1 class="h1" tabindex="-1" data-page-title>Оценки и сессия</h1>
      <p class="meta">${data ? `${countOf(data.subjects.length, "дисциплина", "дисциплины", "дисциплин")} в семестре` : "Осенний семестр 2026"}</p></div></div>
    <div class="toolbar">
      <${Segmented} label="Раздел" value=${tab} onChange=${(v) => navigate(withParams("/grades", { tab: v === "current" ? undefined : v }), { replace: true })}
        options=${[{ value: "current", label: "Текущие баллы" }, { value: "session", label: "Сессия" }, { value: "results", label: "Итоги" }]} />
    </div>
    ${loading && !data ? html`<div class="panel"><${Skeleton} rows=${5} /></div>`
      : error && !data ? html`<${LoadError} error=${error} onRetry=${reload} what="оценки" />`
      : tab === "session" ? html`<${SessionTab} data=${data} />`
      : tab === "results" ? html`<${ResultsTab} data=${data} />`
      : html`<${CurrentTab} data=${data} filter=${filter} />`}
  </div>`;
}

export function SubjectDrawer({ id, parentHref }) {
  const { data: s, error, loading, reload } = useResource(`subject:${id}`, `/api/subjects/${id}`);
  const grades = useResource("grades", "/api/grades").data;
  const exam = s && grades && grades.exams.find((e) => e.id === s.exam_id);
  const today = state.session.user.demo_now.slice(0, 10);
  let body;
  if (loading && !s) body = html`<${Skeleton} rows=${3} />`;
  else if (error && !s) body = html`<${LoadError} error=${error} onRetry=${reload} what="дисциплину" />`;
  else body = html`
    <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="tag tag-quiet">${s.control}</span>${s.attention && html`<span class="tag tag-solid"><${Icon} name="alert" size=${12} />Требует внимания</span>`}</div>
    <h2 class="detail-title">${s.title}</h2>
    <p class="meta-2">${s.teacher}</p>
    ${s.attention && html`<div class="change-box"><div class="attn-line"><${Icon} name="alert" /><b>${s.attention}</b></div></div>`}
    <div class="detail-sec"><span class="eyebrow">Текущий балл</span><${Score} s=${s} />
      <p class="small" style="margin-top:8px">Сумма баллов за проверенные работы. Это не итоговая оценка.</p></div>
    <div class="detail-sec"><span class="eyebrow">Работы · ${s.items.length}</span>
      ${s.items.length ? html`<div class="items">${s.items.map((i) => html`<div class="it" key=${i.id}>
        <div><div>${i.title}</div><div class="small">${i.kind} · ${dayMonth(i.date)}</div></div>
        <div class="v">${fmt(i.score)}<span class="muted" style="font-weight:400"> / ${fmt(i.max)}</span></div></div>`)}</div>`
        : html`<p class="meta">Проверенных работ пока нет.</p>`}</div>
    ${s.tasks && s.tasks.length > 0 && html`<div class="detail-sec"><span class="eyebrow">Сроки</span><div class="panel">${s.tasks.map((t) => html`<${TaskItem} key=${t.id} task=${t} today=${today} hideSubject />`)}</div></div>`}
    ${exam && html`<div class="detail-sec"><span class="eyebrow">Сессия</span>
      <p>${exam.kind}: ${WD_SHORT[weekday(exam.date)]}, ${dayMonthYear(exam.date)}, ${exam.start}\u00a0· ${where(exam.room, exam.building)}</p>
      <${Admission} e=${exam} cls="adm-mt-sm" /></div>`}
  `;
  return html`<${Drawer} label=${s ? `Дисциплина: ${s.title}` : "Дисциплина"} crumb="Оценки · дисциплина" onClose=${() => closeTo(parentHref)}
    footer=${exam && ((leave) => html`<${Button} icon="calExport" onClick=${() => download(`/api/exams/${exam.id}.ics`)} aria-label=${`${exam.kind} в календарь (.ics)`}>В календарь</${Button}>
      <a class="btn btn-ghost" href="/grades?tab=session" onClick=${(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); leave(() => navigate("/grades?tab=session", { replace: true })); }}>Вся сессия</a>`)}>${body}</${Drawer}>`;
}
