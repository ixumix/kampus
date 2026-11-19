// Сводки: «С прошлого визита» на «Сегодня» и «Сводка недели» в окне.
// «С прошлого визита» и подробности недели считаются из данных аккаунта шаблонами.
// Короткий абзац недели пишет модель (DeepSeek, если на сервере есть ключ): сервер передаёт ей только факты недели
// и отбрасывает ответ, в котором есть число, которого нет в данных; тогда показывается шаблонный абзац.
import { html, useEffect, useLayoutEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { Spark } from "../spark.js";
import { firstTime, reduced } from "../motion.js";
import { Icon } from "../icons.js";
import { Button, Dialog, LoadError, Skeleton } from "../ui.js";
import { Link, closeTo, withParams } from "../router.js";
import { api, useResource, state, patchAll, refreshAfterWrite, toast } from "../data.js";
import { Presence } from "../motion.js";
import { sinceBrief, weekBriefShort as weekBrief } from "../brief.js";
import { lessonHref, changeText } from "./lessons.js";
import { countOf, dayMonth, shortDate, longDate, stamp, where, weekRange, mondayOf, relDay, WD_SHORT, weekday, MONTHS_GEN } from "../format.js";

// ---------------------------------------------------------------- тексты
function changeDelta(l) {
  const c = l.change;
  if (!c) return "";
  if (c.kind === "cancelled") return "отменено";
  if (c.kind === "room") return `${where(c.old.room, c.old.building)} → ${where(l.room, l.building)}`;
  if (c.kind === "time") return `${c.old.start}–${c.old.end} → ${l.start}–${l.end}`;
  return `${c.old.start} → ${l.start}, ${where(l.room, l.building)}`;
}

export function sinceSentence(g) {
  const parts = [];
  if (g.schedule.length) parts.push(countOf(g.schedule.length, "изменение в расписании", "изменения в расписании", "изменений в расписании"));
  if (g.documents.length) parts.push(g.documents.length === 1
    ? (g.documents[0].status === "answered" ? "ответ деканата" : g.documents[0].status === "ready" ? "документ готов" : "обновление по заявке")
    : countOf(g.documents.length, "обновление по заявкам", "обновления по заявкам", "обновлений по заявкам"));
  if (g.deadlines.length) parts.push(countOf(g.deadlines.length, "новый срок", "новых срока", "новых сроков"));
  if (g.announcements.length) parts.push(countOf(g.announcements.length, "объявление", "объявления", "объявлений"));
  return parts.join(" · ");
}

// ------------------------------------------------------- С прошлого визита
function SinceRow({ it, today }) {
  if (it.kind === "change") {
    const l = it.lesson, acked = l.change && l.change.acknowledged_at;
    return html`<${Link} class="since-row" href=${lessonHref(l)} overlay>
      <span class="lead"><${Icon} name=${l.status === "cancelled" ? "ban" : "swap"} /></span>
      <span class="body"><span class="t">${changeText(l)}: ${l.subject}</span>
        <span class="m">${shortDate(l.date)} · ${changeDelta(l)}</span></span>
      <span class=${"tag" + (acked ? "" : " tag-solid")}>${acked ? "подтверждено" : "не подтверждено"}</span>
    </${Link}>`;
  }
  if (it.kind === "request") {
    const r = it.request;
    return html`<${Link} class="since-row" href=${`/documents/${r.id}`} overlay>
      <span class="lead"><${Icon} name="doc" /></span>
      <span class="body"><span class="t">${r.title}: ${it.status_label.toLowerCase()}</span>
        <span class="m">${r.type_label} · №${r.id} · ${stamp(it.at, today)}</span></span>
    </${Link}>`;
  }
  const n = it.notification;
  return html`<${Link} class="since-row" href=${withParams("/notifications", { id: n.id })}>
    <span class="lead"><${Icon} name=${it.kind === "deadline" ? "clock" : "megaphone"} /></span>
    <span class="body"><span class="t">${n.title}</span><span class="m">${n.category_label} · ${stamp(it.at, today)}</span></span>
  </${Link}>`;
}

const GROUPS = [["schedule", "Расписание"], ["documents", "Документы"], ["deadlines", "Сроки"], ["announcements", "Объявления"]];

export function SinceStrip() {
  const { data: s, error, reload } = useResource("summary", "/api/summary");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = state.session.user.demo_now.slice(0, 10);
  const seen = async (at) => {
    setBusy(true);
    try {
      const res = await api("POST", "/api/summary/seen", at ? { at } : {});
      if (!at) {
        patchAll((key, d) => (key === "summary" ? { ...d, since: res.last_visit, total: 0, groups: { schedule: [], documents: [], deadlines: [], announcements: [] } } : undefined));
        setOpen(false);
        toast("Отмечено как просмотренное", { action: { label: "Вернуть", fn: () => seen(res.previous) } });
      }
      refreshAfterWrite(["summary"]);
    } catch (e) {
      toast(e.network ? "Нет связи с сервером — отметка не сохранена" : e.message);
    }
    setBusy(false);
  };
  if (error && !s) return null; // сводка вторична: сбой не мешает дню
  const show = !!(s && s.total > 0);
  return html`<${Presence} show=${show}>${s && html`<section class="since" aria-labelledby="since-h">
    <div class="since-head">
      <span class="since-ic" aria-hidden="true"><${Icon} name="summary" /></span>
      <div class="grow">
        <h2 class="since-title" id="since-h">С прошлого визита <span class="meta">· ${stamp(s.since, today)}</span></h2>
        <p class="since-text">${sinceSentence(s.groups)}</p>
        <p class="since-brief">${sinceBrief(s.groups, today)}</p>
      </div>
      <div class="since-acts">
        <${Button} size="sm" kind="ghost" aria-expanded=${open ? "true" : "false"} aria-controls="since-list" onClick=${() => setOpen(!open)}
          iconRight=${open ? "up" : "down"}>${open ? "Свернуть" : "Подробнее"}</${Button}>
        <${Button} size="sm" icon="check" busy=${busy} onClick=${() => seen()}>Понятно</${Button}>
      </div>
    </div>
    <${Presence} show=${open}><div class="since-list" id="since-list">
      ${GROUPS.filter(([k]) => s.groups[k].length).map(([k, label]) => html`<div class="since-group" key=${k}>
        <div class="eyebrow">${label}</div>
        ${s.groups[k].map((it, i) => html`<${SinceRow} key=${k + i} it=${it} today=${today} />`)}
      </div>`)}
    </div></${Presence}>
  </section>`}</${Presence}>`;
}

// ------------------------------------------------------------ Сводка недели
function shortText(text, w, user) {
  return `Сводка недели ${weekRangeText(w)} — ${user.short_name}, ${user.group_name}\n\n${text}\n\nДемонстрационные данные «Кампуса».`;
}

function weekRangeText(w) {
  return w.from.slice(5, 7) === w.to.slice(5, 7) ? `${Number(w.from.slice(8))}–${dayMonth(w.to)}` : `${dayMonth(w.from)} – ${dayMonth(w.to)}`;
}

const FALLBACK_NOTE = {
  unverified: "Ответ модели не прошёл проверку фактов — показан текст по шаблону",
  upstream: "Модель сейчас недоступна — показан текст по шаблону",
  auth: "Ключ модели не принят — показан текст по шаблону",
  rate_limited: "Слишком много запросов к модели — показан текст по шаблону",
  network: "Нет связи с сервером — показан текст по шаблону",
};

// Ссылки абзаца на дни недели: «в четверг», «18 ноября», «немецкий» (предмет изменения) → индекс дня 0–6.
const WD_FORMS = ["понедельник[а-яё]*", "вторник[а-яё]*", "сред[аыуе]", "четверг[а-яё]*", "пятниц[аыуе]", "суббот[аыуе]", "воскресень[еяю]"];
function dayRefs(w) {
  if (!w || !w.days) return [];
  const refs = w.days.map((d, i) => ({ re: `${WD_FORMS[weekday(d.date)]}|${Number(d.date.slice(8))} ${MONTHS_GEN[Number(d.date.slice(5, 7)) - 1]}`, day: i }));
  (w.changes || []).forEach((l) => {
    const i = w.days.findIndex((d) => d.date === l.date);
    // Предмет узнаём по полному названию или по первому слову, если оно длинное и предметное («немецкий», «международное»):
    // короткие общие слова («очень», «курс») не связываются с днём.
    if (i < 0) return;
    refs.push({ re: l.subject.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), day: i });
    const w0 = l.subject.split(/\s+/)[0].toLowerCase();
    if (w0.length >= 7 && !/^(очень|курс|основ)/.test(w0)) refs.push({ re: `${w0.slice(0, 6)}[а-яё]*`, day: i });
  });
  return refs;
}
function segment(text, refs) {
  if (!refs.length) return [{ s: text }];
  const re = new RegExp(`(?<![а-яё])(${refs.map((r) => r.re).join("|")})(?![а-яё])`, "giu");
  const out = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    const hit = refs.find((r) => new RegExp(`^(?:${r.re})$`, "iu").test(m[0]));
    if (m.index > last) out.push({ s: text.slice(last, m.index) });
    out.push({ s: m[0], day: hit ? hit.day : null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ s: text.slice(last) });
  return out;
}

