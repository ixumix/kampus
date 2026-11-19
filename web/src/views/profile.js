// «Профиль»: учебные данные, тема, демо-время, выход.
import { startTour } from "../tour.js";
import { html, useEffect, useState } from "../../vendor/preact-htm.js";
import { Icon } from "../icons.js";
import { Button, Segmented } from "../ui.js";
import { Select } from "../pickers.js";
import { state, useStore, applyTheme, clearCache, toast, api, setState, useResource, patchAll, wipeOfflineData } from "../data.js";
import { setPreferences } from "../actions.js";
import { navigate } from "../router.js";
import { initials, stamp } from "../format.js";
import { aliveOn, setAlive } from "../live.js";
const reducedMq = matchMedia("(prefers-reduced-motion: reduce)");

// Подписка на календарь: секретная ссылка, по которой приложение календаря само забирает расписание.
function CalendarSection() {
  const { data, error, reload } = useResource("calendar", "/api/calendar");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const url = data && data.token ? `${location.origin}/cal/${data.token}.ics` : null;
  const set = (d) => patchAll((k, v) => (k === "calendar" ? d : undefined));
  const run = async (method, msg) => {
    setBusy(true);
    try { const d = await api(method, "/api/calendar/token", method === "POST" ? {} : undefined); set(d); toast(msg); setConfirm(false); }
    catch (e) { toast(e.network ? "Нет связи с сервером — ссылка не изменена" : e.message); }
    setBusy(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast("Ссылка подписки скопирована"); }
    catch (e) { document.getElementById("cal-url")?.select(); toast("Выделите и скопируйте ссылку вручную"); }
  };
  return html`<section class="panel profile-card" aria-labelledby="cal-h" id="calendar">
    <h2 class="h2" id="cal-h">Календарь</h2>
    <div class="setting" style="display:block">
      <div class="h3">Подписка на расписание</div>
      <p class="meta" style="margin-top:2px">В отличие от разового файла .ics, подписка обновляется сама: переносы и отмены приходят в календарь без захода в кабинет. Пары двух опубликованных недель и сессия.</p>
      ${error && !data ? html`<p class="meta" style="margin-top:10px">Не удалось загрузить настройку. <button class="link" onClick=${reload}>Повторить</button></p>`
        : !data ? null
        : !url ? html`<div style="margin-top:12px"><${Button} kind="primary" icon="calExport" busy=${busy} onClick=${() => run("POST", "Ссылка подписки создана")}>Создать ссылку подписки</${Button}></div>`
        : html`<div style="margin-top:12px;display:grid;gap:10px">
            <label class="sr-only" for="cal-url">Ссылка подписки</label>
            <div class="input-group"><input class="input mono" id="cal-url" readonly value=${url} onFocus=${(e) => e.target.select()} style="padding-right:44px" />
              <${Button} kind="ghost" icon="copy" aria-label="Скопировать ссылку подписки" onClick=${copy} /></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <a class="btn btn-primary" href=${url.replace(/^https?:/, "webcal:")}><${Icon} name="calExport" />Открыть в Календаре</a>
              <${Button} icon="copy" onClick=${copy}>Скопировать</${Button}>
              ${!confirm && html`<${Button} kind="ghost" icon="refresh" onClick=${() => setConfirm(true)}>Перевыпустить или отключить</${Button}>`}
            </div>
            ${confirm && html`<div class="change-box" role="group" aria-label="Управление ссылкой" style="margin:0">
              <p class="meta-2">Перевыпуск создаст новую ссылку, а старая перестанет работать — например, если ею кто-то поделился. Отключение просто остановит подписку.</p>
              <div style="display:flex;gap:8px;flex-wrap:wrap"><${Button} busy=${busy} onClick=${() => run("POST", "Новая ссылка создана, старая отключена")}>Перевыпустить</${Button}>
                <${Button} busy=${busy} onClick=${() => run("DELETE", "Подписка отключена")}>Отключить</${Button}>
                <${Button} kind="ghost" onClick=${() => setConfirm(false)}>Отмена</${Button}></div></div>`}
            <p class="small">Создана ${stamp(data.created_at.replace(" ", "T"), "")} (по времени устройства). Ссылка — как пароль к расписанию: не публикуйте её. Google Календарь подписывается только на адреса из интернета, поэтому локальный демо-сервер проверяйте в Apple Календаре или Outlook на этом компьютере.</p>
          </div>`}
    </div>
  </section>`;
}

// Приложение: установка на устройство и офлайн-режим.
function AppSection() {
  const s = useStore();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const install = async () => {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    try { await p.userChoice; } catch (e) { /* пользователь закрыл окно */ }
    setState({ installPrompt: null });
  };
  return html`<section class="panel profile-card" aria-labelledby="app-h" id="install">
    <h2 class="h2" id="app-h">Приложение и офлайн</h2>
    <div class="setting"><div class="body"><div class="h3">${standalone ? "Кампус установлен" : "Установить на устройство"}</div>
      <p class="meta">${standalone ? "Кампус открыт как приложение." : ios ? "В Safari: «Поделиться» → «На экран „Домой“»." : s.installPrompt ? "Кампус откроется отдельным окном, как приложение." : "Браузер покажет кнопку установки в адресной строке, если поддерживает её."}</p></div>
      ${!standalone && s.installPrompt && html`<${Button} kind="primary" icon="download" onClick=${install}>Установить</${Button}>`}</div>
    <div class="setting"><div class="body"><div class="h3">Без сети</div>
      <p class="meta">Открытые страницы сохраняются на этом устройстве: день, неделя, оценки, заявки и уведомления видны и без связи — с пометкой, когда данные сохранены. Отправлять изменения без сети нельзя. При выходе из аккаунта сохранённое удаляется.</p></div>
      <${Button} icon="ban" onClick=${async () => { await wipeOfflineData(); toast("Сохранённые на устройстве данные удалены"); }}>Очистить</${Button}></div>
  </section>`;
}

