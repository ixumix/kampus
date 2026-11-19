// Изменяющие действия. Каждое: запрос → вписать подтверждённый ответ во все копии → обновить остальное.
import { api, patchAll, refreshAfterWrite, setUnread, toast, state, emit } from "./data.js";

function replaceById(list, obj) { return list.map((x) => (x.id === obj.id ? { ...x, ...obj } : x)); }

function failToast(e, what) {
  if (e.code === "session_expired" || e.code === "unauthorized") return;
  toast(e.network ? `${what}: нет связи с сервером. Ничего не изменено — попробуйте ещё раз.` : `${what}: ${e.message}`);
}

// ---------------------------------------------------------------- schedule
export async function ackChange(lesson) {
  let res;
  try { res = await api("POST", `/api/lessons/${lesson.id}/ack`, {}); }
  catch (e) { failToast(e, "Не удалось подтвердить изменение"); throw e; }
  const l = res.lesson;
  patchAll((key, data) => {
    if (key === "today") return { ...data, lessons: replaceById(data.lessons, l), changes: data.changes.filter((c) => c.id !== l.id) };
    if (key.startsWith("schedule:")) return { ...data, days: data.days.map((d) => ({ ...d, lessons: replaceById(d.lessons, l) })) };
    if (key === `lesson:${l.id}`) return { ...data, ...l };
  });
  toast("Изменение подтверждено");
  refreshAfterWrite(["today", "schedule", "summary"]);
  return l;
}

// ------------------------------------------------------------------ tasks
export async function setTaskDone(task, done) {
  let res;
  try { res = await api("POST", `/api/tasks/${task.id}/done`, { done }); }
  catch (e) { failToast(e, "Отметка не сохранена"); throw e; }
  const t = res.task;
  patchAll((key, data) => {
    if (key === "today") return { ...data, tasks: replaceById(data.tasks, t) };
    if (key.startsWith("lesson:") && data.tasks) return { ...data, tasks: replaceById(data.tasks, t) };
    if (key.startsWith("subject:") && data.tasks) return { ...data, tasks: replaceById(data.tasks, t) };
  });
  if (done) toast(`Отмечено как выполненное: ${t.title}`, { action: { label: "Вернуть", fn: () => setTaskDone(t, false).catch(() => {}) } });
  refreshAfterWrite(["today", "summary"]);
  return t;
}

// --------------------------------------------------------------- requests
function patchRequest(r) {
  patchAll((key, data) => {
    if (key === "requests") return { ...data, requests: data.requests.some((x) => x.id === r.id) ? replaceById(data.requests, r) : [r, ...data.requests] };
    if (key === `request:${r.id}`) return { ...data, ...r };
    if (key === "today") {
      const docs = data.documents.filter((d) => d.id !== r.id);
      return { ...data, documents: r.status === "ready" && r.has_document ? [r, ...docs] : docs };
    }
  });
}

export async function cancelRequest(r) {
  const res = await api("POST", `/api/requests/${r.id}/cancel`, {});
  patchRequest(res.request);
  refreshAfterWrite(["requests", "today", "summary"]);
  return res.request;
}

export async function setReceived(r, received) {
  let res;
  try { res = await api("POST", `/api/requests/${r.id}/received`, { received }); }
  catch (e) { failToast(e, "Отметка не сохранена"); throw e; }
  patchRequest(res.request);
  if (received) toast("Отмечено: документ получен", { action: { label: "Вернуть", fn: () => setReceived(res.request, false).catch(() => {}) } });
  refreshAfterWrite(["requests", "today", "summary"]);
  return res.request;
}

export function onRequestCreated(r) {
  patchRequest(r);
  refreshAfterWrite(["requests", "today", "notifications"]);
}

// Скачивание через скрытую ссылку: не меняет статус заявки (получение отмечается отдельно).
export function download(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------- notifications
export async function setRead(n, read, { silent } = {}) {
  let res;
  try { res = await api("POST", `/api/notifications/${n.id}/read`, { read }); }
  catch (e) { if (!silent) failToast(e, "Не удалось изменить отметку"); throw e; }
  const nn = res.notification;
  patchAll((key, data) => {
    if (key === "notifications") return { ...data, notifications: replaceById(data.notifications, nn) };
  });
  setUnread(res.unread);
  if (!silent) toast(read ? "Отмечено как прочитанное" : "Возвращено в непрочитанные");
  return nn;
}

export async function readAll(category) {
  let res;
  try { res = await api("POST", "/api/notifications/read-all", category ? { category } : {}); }
  catch (e) { failToast(e, "Не удалось отметить"); throw e; }
  const ids = new Set(res.ids);
  patchAll((key, data) => {
    if (key === "notifications") return { ...data, notifications: data.notifications.map((n) => (ids.has(n.id) ? { ...n, read: true, read_at: state.session.user.demo_now } : n)) };
  });
  setUnread(res.unread);
  if (ids.size) {
    toast(`Прочитано: ${ids.size}`, {
      action: {
        label: "Отменить", fn: async () => {
          for (const id of ids) { try { await setRead({ id }, false, { silent: true }); } catch (e) { /* сообщим ниже */ } }
          refreshAfterWrite(["notifications"]);
          toast("Отметки возвращены");
        },
      },
    });
  }
  refreshAfterWrite(["notifications"]);
  emit();
  return ids;
}

export async function setPreferences(patch) {
  const res = await api("PATCH", "/api/preferences", patch);
  state.session.user = res.user;
  emit();
  return res.user;
}