// Абзац печатается по словам — один раз за сессию для одного и того же текста.
// Упоминания дней (и предметов изменений) связаны с полоской недели под абзацем: наведение подсвечивает обе стороны.
export function Typed({ text, refs = [], hot = null, onHot }) {
  const animate = useRef(!reduced() && firstTime("typed:" + text));
  let k = 0;
  const words = (s) => s.split(/(\s+)/).map((wd, i) => /^\s+$/.test(wd) || !animate.current ? wd
    : html`<span class="ai-w" aria-hidden="true" key=${i} style=${`--i:${k++}`}>${wd}</span>`);
  const segs = segment(text, refs);
  return html`<p class="ai-text" aria-label=${animate.current ? text : undefined}>${segs.map((g, i) => g.day == null ? words(g.s)
    : html`<span class=${"ai-ref" + (hot === g.day ? " is-hot" : "")} key=${"r" + i} onPointerEnter=${() => onHot && onHot(g.day)} onPointerLeave=${() => onHot && onHot(null)}>${words(g.s)}</span>`)}</p>`;
}

// Полоска недели под абзацем: столбик на день по числу пар, точка — есть изменения; сегодня подчёркнуто.
function WeekStrip({ w, today, hot, onHot }) {
  const max = Math.max(4, ...w.days.map((d) => d.count || 0));
  return html`<div class="ai-days" aria-hidden="true">${w.days.map((d, i) => html`<span key=${d.date}
      class=${"ai-day" + (hot === i ? " is-hot" : "") + (d.date === today ? " is-today" : "") + (d.state === "no_data" ? " is-nodata" : "")}
      onPointerEnter=${() => onHot(i)} onPointerLeave=${() => onHot(null)}>
      <span class="ai-col"><i style=${`height:${Math.round(((d.count || 0) / max) * 100)}%`}></i></span>
      <b>${WD_SHORT[weekday(d.date)]}</b>${d.changes > 0 && html`<span class="ai-chg"></span>`}
    </span>`)}</div>`;
}

