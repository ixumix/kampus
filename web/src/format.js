// Даты и числа по-русски. Все расчёты — от демо-времени сервера, не от часов компьютера.
export const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
export const WEEKDAYS_ACC = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
export const WD_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
export const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function parseDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function isoDate(d) { return d.toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = parseDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }
export function weekday(iso) { return (parseDate(iso).getUTCDay() + 6) % 7; }
export function mondayOf(iso) { return addDays(iso, -weekday(iso)); }
export function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
export function isValidIso(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseDate(s)) && isoDate(parseDate(s)) === s; }

export function dayMonth(iso) { const d = parseDate(iso); return `${d.getUTCDate()}\u00a0${MONTHS_GEN[d.getUTCMonth()]}`; }
export function dayMonthYear(iso) { const d = parseDate(iso); return `${d.getUTCDate()}\u00a0${MONTHS_GEN[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
export function longDate(iso) { return `${cap(WEEKDAYS[weekday(iso)])}, ${dayMonth(iso)}`; }
export function shortDate(iso) { return `${WD_SHORT[weekday(iso)]}, ${dayMonth(iso)}`; }
export function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export function relDay(iso, today) {
  const n = daysBetween(today, iso);
  if (n === 0) return "сегодня";
  if (n === 1) return "завтра";
  if (n === -1) return "вчера";
  if (n > 1 && n < 7) return `в ${WEEKDAYS_ACC[weekday(iso)]}`;
  return dayMonth(iso);
}

export function weekRange(monday) {
  const sun = addDays(monday, 6);
  const a = parseDate(monday), b = parseDate(sun);
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_GEN[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  return `${dayMonth(monday)} – ${dayMonth(sun)} ${b.getUTCFullYear()}`;
}

export function toMin(hm) { const [h, m] = hm.split(":").map(Number); return h * 60 + m; }
export function duration(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
// Число и слово не разрываются переносом: «35\u00a0дней», а не «35 / дней».
export function countOf(n, one, few, many) { return `${n}\u00a0${plural(n, one, few, many)}`; }

// «2026-11-16T08:40» → «сегодня, 08:40» / «15 ноября, 18:05»
export function stamp(isoDt, todayIso) {
  if (!isoDt) return "";
  const d = isoDt.slice(0, 10), t = isoDt.slice(11, 16);
  const r = relDay(d, todayIso);
  const day = (r === "сегодня" || r === "вчера") ? r : dayMonth(d);
  return t ? `${day}, ${t}` : day;
}

// Свежее — относительно демо-«сейчас»: «только что», «7 мин назад» (до часа), дальше — обычная отметка.
export function ago(isoDt, nowIso) {
  if (!isoDt || !nowIso || isoDt.slice(0, 10) !== nowIso.slice(0, 10)) return stamp(isoDt, nowIso && nowIso.slice(0, 10));
  const m = toMin(nowIso.slice(11, 16)) - toMin(isoDt.slice(11, 16));
  if (m < 0 || m >= 60) return stamp(isoDt, nowIso.slice(0, 10));
  return m < 1 ? "только что" : `${m} мин назад`;
}

export function monthLabel(ym) { const [y, m] = ym.split("-").map(Number); return `${MONTHS_NOM[m - 1]} ${y}`; }

export function initials(name) {
  return (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
}

export function shortTeacher(t) {
  // «доц. Орлова Мария Викторовна» → «доц. Орлова М. В.»
  // Должность может быть из нескольких слов: «ст. преп. Нечаева Ольга Андреевна» → «ст. преп. Нечаева О. А.».
  // Фамилия и инициалы склеены неразрывными пробелами, чтобы перенос не отрывал «В.» от «А.».
  const parts = (t || "").split(/\s+/).filter(Boolean);
  const title = [];
  while (parts.length > 1 && /\.$/.test(parts[0])) title.push(parts.shift());
  if (parts.length < 2) return t;
  const [last, first, middle] = parts;
  const name = [last, first ? first[0] + "." : "", middle ? middle[0] + "." : ""].filter(Boolean).join("\u00a0");
  return (title.length ? title.join(" ") + " " : "") + name;
}

export function where(room, building) {
  if (!room) return "";
  const r = /^\d/.test(room) ? `ауд. ${room}` : room;
  if (!building) return r;
  return building.length <= 2 ? `${r}, корпус ${building}` : `${r}, ${building}`;
}
