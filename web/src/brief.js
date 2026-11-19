// Короткий текст сводок: связные предложения из данных, по шаблонам, без ИИ.
// Ничего не добавляет от себя: каждое утверждение — пересказ одного события из кабинета.
import { countOf, dayMonth, relDay, where, weekday, WEEKDAYS, WEEKDAYS_ACC } from "./format.js";

const WD_NOM = WEEKDAYS; // понедельник…
const lc = (s) => (s && !/^[А-ЯЁA-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sentence = (s) => cap(s.trim().replace(/[.;,\s]+$/, "")) + ".";

function joinRu(items, last = "и") {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + ` ${last} ` + items[items.length - 1];
}

function when(date, today) {
  const r = relDay(date, today);
  return r === dayMonth(date) ? dayMonth(date) : r; // «сегодня», «завтра», «в среду» или «19 ноября»
}

// Место внутри предложения: «ауд. 318, корпус Б», «компьютерный класс 4, корпус В».
const place = (room, building) => lc(where(room, building));

// Подряд идущие даты сворачиваются в диапазон: «с 23 по 27 ноября».
function datesPhrase(dates) {
  if (dates.length === 1) return dayMonth(dates[0]);
  const consecutive = dates.every((d, i) => i === 0 || (Date.parse(d) - Date.parse(dates[i - 1])) === 86400000);
  if (consecutive && dates[0].slice(5, 7) === dates[dates.length - 1].slice(5, 7)) return `с ${Number(dates[0].slice(8))} по ${dayMonth(dates[dates.length - 1])}`;
  if (consecutive) return `с ${dayMonth(dates[0])} по ${dayMonth(dates[dates.length - 1])}`;
  return joinRu(dates.map(dayMonth));
}

// «Международное публичное право в среду перенесли на 12:40»
function changePhrase(l, today) {
  const c = l.change;
  const d = when(l.date, today);
  if (c.kind === "cancelled") return `${l.subject} ${d} отменили`;
  if (c.kind === "room") return `${l.subject} ${d} — теперь ${place(l.room, l.building)}`;
  if (c.kind === "time") return `${l.subject} ${d} перенесли на ${l.start}`;
  return `${l.subject} ${d} перенесли на ${l.start}, ${place(l.room, l.building)}`;
}

function docPhrase(it) {
  const r = it.request;
  if (it.status === "answered") return `деканат ответил по обращению «${r.title}»`;
  if (it.status === "ready") return `готова ${lc(r.type_label)} (№${r.id}) — можно скачать`;
  if (it.status === "rejected") return `заявку «${r.title}» отклонили`;
  return `${lc(r.type_label)} №${r.id} передана в работу`;
}

// «С прошлого визита» — 1–4 предложения.
export function sinceBrief(groups, today) {
  const out = [];
  if (groups.schedule.length) out.push(sentence(groups.schedule.map((it) => changePhrase(it.lesson, today)).join("; ")));
  if (groups.documents.length) out.push(sentence(joinRu(groups.documents.map(docPhrase))));
  groups.deadlines.forEach((it) => out.push(sentence(it.task
    ? (it.task.done ? `${it.task.title} — выполнено` : it.task.due_date < today ? `${it.task.title} — срок прошёл ${dayMonth(it.task.due_date)}`
      : `${it.task.title} — срок ${when(it.task.due_date, today)}${it.task.due_time ? ", " + it.task.due_time : ""}`)
    : it.notification.title)));
  groups.announcements.forEach((it) => out.push(sentence(`Объявление: ${it.notification.title}`)));
  return out.join(" ");
}

// Дни подряд: «с понедельника по пятницу»; иначе «в понедельник, среду и пятницу».
const FREE_ONE = ["свободен", "свободен", "свободна", "свободен", "свободна", "свободна", "свободно"];
const WD_GEN = ["понедельника", "вторника", "среды", "четверга", "пятницы", "субботы", "воскресенья"];
function daysPhrase(dates) {
  const idx = dates.map(weekday);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (idx.length >= 3 && contiguous) return `с ${WD_GEN[idx[0]]} по ${WEEKDAYS_ACC[idx[idx.length - 1]]}`;
  return (idx[0] === 1 ? "во " : "в ") + joinRu(idx.map((i) => WEEKDAYS_ACC[i]));
}

// Перечисление с ограничением: «a; b и ещё 2».
function limited(items, max, sep = "; ") {
  if (items.length <= max) return items.join(sep);
  return items.slice(0, max).join(sep) + ` и ещё ${items.length - max}`;
}

// «Сводка недели» — 3–6 предложений.
export function weekBrief(w) {
  const today = w.from;
  const out = [];
  const study = w.days.filter((d) => d.count > 0);
  const free = w.days.filter((d) => d.state === "free" || (d.state === "lessons" && d.count === 0));
  const nodata = w.days.filter((d) => d.state === "no_data");
  const span = weekday(w.from) === 0 ? "за неделю" : "за 7 дней";
  if (study.length) {
    let s = `${countOf(w.lessons_total, "пара", "пары", "пар")} ${span}, занятия ${daysPhrase(study.map((d) => d.date))}`;
    if (free.length) s += `; ${joinRu(free.map((d) => WD_NOM[weekday(d.date)]))} ${free.length > 1 ? "свободны" : FREE_ONE[weekday(free[0].date)]}`;
    out.push(sentence(s));
    const max = Math.max(...study.map((d) => d.count));
    const top = study.filter((d) => d.count === max);
    if (max >= 3 && top.length === 1) out.push(sentence(`Самый плотный день — ${WD_NOM[weekday(top[0].date)]}: ${countOf(max, "пара", "пары", "пар")}, ${top[0].first.start}–${top[0].last_end}`));
  } else if (free.length) {
    out.push(sentence(`Пар ${span} нет: ${joinRu(free.map((d) => WD_NOM[weekday(d.date)]))} ${free.length > 1 ? "свободны" : FREE_ONE[weekday(free[0].date)]}`));
  }
  if (nodata.length) out.push(sentence(`${cap(datesPhrase(nodata.map((d) => d.date)))} расписание ещё не опубликовано`));
  if (w.changes.length) {
    const unacked = w.changes.filter((l) => !l.change.acknowledged_at).length;
    const state = unacked === 0 ? "все подтверждены" : unacked === w.changes.length ? (w.changes.length > 1 ? "все ждут подтверждения" : "ждёт подтверждения") : `${unacked} ${unacked > 1 ? "ждут" : "ждёт"} подтверждения`;
    out.push(sentence(`${countOf(w.changes.length, "изменение", "изменения", "изменений")} (${state}): ${limited(w.changes.map((l) => changePhrase(l, today)), 2)}`));
  }
  if (w.tasks.length) {
    const items = w.tasks.map((t) => (t.overdue ? `${lc(t.title)} (${overdueAt(t, today)})` : `${lc(t.title)} — ${when(t.due_date, today)}${t.due_time ? ", " + t.due_time : ""}`));
    out.push(sentence(`Сроки: ${limited(items, 3)}`));
  }
  if (w.documents_ready.length === 1) out.push(sentence(`Готова ${lc(w.documents_ready[0].type_label)} — можно скачать`));
  else if (w.documents_ready.length > 1) out.push(sentence(`Готовы документы: ${docsPhrase(w.documents_ready)}`));
  if (w.next_exam) out.push(sentence(`Ближайшее в сессии — ${lc(w.next_exam.kind)} «${w.next_exam.subject}», ${dayMonth(w.next_exam.date)}`));
  return out.join(" ");
}

// Короткая «Сводка недели» (2–3 предложения): только то, что изменилось и что нужно сделать.
// Показывается, когда модель недоступна, — тот же объём, что и у ответа модели.
// «справка об обучении (2), справка о стипендии» — одинаковые типы считаются, а не повторяются.
function docsPhrase(list) {
  const by = new Map();
  list.forEach((r) => by.set(r.type_label, (by.get(r.type_label) || 0) + 1));
  return [...by.entries()].map(([t, n]) => (n > 1 ? `${lc(t)} (${n})` : lc(t))).join(", ");
}
function overdueAt(t, today) { return t.due_date === today && t.due_time ? `срок прошёл в ${t.due_time}` : `срок прошёл ${dayMonth(t.due_date)}`; }

export function weekBriefShort(w) {
  const today = w.from;
  const out = [];
  if (w.changes.length) {
    const unacked = w.changes.filter((l) => !l.change.acknowledged_at).length;
    out.push(sentence(`${countOf(w.changes.length, "изменение", "изменения", "изменений")}: ${limited(w.changes.map((l) => changePhrase(l, today)), 3)}${unacked ? (unacked === w.changes.length ? " — стоит подтвердить" : ` — ${unacked} ещё не подтверждено`) : ""}`));
  } else {
    out.push(sentence(`Изменений в расписании нет: ${countOf(w.lessons_total, "пара", "пары", "пар")} по плану`));
  }
  const open = w.tasks.filter((t) => !t.overdue);
  const overdue = w.tasks.length - open.length;
  if (open.length) {
    const t = open[0];
    out.push(sentence(`Ближайший срок — ${lc(t.title)}, ${when(t.due_date, today)}${t.due_time ? ", " + t.due_time : ""}${open.length > 1 ? `, и ещё ${open.length - 1}` : ""}${overdue ? `; ${countOf(overdue, "срок уже прошёл", "срока уже прошли", "сроков уже прошли")}` : ""}`));
  } else if (overdue) out.push(sentence(`${countOf(overdue, "срок уже прошёл", "срока уже прошли", "сроков уже прошли")}`));
  if (w.documents_ready.length === 1) out.push(sentence(`${w.documents_ready[0].type_label} готова`));
  else if (w.documents_ready.length > 1) out.push(sentence(`Готовы документы: ${docsPhrase(w.documents_ready)}`));
  return out.join(" ");
}