function useWeekAI(w) {
  const enabled = !!(state.session.meta && state.session.meta.ai);
  const [res, setRes] = useState(enabled ? null : { ok: false, reason: "no_key" });
  useEffect(() => {
    if (!w || !enabled) return;
    let live = true;
    api("POST", "/api/summary/week/ai", {}, { quiet: true })
      .then((r) => live && setRes(r))
      .catch((e) => live && setRes({ ok: false, reason: e.network ? "network" : "upstream" }));
    return () => { live = false; };
  }, [!!w]);
  return { enabled, res };
}

function WeekBriefBlock({ w, ai, today }) {
  const [hot, setHot] = useState(null);
  const { enabled, res } = ai;
  const pending = enabled && !res;
  const fromModel = res && res.ok;
  const text = fromModel ? res.text : weekBrief(w);
  // Ответ модели выше заглушки: блок дорастает до него, а не прыгает (нижние кнопки едут вместе с ним).
  const ref = useRef(null), lastH = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (lastH.current && Math.abs(h - lastH.current) > 1 && !reduced()) {
      el.style.overflow = "hidden";
      el.animate([{ height: lastH.current + "px" }, { height: h + "px" }], { duration: 300, easing: "cubic-bezier(.23,1,.32,1)" })
        .finished.then(() => { el.style.overflow = ""; }, () => {});
    }
    lastH.current = h;
  }, [pending, text]);
  return html`<section class="ai-brief" ref=${ref} aria-labelledby="ws-brief" aria-busy=${pending ? "true" : "false"}>
    <div class="ai-head">
      <${Spark} size=${18} busy=${pending} />
      <h3 class="ai-title" id="ws-brief">Коротко</h3>
      ${enabled && html`<span class="ai-chip">AI</span>`}
    </div>
    ${pending
      ? html`<div class="ai-wait" role="status"><span class="sr-only">Модель пишет сводку…</span><i style="width:96%"></i><i style="width:88%"></i><i style="width:62%"></i></div>`
      : html`<${Typed} key=${text} text=${text} refs=${dayRefs(w)} hot=${hot} onHot=${setHot} />
        <${WeekStrip} w=${w} today=${today} hot=${hot} onHot=${setHot} />`}
    <p class="ai-src">${pending ? "Модель пишет по данным недели…"
      : fromModel ? `${res.model} по данным кабинета · даты, время и аудитории сверены с расписанием`
      : enabled && FALLBACK_NOTE[res.reason] ? FALLBACK_NOTE[res.reason] : "Собрано из данных кабинета"}</p>
  </section>`;
}

