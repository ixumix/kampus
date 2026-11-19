// «Документы»: заказ справок и обращений, статусы, история, скачивание готового образца.
import { html, useEffect, useRef, useState } from "../../vendor/preact-htm.js";
import { Icon, StatusGlyph } from "../icons.js";
import { Button, Dialog, Drawer, Empty, Field, LoadError, Skeleton, describedBy } from "../ui.js";
import { Link, navigate, closeTo, withParams } from "../router.js";
import { api, useResource, state, newKey, localDraft, load, peek, toast, demoNow } from "../data.js";
import { cancelRequest, download, onRequestCreated, setReceived } from "../actions.js";
import { StampFigure } from "../scenes.js";
import { Select } from "../pickers.js";
import { AnimatedList, Presence, Roll } from "../motion.js";
import { stamp, dayMonth, monthLabel, countOf } from "../format.js";

const TYPES = [
  { type: "study_cert", icon: "book", title: "Справка об обучении", text: "Для военкомата, визы, банка или работы родителей. Русский или английский." },
  { type: "stipend_cert", icon: "coin", title: "Справка о стипендии", text: "О назначенной стипендии за выбранный период." },
  { type: "dean_appeal", icon: "message", title: "Обращение в деканат", text: "Индивидуальный график, перезачёт, пересдача и другие вопросы." },
];
const ACTIVE = new Set(["accepted", "in_progress", "ready"]);
const LANG = { ru: "русский", en: "английский" };
const DELIVERY = { electronic: "Электронно (демо-образец .txt)", office: "Забрать в учебном офисе" };

// Реальное время сохранения черновика в МСК (как на сервере), чтобы сравнивать версии.
// Черновик датируется демо-временем кабинета, а не часами компьютера.
function mskNow() { return demoNow(); }

function months() {
  const out = [];
  for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    const v = `${y}-${String(m).padStart(2, "0")}`;
    if (v >= "2025-09" && v <= "2026-11") out.push(v);
  }
  return out.reverse();
}

function defaults(type) {
  const u = state.session.user;
  if (type === "study_cert") return { purpose: "", copies: 1, language: "ru", delivery: "electronic", comment: "" };
  if (type === "stipend_cert") return { period_from: "2026-09", period_to: "2026-11", purpose: "", copies: 1 };
  return { topic: "", subject: "", message: "", email: u.email };
}

function validate(type, v) {
  const e = {};
  const len = (k) => (v[k] || "").trim().length;
  if (type === "study_cert") {
    if (!v.purpose) e.purpose = "Выберите, куда нужна справка";
    if (v.purpose === "Другое" && !len("comment")) e.comment = "Укажите, куда нужна справка";
    if (len("comment") > 500) e.comment = `Максимум 500 символов — сейчас ${len("comment")}`;
  } else if (type === "stipend_cert") {
    if (!v.purpose) e.purpose = "Выберите, куда нужна справка";
    if (v.period_from > v.period_to) e.period_to = "Конец периода раньше начала";
  } else {
    if (!v.topic) e.topic = "Выберите тему обращения";
    if (!len("subject")) e.subject = "Заполните поле «Кратко о сути»";
    else if (len("subject") < 5) e.subject = `Минимум 5 символов — сейчас ${len("subject")}`;
    else if (len("subject") > 120) e.subject = `Максимум 120 символов — сейчас ${len("subject")}`;
    if (!len("message")) e.message = "Заполните поле «Текст обращения»";
    else if (len("message") < 20) e.message = `Минимум 20 символов — сейчас ${len("message")}`;
    else if (len("message") > 2000) e.message = `Максимум 2000 символов — сейчас ${len("message")}`;
    if (!len("email")) e.email = "Заполните поле «Почта для ответа»";
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) e.email = "Проверьте адрес почты";
  }
  if (type !== "dean_appeal" && !(v.copies >= 1 && v.copies <= 5)) e.copies = "От 1 до 5 экземпляров";
  return e;
}