export function ProfilePage() {
  const s = useStore();
  const u = s.session.user;
  const [busy, setBusy] = useState(false);
  useEffect(() => { const id = location.hash.slice(1); if (["demo", "calendar", "install"].includes(id)) document.getElementById(id)?.scrollIntoView({ block: "center" }); }, []);
  const theme = async (t) => {
    applyTheme(t);
    try { await setPreferences({ theme: t }); } catch (e) { toast("Тема применена на этом устройстве, но не сохранена на сервере"); }
  };
  const demo = async (v) => {
    setBusy(true);
    try { await setPreferences({ demo_now: v }); clearCache(); toast("Демо-время изменено — данные пересчитаны"); }
    catch (e) { toast(e.network ? "Нет связи с сервером — демо-время не изменено" : e.message); }
    setBusy(false);
  };
  const logout = async () => {
    try { await api("POST", "/api/auth/logout", {}); } catch (e) { /* сессия и так недействительна */ }
    await wipeOfflineData(); clearCache(); setState({ session: null }); navigate("/login", { replace: true });
  };
  const rows = [["Факультет", u.faculty], ["Направление", u.program], ["Курс", `${u.course} курс`], ["Группа", u.group_name], ["Зачётная книжка", u.record_no]];
  return html`<div class="page">
    <div class="page-head profile-head" style="align-items:flex-start">
      <span class="avatar avatar-lg" aria-hidden="true">${initials(u.short_name)}</span>
      <div class="titles"><h1 class="h1" tabindex="-1" data-page-title>${u.full_name}</h1><p class="meta">${u.group_name} · ${u.course} курс · логин ${u.login}</p></div>
    </div>
    <div class="profile-grid">
      <section class="panel profile-card" aria-labelledby="study-h">
        <h2 class="h2" id="study-h" style="margin-bottom:12px">Учебные данные</h2>
        <dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        <hr class="divider" style="margin:16px 0" />
        <h2 class="h2" style="margin-bottom:12px">Контакты</h2>
        <dl class="kv"><dt>Почта</dt><dd>${u.email}</dd><dt>Телефон</dt><dd class="num">${u.phone}</dd></dl>
        <p class="small" style="margin-top:16px">Все сведения вымышлены. Изменение учебных данных в демо не предусмотрено.</p>
      </section>
      <div style="display:grid;gap:16px">
        <section class="panel profile-card" aria-labelledby="look-h">
          <h2 class="h2" id="look-h">Оформление</h2>
          <div class="setting"><div class="body"><div class="h3">Тема</div><p class="meta">«Системная» следует настройке устройства. Выбор сохраняется в аккаунте.</p></div>
            <${Segmented} label="Тема" value=${u.theme} onChange=${theme} options=${[{ value: "system", label: "Системная", icon: "system" }, { value: "light", label: "Светлая", icon: "sun" }, { value: "dark", label: "Тёмная", icon: "moon" }]} /></div>
          <div class="setting" id="alive"><div class="body"><div class="h3" id="alive-h">Живой интерфейс</div>
            <p class="meta">${reducedMq.matches ? "Устройство просит меньше движения — фон стоит при любом выборе." : "Сцены медленно движутся сами: волна на сетке, дыхание карточек, солнце и тени по демо-часам. Выбор хранится на этом устройстве."}</p></div>
            <button type="button" class="dc-flow" role="switch" aria-labelledby="alive-h" aria-checked=${aliveOn() ? "true" : "false"} onClick=${() => setAlive(!aliveOn())}>
              <span class="sw" aria-hidden="true"><i></i></span>${aliveOn() ? "Вкл." : "Выкл."}</button></div>
        </section>
        <section class="panel profile-card" aria-labelledby="demo-h" id="demo">
          <h2 class="h2" id="demo-h">Демо-режим</h2>
          <div class="setting"><div class="body"><label class="h3" for="demo-now">Демо-время</label>
            <p class="meta">Кабинет считает «сейчас» от этого момента, а не от часов компьютера. Меняйте, чтобы увидеть утро, перерыв, вечер или свободный день.</p></div>
            <${Select} id="demo-now" style="width:280px;max-width:100%" value=${u.demo_now} disabled=${busy} onChange=${demo}
              options=${u.demo_now_presets.map((p) => ({ value: p.value, label: p.label }))} /></div>
        </section>
        <${CalendarSection} />
        <${AppSection} />
        <section class="panel profile-card" aria-labelledby="tour-h" id="tour">
          <h2 class="h2" id="tour-h">Знакомство</h2>
          <div class="setting"><div class="body"><p class="meta">Короткий показ главного на ваших данных: пары, изменения, дела, поиск. Около полуминуты, можно прервать в любой момент.</p></div>
            <${Button} icon="play" onClick=${startTour}>Пройти снова</${Button}></div>
        </section>
        <section class="panel profile-card" aria-labelledby="acc-h">
          <h2 class="h2" id="acc-h">Аккаунт</h2>
          <div class="setting"><div class="body"><p class="meta">Выход завершает сессию на сервере. Черновики заявок остаются в аккаунте.</p></div>
            <${Button} icon="logout" onClick=${logout}>Выйти</${Button}></div>
        </section>
      </div>
    </div>
  </div>`;
}