function WeekDetails({ w, today }) {
  const unacked = w.changes.filter((l) => !l.change.acknowledged_at).length;
  return html`
      <ul class="week-stats" aria-label="В цифрах">
        <li><b>${w.lessons_total}</b> ${countOf(w.lessons_total, "пара", "пары", "пар").replace(/^\d+ /, "")}</li>
        <li><b>${w.changes.length}</b> ${countOf(w.changes.length, "изменение", "изменения", "изменений").replace(/^\d+ /, "")}${unacked ? html`<span class="sub">${countOf(unacked, "не подтверждено", "не подтверждены", "не подтверждены")}</span>` : ""}</li>
        <li><b>${w.tasks.length}</b> ${countOf(w.tasks.length, "срок", "срока", "сроков").replace(/^\d+ /, "")}</li>
        <li><b>${w.documents_ready.length}</b> ${countOf(w.documents_ready.length, "документ готов", "документа готовы", "документов готовы").replace(/^\d+ /, "")}</li>
      </ul>
      <section class="detail-sec" aria-labelledby="ws-days"><h3 class="eyebrow" id="ws-days">По дням</h3>
        <div class="ws-days">${w.days.map((d) => html`<${Link} class=${"ws-day" + (d.date === today ? " is-today" : "")} href=${withParams("/schedule", { view: "day", date: d.date })} key=${d.date}>
          <span class="ws-d"><b>${WD_SHORT[weekday(d.date)]}</b> ${dayMonth(d.date)}</span>
          <span class="ws-v">${d.state === "no_data" ? html`<span class="muted">нет данных</span>` : !d.count ? html`<span class="muted">свободный день</span>`
            : html`${countOf(d.count, "пара", "пары", "пар")}, ${d.first.start}–${d.last_end} <span class="muted">· первая: ${d.first.subject}, ${where(d.first.room, d.first.building)}</span>`}</span>
          ${d.changes > 0 && html`<span class="tag">${countOf(d.changes, "изменение", "изменения", "изменений")}</span>`}
        </${Link}>`)}</div></section>
      ${w.changes.length > 0 && html`<section class="detail-sec"><h3 class="eyebrow">Изменения</h3>
        ${w.changes.map((l) => html`<${Link} class="since-row" href=${lessonHref(l)} overlay key=${l.id}>
          <span class="lead"><${Icon} name=${l.status === "cancelled" ? "ban" : "swap"} /></span>
          <span class="body"><span class="t">${l.subject}</span><span class="m">${shortDate(l.date)} · ${changeDelta(l)}</span></span>
          <span class=${"tag" + (l.change.acknowledged_at ? "" : " tag-solid")}>${l.change.acknowledged_at ? "подтверждено" : "не подтверждено"}</span>
        </${Link}>`)}</section>`}
      ${w.tasks.length > 0 && html`<section class="detail-sec"><h3 class="eyebrow">Сроки</h3>
        ${w.tasks.map((t) => html`<${Link} class="since-row" href=${withParams("/", { task: t.id })} key=${t.id}>
          <span class="lead"><${Icon} name=${t.overdue ? "alert" : "clock"} /></span>
          <span class="body"><span class="t">${t.title}</span><span class=${"m" + (t.overdue ? " strong-fg" : "")}>${t.overdue ? (t.due_date === today && t.due_time ? `срок прошёл в ${t.due_time}` : `срок прошёл ${dayMonth(t.due_date)}`) : `${relDay(t.due_date, today)}${t.due_time ? ", " + t.due_time : ""}`}${t.subject ? "\u00a0· " + t.subject : ""}</span></span>
        </${Link}>`)}</section>`}
      ${(w.documents_ready.length > 0 || w.requests_open > 0) && html`<section class="detail-sec"><h3 class="eyebrow">Документы</h3>
        ${w.documents_ready.map((r) => html`<${Link} class="since-row" href=${`/documents/${r.id}`} overlay key=${r.id}>
          <span class="lead"><${Icon} name="doc" /></span><span class="body"><span class="t">${r.title} готова</span><span class="m">Заявка №${r.id} · можно скачать</span></span></${Link}>`)}
        ${w.requests_open > 0 && html`<p class="meta" style="padding:6px 8px">${countOf(w.requests_open, "заявка", "заявки", "заявок")} в обработке</p>`}</section>`}
      ${w.next_exam && html`<section class="detail-sec"><h3 class="eyebrow">Сессия</h3>
        <${Link} class="since-row" href="/grades?tab=session"><span class="lead"><${Icon} name="grades" /></span>
          <span class="body"><span class="t">${w.next_exam.kind}: ${w.next_exam.subject}</span><span class="m">${longDate(w.next_exam.date)}, ${w.next_exam.start} · ближайшее контрольное мероприятие</span></span></${Link}></section>`}`;
}