// ------------------------------------------------------------------ form
export function RequestForm({ type, parentHref, repeatOf }) {
  const meta = state.session.meta;
  const uid = state.session.user.login;
  const t = TYPES.find((x) => x.type === type);
  const [values, setValues] = useState(null);
  const [note, setNote] = useState(null);
  const [errors, setErrors] = useState({});
  const [phase, setPhase] = useState("edit"); // edit | sending | lost | conflict | error | done
  const [problem, setProblem] = useState(null);
  const [created, setCreated] = useState(null);
  const [draftState, setDraftState] = useState(null);
  const keyRef = useRef(null);
  const timer = useRef(null);
  const bannerRef = useRef(null);

  // Начальные значения: повтор заявки → черновик (сервер или это устройство) → значения по умолчанию.
  useEffect(() => {
    let alive = true;
    (async () => {
      const local = localDraft(uid, type);
      let server = null;
      try { const r = await load("requests", "/api/requests"); server = r.drafts[type]; } catch (e) { /* используем локальную копию */ }
      if (!alive) return;
      if (repeatOf) {
        try {
          const r = await load(`request:${repeatOf}`, `/api/requests/${repeatOf}`);
          if (r.type === type) { setValues({ ...defaults(type), ...r.payload }); setNote(`Поля заполнены по заявке №${r.id}. Проверьте их перед отправкой.`); return; }
        } catch (e) { /* откроем пустую форму */ }
      }
      const pick = local && (!server || (local.updated_at || "") >= (server.updated_at || "")) ? local : server;
      if (pick && pick.payload) {
        setValues({ ...defaults(type), ...pick.payload });
        if (local && local.key) keyRef.current = local.key;
        setNote(`Восстановлен черновик от ${stamp(pick.updated_at.replace(" ", "T"), state.session.user.demo_now.slice(0, 10))}.`);
      } else setValues(defaults(type));
    })();
    return () => { alive = false; clearTimeout(timer.current); };
  }, [type, repeatOf]);

  const saveDraft = (v) => {
    clearTimeout(timer.current);
    setDraftState("saving");
    const stampNow = mskNow();
    localDraft(uid, type, { payload: v, key: keyRef.current, updated_at: stampNow });
    timer.current = setTimeout(async () => {
      try { await api("PUT", `/api/drafts/${type}`, { payload: v }, { quiet: true }); setDraftState("saved"); }
      catch (e) { setDraftState(e.code === "session_expired" ? "local" : "local"); }
    }, 600);
  };

  const set = (k, v) => {
    const next = { ...values, [k]: v };
    setValues(next);
    if (errors[k]) setErrors({ ...errors, [k]: undefined });
    saveDraft(next);
  };

  const clearForm = async () => {
    setValues(defaults(type)); setErrors({}); setNote(null); keyRef.current = null;
    localDraft(uid, type, null);
    try { await api("DELETE", `/api/drafts/${type}`, undefined, { quiet: true }); } catch (e) { /* не критично */ }
    setDraftState(null);
  };

  const submit = async (ev, { fresh } = {}) => {
    ev && ev.preventDefault();
    if (phase === "sending") return;
    const errs = validate(type, values);
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0];
      requestAnimationFrame(() => { const el = document.getElementById(`f-${first}`) || document.querySelector(`[name="f-${first}"]`); el && el.focus(); });
      return;
    }
    if (!keyRef.current || fresh) keyRef.current = newKey();
    localDraft(uid, type, { payload: values, key: keyRef.current, updated_at: mskNow() });
    clearTimeout(timer.current);
    setPhase("sending"); setProblem(null);
    try {
      const res = await api("POST", "/api/requests", { type, payload: values }, { idempotencyKey: keyRef.current, quiet: true });
      localDraft(uid, type, null);
      setCreated({ ...res.request, replayed: res.outcome === "replayed" });
      setPhase("done");
      onRequestCreated(res.request);
    } catch (e) {
      if (e.status === 422 && e.fields) { setErrors(e.fields); setPhase("edit"); setProblem({ text: "Сервер не принял форму — исправьте отмеченные поля." }); }
      else if (e.code === "idempotency_conflict") { setPhase("conflict"); setProblem({ request: e.body.request }); }
      else if (e.network) { setPhase("lost"); setProblem({ text: "Ответ сервера не получен. Заявка могла быть принята — повторная отправка не создаст дубликат. Черновик сохранён." }); }
      else if (e.code === "session_expired" || e.code === "unauthorized") { setPhase("edit"); setProblem({ text: "Сессия истекла. Войдите снова — форма и черновик сохранены, затем отправьте ещё раз." }); }
      else { setPhase("error"); setProblem({ text: e.message || "Не удалось отправить заявку" }); }
      requestAnimationFrame(() => bannerRef.current && bannerRef.current.focus());
    }
  };

  const close = () => closeTo(parentHref);
  const busy = phase === "sending";

  if (phase === "done") {
    return html`<${Dialog} title="Заявка отправлена" onClose=${close} labelId="req-done">
      <div class="success">
        <${StampFigure} />
        <h3 class="h1" style="font-size:18px">${t.title}: заявка №${created.id} принята</h3>
        <p class="meta-2" style="max-width:40ch">${created.replayed ? "Сервер уже получил эту заявку ранее — дубликат не создан. " : ""}Статус — «Принята». Это демонстрационный режим: деканат её не обрабатывает, и статус дальше не изменится.</p>
      </div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px">
        <${Link} class="btn btn-primary" href=${`/documents/${created.id}`} replace overlay data-autofocus>Открыть заявку</${Link}>
        <${Button} onClick=${close}>Готово</${Button}>
      </div>
    </${Dialog}>`;
  }

  const err = (k) => errors[k];
  const inputProps = (k, help) => ({ id: `f-${k}`, "aria-invalid": err(k) ? "true" : undefined, "aria-describedby": describedBy(`f-${k}`, err(k), help) });
  const count = (k, max) => html`<span class="counter" aria-hidden="true">${(values[k] || "").length} / ${max}</span>`;

  let fields = null;
  if (values && type === "study_cert") fields = html`
    <${Field} id="f-purpose" label="Куда нужна справка" error=${err("purpose")}>
      <${Select} id=${"f-purpose"} invalid=${!!err("purpose")} describedBy=${inputProps("purpose")["aria-describedby"]} value=${values.purpose} onChange=${(v) => set("purpose", v)}
        options=${meta.study_purposes.map((p) => ({ value: p, label: p }))} /></${Field}>
    <${Field} id="f-comment" label=${values.purpose === "Другое" ? "Уточните, куда" : "Комментарий"} optional=${values.purpose !== "Другое"} error=${err("comment")} help="Например, название организации" counter=${count("comment", 500)}>
      <textarea class="textarea" style="min-height:72px" ...${inputProps("comment", true)} value=${values.comment} onInput=${(e) => set("comment", e.target.value)} maxlength="600"></textarea></${Field}>
    <fieldset class="field" style="border:0;padding:0;margin:16px 0 0"><legend class="label" style="margin-bottom:6px">Язык справки</legend>
      <div class="choice-row">${Object.entries(LANG).map(([v, l]) => html`<label class="choice"><input type="radio" name="f-language" value=${v} checked=${values.language === v} onChange=${() => set("language", v)} /><span class="mark"></span>${l[0].toUpperCase() + l.slice(1)}</label>`)}</div></fieldset>
    <fieldset class="field" style="border:0;padding:0;margin:16px 0 0"><legend class="label" style="margin-bottom:6px">Способ получения</legend>
      <div class="choice-row">${Object.entries(DELIVERY).map(([v, l]) => html`<label class="choice"><input type="radio" name="f-delivery" value=${v} checked=${values.delivery === v} onChange=${() => set("delivery", v)} /><span class="mark"></span>${l}</label>`)}</div></fieldset>
    <div class="field" style="margin-top:16px"><${CopiesField} value=${values.copies} onChange=${(v) => set("copies", v)} error=${err("copies")} /></div>`;
  else if (values && type === "stipend_cert") fields = html`
    <div class="grid-2">
      <${Field} id="f-period_from" label="Период с" error=${err("period_from")}>
        <${Select} id=${"f-period_from"} invalid=${!!err("period_from")} describedBy=${inputProps("period_from")["aria-describedby"]} value=${values.period_from} onChange=${(v) => set("period_from", v)}
        options=${months().map((m) => ({ value: m, label: monthLabel(m) }))} /></${Field}>
      <${Field} id="f-period_to" label="по" error=${err("period_to")}>
        <${Select} id=${"f-period_to"} invalid=${!!err("period_to")} describedBy=${inputProps("period_to")["aria-describedby"]} value=${values.period_to} onChange=${(v) => set("period_to", v)}
        options=${months().map((m) => ({ value: m, label: monthLabel(m) }))} /></${Field}>
    </div>
    <div style="margin-top:16px"><${Field} id="f-purpose" label="Куда нужна справка" error=${err("purpose")}>
      <${Select} id=${"f-purpose"} invalid=${!!err("purpose")} describedBy=${inputProps("purpose")["aria-describedby"]} value=${values.purpose} onChange=${(v) => set("purpose", v)}
        options=${meta.stipend_purposes.map((p) => ({ value: p, label: p }))} /></${Field}></div>
    <div class="field" style="margin-top:16px"><${CopiesField} value=${values.copies} onChange=${(v) => set("copies", v)} error=${err("copies")} /></div>
    <p class="help" style="margin-top:12px">Суммы выплат в демонстрационном образце не указываются.</p>`;
  else if (values) fields = html`
    <${Field} id="f-topic" label="Тема" error=${err("topic")}>
      <${Select} id=${"f-topic"} invalid=${!!err("topic")} describedBy=${inputProps("topic")["aria-describedby"]} value=${values.topic} onChange=${(v) => set("topic", v)}
        options=${meta.appeal_topics.map((p) => ({ value: p, label: p }))} /></${Field}>
    <${Field} id="f-subject" label="Кратко о сути" error=${err("subject")} help="Одна строка: о чём обращение" counter=${count("subject", 120)}>
      <input class="input" ...${inputProps("subject", true)} value=${values.subject} onInput=${(e) => set("subject", e.target.value)} maxlength="160" /></${Field}>
    <${Field} id="f-message" label="Текст обращения" error=${err("message")} help="От 20 символов. Укажите даты и дисциплины, если они важны." counter=${count("message", 2000)}>
      <textarea class="textarea" ...${inputProps("message", true)} value=${values.message} onInput=${(e) => set("message", e.target.value)} maxlength="2400"></textarea></${Field}>
    <${Field} id="f-email" label="Почта для ответа" error=${err("email")}>
      <input class="input" type="email" autocomplete="email" ...${inputProps("email")} value=${values.email} onInput=${(e) => set("email", e.target.value)} /></${Field}>`;

  const banner = problem && (phase === "conflict"
    ? html`<div class="banner banner-strong" role="alert" tabindex="-1" ref=${bannerRef} style="margin-bottom:16px"><${Icon} name="alert" />
        <div class="grow"><b>Предыдущая отправка уже принята как заявка №${problem.request.id}</b>, но поля формы с тех пор изменились. Откройте принятую заявку или отправьте изменённую как новую.
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <${Link} class="btn btn-sm" href=${`/documents/${problem.request.id}`} replace overlay onClick=${() => { localDraft(uid, type, null); onRequestCreated(problem.request); }}>Открыть заявку №${problem.request.id}</${Link}>
            <${Button} size="sm" kind="primary" onClick=${(e) => submit(e, { fresh: true })}>Отправить как новую</${Button}></div></div></div>`
    : html`<div class=${"banner " + (phase === "lost" || phase === "error" ? "banner-strong" : "banner-dashed")} role="alert" tabindex="-1" ref=${bannerRef} style="margin-bottom:16px">
        <${Icon} name=${phase === "lost" ? "wifiOff" : "alert"} /><span class="grow">${problem.text}</span></div>`);

  return html`<${Dialog} title=${t.title} subtitle="Демо-режим: заявка будет принята, но не обработана деканатом." onClose=${close} busy=${busy} labelId="req-form-title"
    initial=".pick-btn, input:not([type=radio]), textarea"
    footer=${values && html`
      <span class="grow draft-state" aria-live="polite">${draftState === "saving" ? "Сохраняем черновик…" : draftState === "saved" ? html`<${Icon} name="check" size=${12} />Черновик сохранён` : draftState === "local" ? html`<${Icon} name="wifiOff" size=${12} />Черновик сохранён на этом устройстве` : ""}</span>
      <${Button} kind="ghost" onClick=${clearForm} disabled=${busy}>Очистить</${Button}>
      <${Button} kind="primary" type="submit" form="req-form" busy=${busy}>${busy ? "Отправляем…" : phase === "lost" ? "Отправить ещё раз" : "Отправить заявку"}</${Button}>`}>
    ${!values ? html`<${Skeleton} rows=${3} />` : html`<form id="req-form" onSubmit=${submit} noValidate>
      ${banner}
      ${note && !problem && html`<div class="note" style="margin-bottom:16px"><${Icon} name="info" /><span class="grow">${note}</span></div>`}
      <fieldset disabled=${busy} style="border:0;padding:0;margin:0;min-width:0">${fields}</fieldset>
    </form>`}
  </${Dialog}>`;
}

function CopiesField({ value, onChange, error }) {
  return html`<label class="label" for="f-copies">Экземпляров</label>
    <${Select} id="f-copies" style="width:120px" value=${value} invalid=${!!error} onChange=${(v) => onChange(Number(v))}
      options=${[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} />
    ${error && html`<div class="error-text">${error}</div>`}`;
}

// ---------------------------------------------------------------- detail
function payloadRows(r) {
  const p = r.payload;
  if (r.type === "study_cert") return [["Куда", p.purpose], p.comment && ["Комментарий", p.comment], ["Язык", LANG[p.language]], ["Получение", DELIVERY[p.delivery]], ["Экземпляров", p.copies]].filter(Boolean);
  if (r.type === "stipend_cert") return [["Период", `${monthLabel(p.period_from)} — ${monthLabel(p.period_to)}`], ["Куда", p.purpose], ["Экземпляров", p.copies]];
  return [["Тема", p.topic], ["Суть", p.subject], ["Почта для ответа", p.email]];
}

export function RequestDrawer({ id, parentHref }) {
  const { data: r, error, loading, reload } = useResource(`request:${id}`, `/api/requests/${id}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState(null);
  const [recvBusy, setRecvBusy] = useState(false);
  const today = state.session.user.demo_now.slice(0, 10);
  const doCancel = async () => {
    setBusy(true); setCancelErr(null);
    try { await cancelRequest(r); setConfirm(false); toast(`Заявка №${r.id} отменена`); requestAnimationFrame(() => document.getElementById("cc-repeat")?.focus()); }
    catch (e) { setCancelErr(e.network ? "Нет связи с сервером. Заявка не отменена — попробуйте ещё раз." : e.message); }
    setBusy(false);
  };
  let body;
  if (loading && !r) body = html`<${Skeleton} rows=${3} />`;
  else if (error && !r) body = html`<${LoadError} error=${error} onRetry=${reload} what="заявку" />`;
  else body = html`
    <div style="display:flex;align-items:center;gap:8px"><${StatusGlyph} status=${r.status} /><b><${Roll} value=${r.status_label} /></b><span class="meta">· ${r.type_label} · №${r.id}</span></div>
    <h2 class="detail-title">${r.title}</h2>
    <p class="meta-2">Создана ${stamp(r.created_at, today)}${r.demo_example ? " · подготовленный пример" : ""}</p>
    ${r.status === "accepted" && !r.demo_example && html`<div class="note" style="margin-top:12px"><${Icon} name="info" /><span>Демо-режим: новая заявка остаётся в статусе «Принята». Реальная обработка, сроки и выдача документов не выполняются.</span></div>`}
    ${r.has_document && html`<div class="panel" style="margin-top:16px"><div class="ready-doc">
      <span class="ic"><${Icon} name="doc" /></span>
      <div><div class="h3">${r.type_label}${r.payload.language === "en" ? " (англ.)" : ""}</div><div class="small">Демонстрационный образец .txt — не официальный документ</div></div>
      <div class="acts"><${Button} kind="primary" icon="download" onClick=${() => download(`/api/requests/${r.id}/document`)}>Скачать</${Button}></div></div>
      <div class="panel-foot" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${r.status === "received"
          ? html`<span class="meta grow" style="flex:1"><${Icon} name="check" size=${13} cls="inline" /> Отмечено как полученный</span><${Button} kind="ghost" busy=${recvBusy} onClick=${async () => { setRecvBusy(true); try { await setReceived(r, false); } catch (e) {} setRecvBusy(false); }}>Снять отметку</${Button}>`
          : html`<span class="meta" style="flex:1">Скачивание не меняет статус. Получили документ — отметьте отдельно.</span><${Button} icon="check" busy=${recvBusy} onClick=${async () => { setRecvBusy(true); try { await setReceived(r, true); } catch (e) {} setRecvBusy(false); }}>Отметить получение</${Button}>`}
      </div></div>`}
    ${r.answer && html`<div class="detail-sec"><span class="eyebrow">${r.status === "rejected" ? "Причина отклонения" : "Ответ деканата"}</span><div class="answer">${r.answer}</div></div>`}
    <div class="detail-sec"><span class="eyebrow">Данные заявки</span>
      <dl class="kv">${payloadRows(r).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${r.type === "dean_appeal" && html`<div class="answer" style="margin-top:12px;background:none;border:1px solid var(--line)">${r.payload.message}</div>`}</div>
    <div class="detail-sec"><span class="eyebrow">История</span>
      <ol class="timeline">${(r.events || []).map((e) => html`<li><span class="st"><${StatusGlyph} status=${e.status} /></span><div><div>${e.text}</div><div class="small">${stamp(e.at, today)}</div></div></li>`)}</ol></div>
  `;
  const canRepeat = r && ["cancelled", "rejected", "received", "answered"].includes(r.status);
  return html`<${Drawer} label=${r ? `Заявка №${r.id}` : "Заявка"} crumb=${r ? `Документы · заявка №${r.id}` : "Документы"} onClose=${() => closeTo(parentHref)} busy=${busy}
    footer=${r && (r.can_cancel || canRepeat) && (confirm ? html`<div role="group" aria-labelledby="cc-h" style="display:grid;gap:8px;width:100%">
        <div><b id="cc-h">Отменить заявку №${r.id}?</b><p class="meta">Отменённую заявку нельзя вернуть, но можно отправить такую же заново.</p></div>
        ${cancelErr && html`<div class="error-text" role="alert"><${Icon} name="alert" size=${14} />${cancelErr}</div>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap"><${Button} kind="primary" busy=${busy} onClick=${doCancel} id="cc-yes">Да, отменить</${Button}>
          <${Button} onClick=${() => { setConfirm(false); setCancelErr(null); requestAnimationFrame(() => document.getElementById("cc-open")?.focus()); }} disabled=${busy}>Не отменять</${Button}></div></div>` : html`
      ${r.can_cancel && html`<${Button} icon="ban" id="cc-open" onClick=${() => { setConfirm(true); requestAnimationFrame(() => document.getElementById("cc-yes")?.focus()); }}>Отменить заявку</${Button}>`}
      ${canRepeat && html`<${Link} class="btn" href=${withParams(`/documents/new/${r.type}`, { from: r.id })} replace overlay id="cc-repeat"><${Icon} name="refresh" />Повторить заявку</${Link}>`}`)}>
    ${body}
  </${Drawer}>`;
}

// ------------------------------------------------------------------ page
export function DocumentsPage({ route }) {
  const { data, error, loading, reload } = useResource("requests", "/api/requests");
  const filter = ["active", "done"].includes(route.search.get("filter")) ? route.search.get("filter") : "all";
  const today = state.session.user.demo_now.slice(0, 10);
  const reqs = data ? data.requests : [];
  const ready = reqs.filter((r) => r.status === "ready" && r.has_document);
  const list = reqs.filter((r) => filter === "all" || (filter === "active" ? ACTIVE.has(r.status) : !ACTIVE.has(r.status)));
  const nActive = reqs.filter((r) => ACTIVE.has(r.status)).length;
  return html`<div class="page">
    <div class="page-head"><div class="titles"><h1 class="h1" tabindex="-1" data-page-title>Документы</h1>
      <p class="meta">Справки и обращения в деканат · демо-режим, документы — образцы</p></div></div>
    <section aria-labelledby="new-h"><h2 class="sr-only" id="new-h">Новая заявка</h2>
      <div class="doc-types stagger">${TYPES.map((t) => {
        const draft = data && data.drafts[t.type];
        return html`<${Link} class="doc-type" href=${`/documents/new/${t.type}`} overlay key=${t.type}>
          <span class="ic"><${Icon} name=${t.icon} /></span>
          <span class="h3">${t.title}</span><span class="meta">${t.text}</span>
          ${draft && html`<span class="tag draft">Черновик</span>`}
        </${Link}>`;
      })}</div></section>
    <${Presence} show=${ready.length > 0}><section class="section" aria-labelledby="ready-h" style="margin-bottom:24px">
      <div class="section-title"><h2 class="h2" id="ready-h">Готово к получению</h2></div>
      <div class="panel"><${AnimatedList} cls="divided" items=${ready} keyOf=${(r) => r.id} render=${(r) => html`<div class="ready-doc">
        <span class="ic"><${Icon} name="doc" /></span>
        <div style="min-width:0"><${Link} class="h3 row-link" href=${`/documents/${r.id}`} overlay>${r.type_label} · №${r.id}</${Link}>
          <div class="small">Готова ${stamp(r.updated_at, today)} · демо-образец .txt</div></div>
        <div class="acts"><${Button} kind="primary" icon="download" onClick=${() => download(`/api/requests/${r.id}/document`)} aria-label=${`Скачать: ${r.type_label}, заявка №${r.id}`}>Скачать</${Button}>
          <${Button} icon="check" onClick=${() => setReceived(r, true).catch(() => {})} aria-label=${`Отметить получение: заявка №${r.id}`}>Получено</${Button}></div>
      </div>`} /></div></section></${Presence}>
    <section class="section" aria-labelledby="all-h">
      <div class="toolbar" style="margin-bottom:12px"><h2 class="h2" id="all-h" style="margin-right:8px">Заявки</h2>
        <div class="chips" role="group" aria-label="Фильтр заявок">
          ${[["all", "Все", reqs.length], ["active", "Активные", nActive], ["done", "Завершённые", reqs.length - nActive]].map(([v, l, n]) => html`
            <${Link} class="chip" replace href=${withParams("/documents", { filter: v === "all" ? undefined : v })} aria-current=${filter === v ? "true" : undefined}>${l} <span class="count">${n}</span></${Link}>`)}
        </div></div>
      ${loading && !data ? html`<div class="panel"><${Skeleton} rows=${3} /></div>`
        : error && !data ? html`<${LoadError} error=${error} onRetry=${reload} what="заявки" />`
        : list.length === 0 ? html`<div class="panel"><${Empty} compact title=${filter === "active" ? "Активных заявок нет" : filter === "done" ? "Завершённых заявок нет" : "Заявок пока нет"} text="Выберите тип документа выше, чтобы создать заявку." /></div>`
        : html`<div class="panel" style="overflow:hidden"><${AnimatedList} cls="divided" items=${list} keyOf=${(r) => r.id} render=${(r) => html`<${Link} class="req" href=${`/documents/${r.id}`} overlay>
            <span class="lead"><${StatusGlyph} status=${r.status} /></span>
            <span style="min-width:0"><span class="title" style="display:block">${r.title}</span><span class="small">${r.type_label} · №${r.id} · ${stamp(r.created_at, today)}</span></span>
            <span class="trail"><span class="meta-2" style="font-weight:520;color:var(--fg)"><${Roll} value=${r.status_label} /></span>${r.has_document && r.status === "ready" && html`<span class="small">можно скачать</span>`}</span>
          </${Link}>`} /></div>`}
    </section>
  </div>`;
}