export function WeekSummary({ parentHref }) {
  const { data: w, error, loading, reload } = useResource("summary:week", "/api/summary/week");
  const user = state.session.user;
  const today = user.demo_now.slice(0, 10);
  const ai = useWeekAI(w);
  const [more, setMore] = useState(false);
  const close = () => closeTo(parentHref);
  const shown = w && (ai.res && ai.res.ok ? ai.res.text : weekBrief(w));
  const copy = async () => {
    try { await navigator.clipboard.writeText(shortText(shown, w, user)); toast("Сводка скопирована"); }
    catch (e) { toast("Не удалось скопировать — разрешите доступ к буферу обмена"); }
  };
  let body;
  if (loading && !w) body = html`<${Skeleton} rows=${3} />`;
  else if (error && !w) body = html`<${LoadError} error=${error} onRetry=${reload} what="сводку" />`;
  else body = html`
    <${WeekBriefBlock} w=${w} ai=${ai} today=${today} />
    <button type="button" class="ws-more" aria-expanded=${more ? "true" : "false"} aria-controls="ws-details" onClick=${() => setMore(!more)}>
      ${more ? "Скрыть подробности" : "Подробнее: по дням, изменения, сроки"}<${Icon} name=${more ? "up" : "down"} /></button>
    <${Presence} show=${more}><div id="ws-details"><${WeekDetails} w=${w} today=${today} /></div></${Presence}>`;
  return html`<${Dialog} title="Сводка недели" subtitle=${w ? `${weekRangeText(w)} · по демо-времени` : "Собираем…"} onClose=${close} labelId="ws-title"
    footer=${w && html`<${Button} icon="copy" onClick=${copy} disabled=${!!(ai.enabled && !ai.res)}>Скопировать</${Button}><span class="grow"></span>
      <${Button} kind="primary" onClick=${close}>Готово</${Button}>`}>
    ${body}
  </${Dialog}>`;
}
