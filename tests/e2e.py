"""Браузерные e2e-проверки «Кампуса» (Playwright + Chromium) на отдельной временной базе.

Запуск:  uv run --python 3.12 --with playwright==1.48.0 python tests/e2e.py [--shots]
--shots  дополнительно сохраняет кадры в docs/screenshots (демо-набор отдельно от стресса).

Это проверки сценариев и инвариантов вёрстки, а не визуальное принятие дизайна.
"""

import os
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback

os.environ.setdefault("CAMPUS_PBKDF2_ITERS", "2000")
os.environ.setdefault("CAMPUS_FROZEN_TIME", "1")  # демо-часы стоят: тексты вида «осталось 5 мин» проверяются точно
os.environ["CAMPUS_QUIET"] = "1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from playwright.sync_api import expect, sync_playwright  # noqa: E402

from server.app import make_server, open_store  # noqa: E402
from server.ai import WeekBriefAI  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "tests"))
from fake_ai import FakeModel  # noqa: E402

SHOTS = "--shots" in sys.argv
AXE = open(os.path.join(ROOT, "tests", "vendor", "axe.min.js"), encoding="utf-8").read()
VIEWPORTS = [(1440, 900), (1146, 646), (390, 844), (360, 800)]
PAGES = ["/", "/schedule?view=week", "/schedule?view=3days", "/schedule?view=day", "/grades", "/grades?tab=session", "/grades?tab=results",
         "/documents", "/notifications?id=1", "/profile"]
results = []


def start(stress=False):
    tmp = tempfile.mkdtemp()
    store = open_store(os.path.join(tmp, "e2e.db"), stress=stress)
    srv = make_server(store, port=0, dev=True, ai=WeekBriefAI(FakeModel()))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, tmp, "http://127.0.0.1:%d" % srv.server_address[1]


def check(name, fn):
    if os.environ.get("E2E_ONLY") and os.environ["E2E_ONLY"] not in name:
        return  # E2E_ONLY="Свободный день" — прогнать одну проверку
    t = time.time()
    try:
        fn()
        results.append((name, "OK", "%.1fs" % (time.time() - t)))
    except Exception as e:  # noqa: BLE001
        results.append((name, "FAIL", "%s" % e))
        traceback.print_exc()


def login(page, base, user="belova", pw="kampus-anna", skip_tour=True, page_tours=False):
    page.goto(base + "/login")
    page.get_by_label("Логин").fill(user)
    page.get_by_label("Пароль", exact=True).fill(pw)
    page.get_by_role("button", name="Войти").click()
    expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()
    if skip_tour:  # знакомство при первом входе проверяется отдельно
        page.wait_for_selector("html[data-tour-ready]", state="attached", timeout=8000)
        if page.locator(".tour-pop").count():
            page.locator(".tour-pop").get_by_role("button", name="Пропустить").click()
            expect(page.locator(".tour")).to_have_count(0)
    if skip_tour and not page_tours:  # знакомства с разделами проверяются отдельно — здесь они «уже показаны»
        page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
              await fetch('/api/tour', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf}, body: JSON.stringify({page: '*'})}); }""")
        page.reload()  # сессия клиента берёт флаг при загрузке
        expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()


def settle(page):
    page.evaluate("document.getAnimations().forEach(a => { try { a.finish() } catch (e) {} })")


def run():
    srv, tmp, base = start()
    with sync_playwright() as p:
        channel = os.environ.get("CAMPUS_E2E_CHANNEL")  # например, chrome — установленный Google Chrome
        browser = p.chromium.launch(channel=channel) if channel else p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1146, "height": 646}, accept_downloads=True, reduced_motion="reduce",
                                  bypass_csp=True)  # только чтобы внедрить axe-core; приложение CSP соблюдает
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        def today_answers_three_questions():
            login(page, base)
            now = page.locator(".lesson.is-now")
            expect(now).to_contain_text("Теория международных отношений")
            expect(now).to_contain_text("осталось 5 мин")
            nxt = page.locator(".lesson.is-next")
            expect(nxt).to_contain_text("Изменена аудитория")
            expect(nxt).to_contain_text("ауд. 318, корпус Б")
            expect(page.locator("#todo")).to_contain_text("Справка об обучении готова")
            # ближайшая пара показана один раз: в ленте дня, но не в сводке «Нужно сделать»
            assert "10:30–11:50" not in page.locator("#todo").inner_text()
            assert page.locator(".lesson", has_text="Международное публичное право").count() == 1
            # документ виден в первом экране 1146×646
            box = page.get_by_role("button", name=re.compile("^Скачать: Справка об обучении")).bounding_box()
            assert box and box["y"] + box["height"] <= 646, box
        check("Сегодня: сейчас / изменения / документ в первом экране 1146×646", today_answers_three_questions)

        def first_visit_tour():
            # Свежая база и обычное движение: перелёт карточек со входа, затем знакомство на данных аккаунта.
            tsrv, _ttmp, tbase = start()
            tctx = browser.new_context(viewport={"width": 1146, "height": 646})
            tp = tctx.new_page()
            terr = []
            tp.on("pageerror", lambda e: terr.append(str(e)))
            tp.goto(tbase + "/login")
            tp.wait_for_timeout(1500)  # фигура входа доиграла появление
            tp.get_by_label("Логин").fill("belova")
            tp.get_by_label("Пароль", exact=True).fill("kampus-anna")
            tp.get_by_role("button", name="Войти").click()
            expect(tp.locator(".arrival-card")).to_have_count(3)  # три карточки со входа в полёте
            expect(tp.locator(".arrival")).to_have_count(0, timeout=5000)  # слой перелёта убран
            assert tp.evaluate("[...document.querySelectorAll('.lesson, .todo')].every(e => getComputedStyle(e).opacity === '1')")
            pop = tp.get_by_role("dialog", name="Привет, Анна!")
            expect(pop).to_be_visible()
            expect(pop).to_contain_text("1 из 6")
            pop.get_by_role("button", name="Показать").click()
            dlg = tp.locator(".tour-pop")
            expect(dlg).to_contain_text("Теория международных отношений, 09:00–10:20, ауд. 205, корпус А")
            dlg.get_by_role("button", name="Дальше").click()
            expect(dlg).to_contain_text("2 изменения, 1 готовый документ, 1 ответ деканата и 4 срока")
            tp.wait_for_timeout(800)
            # Вырез пропускает нажатия: подтверждаем изменение прямо в подсветке.
            tp.locator("#todo").get_by_role("button", name=re.compile("^Подтвердить")).first.click()
            expect(tp.locator("#todo .todo[data-arrive=change]")).to_have_count(1)
            expect(dlg).to_be_visible()
            # Затемнение вне выреза нажатия не пропускает.
            hit = tp.evaluate("(() => { const e = document.elementFromPoint(40, 320); return e.tagName + '.' + e.getAttribute('class'); })()")
            assert hit == 'path.tour-dim', hit
            tp.keyboard.press("ArrowLeft")
            expect(dlg).to_contain_text("Пара идёт сейчас")
            tp.keyboard.press("Escape")
            expect(tp.locator(".tour")).to_have_count(0)
            expect(tp.locator(".toast", has_text="Знакомство можно пройти снова")).to_be_visible()
            tp.reload()
            expect(tp.get_by_role("heading", name="Пары сегодня")).to_be_visible()
            tp.wait_for_selector("html[data-tour-ready]", state="attached")
            assert tp.locator(".tour").count() == 0  # флаг сохранён в аккаунте
            tp.goto(tbase + "/profile")
            tp.get_by_role("button", name="Пройти снова").click()
            expect(tp).to_have_url(tbase + "/")
            expect(tp.get_by_role("dialog", name="Привет, Анна!")).to_be_visible()
            tp.keyboard.press("Control+k")  # поиск приостанавливает знакомство
            expect(tp.locator(".tour.paused")).to_have_count(1)
            tp.keyboard.press("Escape")
            expect(tp.locator(".tour.paused")).to_have_count(0)
            for _ in range(10):
                b = tp.locator(".tour-acts .btn-primary")
                if b.inner_text() == "Готово":
                    b.click()
                    break
                b.click()
                tp.wait_for_timeout(250)  # шаг сменяется после короткого затухания текста
            expect(tp.locator(".tour")).to_have_count(0)
            assert not terr, terr
            tctx.close()
            tsrv.shutdown()
        check("Первый вход: перелёт карточек, знакомство на данных, пропуск и повтор", first_visit_tour)

        def ack_change_persists():
            page.get_by_role("button", name=re.compile("^Подтвердить: изменена аудитория")).click()
            expect(page.locator(".toast")).to_contain_text("Изменение подтверждено")
            page.reload()
            expect(page.locator(".lesson.is-next")).not_to_contain_text("Подтвердить")
            expect(page.locator(".lesson.is-next .tag")).to_have_attribute("title", "Изменение подтверждено")
        check("Подтверждение изменения сохраняется после перезагрузки", ack_change_persists)

        def lesson_detail_and_back():
            page.goto(base + "/")
            page.locator(".lesson.is-next .lesson-link").click()
            expect(page).to_have_url(re.compile(r"/schedule/lesson/\d+"))
            expect(page.get_by_role("dialog")).to_contain_text("Международное публичное право")
            expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()  # фон — исходная страница
            page.keyboard.press("Escape")
            expect(page).to_have_url(base + "/")
            expect(page.get_by_role("dialog")).to_have_count(0)
            page.go_back()  # Back не открывает закрытую деталь снова
            expect(page.get_by_role("dialog")).to_have_count(0)
            page.goto(base + "/")
        check("Деталь занятия: точная ссылка, Escape, Back не переоткрывает", lesson_detail_and_back)

        def download_is_not_receipt():
            with page.expect_download() as d:
                page.get_by_role("button", name=re.compile("^Скачать: Справка об обучении")).click()
            dl = d.value
            assert dl.suggested_filename.endswith(".txt"), dl.suggested_filename
            text = open(dl.path(), encoding="utf-8").read()
            assert "ДЕМОНСТРАЦИОННЫЙ ОБРАЗЕЦ" in text
            page.goto(base + "/documents?filter=active")
            expect(page.locator(".req").filter(has_text="№1")).to_contain_text("Готова")
        check("Скачивание документа не отмечает получение", download_is_not_receipt)

        def create_request_no_duplicates():
            page.goto(base + "/documents")
            expect(page.locator(".req").first).to_be_visible()
            before = page.locator(".req").count()
            page.get_by_role("link", name=re.compile("Справка о стипендии")).first.click()
            dlg = page.get_by_role("dialog")
            dlg.get_by_role("button", name="Отправить заявку").click()
            expect(dlg.locator(".error-text")).to_contain_text("Выберите, куда нужна справка")
            dlg.get_by_label("Куда нужна справка").click()  # свой список вместо системного <select>
            page.get_by_role("option", name="Банк").click()
            expect(dlg.get_by_label("Куда нужна справка")).to_have_text("Банк")
            # обрыв ответа после записи: повтор с тем же ключом не создаёт дубликат
            page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
              await fetch('/api/dev/fault', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf}, body: JSON.stringify({drop_next_write:true})}); }""")
            dlg.get_by_role("button", name="Отправить заявку").click()
            ok = dlg.get_by_text(re.compile("заявка №\\d+ принята"))
            retry = dlg.get_by_role("button", name="Отправить ещё раз")
            expect(ok.or_(retry)).to_be_visible()
            if retry.is_visible():
                expect(dlg).to_contain_text("повторная отправка не создаст дубликат")
                retry.click()
            expect(ok).to_be_visible()
            dlg.get_by_role("button", name="Готово").click()
            page.reload()
            expect(page.locator(".req")).to_have_count(before + 1)
        check("Заявка: валидация, обрыв ответа, повтор без дубликата", create_request_no_duplicates)

        def draft_survives_reload():
            page.goto(base + "/documents/new/dean_appeal")
            page.get_by_label("Кратко о сути").fill("Черновик для проверки")
            page.wait_for_timeout(900)
            page.reload()
            expect(page.get_by_label("Кратко о сути")).to_have_value("Черновик для проверки")
            expect(page.get_by_role("dialog")).to_contain_text("Восстановлен черновик")
            page.get_by_role("button", name="Очистить").click()
            page.keyboard.press("Escape")
        check("Черновик восстанавливается после перезагрузки", draft_survives_reload)

        def notification_read_unread():
            page.goto(base + "/notifications")
            badge = lambda: int(page.locator(".icon-btn .badge").inner_text() or 0)  # noqa: E731
            n0 = badge()
            page.locator(".ntf.is-unread").first.click()
            expect(page.locator(".icon-btn .badge")).to_have_text(str(n0 - 1))
            expect(page.locator(".source")).to_contain_text("Источник")
            page.get_by_role("button", name="Вернуть в непрочитанные").click()
            expect(page.locator(".icon-btn .badge")).to_have_text(str(n0))
            # фильтр «Непрочитанные»: открытая запись не пропадает без объяснения
            page.get_by_role("radio", name=re.compile("Непрочитанные")).click()
            page.locator(".ntf.is-unread").first.click()
            expect(page.locator(".ntf[aria-current=true]")).to_be_visible()
        check("Уведомления: прочтение, возврат, выбранная запись остаётся в фильтре", notification_read_unread)

        def summary_since_and_week():
            page.goto(base + "/")
            expect(page.locator(".since")).to_have_count(0)  # блок «С прошлого визита» убран: главная сводка — неделя
            ctx.grant_permissions(["clipboard-read", "clipboard-write"])
            page.goto(base + "/summary/week")
            dlg = page.get_by_role("dialog", name="Сводка недели")
            # короткий абзац от модели (в тестах — подставная модель) с пометкой и сверкой фактов
            expect(dlg.locator(".ai-text")).to_contain_text("ауд. 318")
            expect(dlg.locator(".ai-chip")).to_have_text("AI")
            expect(dlg.locator(".ai-src")).to_contain_text("сверены с расписанием")
            expect(dlg.locator(".ws-day")).to_have_count(0)  # подробности свёрнуты
            dlg.get_by_role("button", name=re.compile("^Подробнее")).click()
            expect(dlg.locator(".ws-day")).to_have_count(7)
            dlg.get_by_role("button", name="Скопировать").click()
            expect(page.locator(".toast").last).to_contain_text("скопирована")
            text = page.evaluate("navigator.clipboard.readText()")
            assert text.startswith("Сводка недели") and "ауд. 318" in text and "Демонстрационные данные" in text, text[:80]
            dlg.get_by_role("button", name="Готово").click()
            expect(page.get_by_role("dialog")).to_have_count(0)
            expect(page).to_have_url(base + "/")
        check("Сводка недели (AI): абзац со сверкой, подробности, копирование", summary_since_and_week)

        def calendar_and_events():
            page.goto(base + "/schedule?view=week&date=2026-11-16")
            expect(page.locator(".cal-col")).to_have_count(7)
            assert page.locator(".cal-lesson").count() >= 14
            expect(page.locator(".cal-now")).to_have_count(1)  # линия «сейчас» в сегодняшней колонке
            # клавиши как в Notion Calendar: 3 — три дня, J — вперёд, T — сегодня, W — неделя
            page.keyboard.press("3")
            expect(page).to_have_url(re.compile("view=3days"))
            expect(page.locator(".cal-col")).to_have_count(3)
            page.keyboard.press("j")
            expect(page).to_have_url(re.compile("date=2026-11-19"))
            page.keyboard.press("t")
            expect(page).to_have_url(re.compile("date=2026-11-16"))
            page.keyboard.press("w")
            expect(page.locator(".cal-col")).to_have_count(7)
            # протянуть по пустой сетке: вторник 17:00–18:30 (шаг 15 минут)
            page.locator(".cal-scroll").evaluate("el => el.scrollTop = 48 * 15")
            col = page.locator(".cal-col").nth(1)
            top = col.evaluate("el => el.getBoundingClientRect().top")
            box = col.bounding_box()
            x = box["x"] + box["width"] / 2
            page.mouse.move(x, top + 17 * 48 + 2)
            page.mouse.down()
            page.mouse.move(x, top + 17.5 * 48, steps=4)
            page.mouse.move(x, top + 18.5 * 48, steps=6)
            page.mouse.up()
            ed = page.get_by_role("dialog", name="Новое событие")
            expect(ed).to_be_visible()
            expect(ed.locator(".pick-time").first).to_contain_text("17:00")
            expect(ed.locator(".pick-time").last).to_contain_text("18:30")
            page.keyboard.type("Английский клуб")
            page.keyboard.press("Enter")
            ev = page.locator(".cal-ev:not(.is-ghost)", has_text="Английский клуб")
            expect(ev).to_contain_text("17:00–18:30")
            page.reload()
            expect(ev).to_be_visible()  # сохранено на сервере
            # перенести мышью на среду и на час позже
            page.locator(".cal-scroll").evaluate("el => el.scrollTop = 48 * 15")
            b = ev.bounding_box()
            wed = page.locator(".cal-col").nth(2).bounding_box()
            page.mouse.move(b["x"] + b["width"] / 2, b["y"] + 20)
            page.mouse.down()
            page.mouse.move(wed["x"] + wed["width"] / 2, b["y"] + 44, steps=5)
            page.mouse.move(wed["x"] + wed["width"] / 2, b["y"] + 20 + 48, steps=5)
            page.mouse.up()
            expect(ev).to_contain_text("18:00–19:30")
            assert ev.evaluate("el => [...document.querySelectorAll('.cal-col')].indexOf(el.closest('.cal-col'))") == 2
            # потянуть за нижний край: +30 минут
            b = ev.bounding_box()
            page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] - 2)
            page.mouse.down()
            page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] + 24, steps=6)
            page.mouse.up()
            expect(ev).to_contain_text("18:00–20:00")
            week = page.evaluate("fetch('/api/schedule?from=2026-11-16&to=2026-11-22').then(r => r.json())")
            evs = [e for d in week["days"] for e in d["events"]]
            assert [(e["date"], e["start"], e["end"]) for e in evs] == [("2026-11-18", "18:00", "20:00")], evs
            # клик — изменить название
            ev.click()
            ed = page.get_by_role("dialog", name="Событие")
            ed.get_by_label("Название события").fill("Клуб")
            ed.get_by_role("button", name="Сохранить").click()
            ev = page.locator(".cal-ev:not(.is-ghost)", has_text="Клуб")
            expect(ev).to_be_visible()
            # экспорт ровно видимого диапазона: пары и своё событие
            with page.expect_download() as d:
                page.get_by_role("button", name=re.compile("^Экспорт")).click()
            ics = open(d.value.path(), encoding="utf-8").read()
            assert "SUMMARY:Клуб" in ics and "2026-11-16-2026-11-22" in d.value.suggested_filename, d.value.suggested_filename
            # Delete на событии — удалить, «Вернуть» — восстановить
            ev.focus()
            page.keyboard.press("Delete")
            expect(ev).to_have_count(0)
            page.locator(".toast").get_by_role("button", name="Вернуть").click()
            expect(page.locator(".cal-ev:not(.is-ghost)", has_text="Клуб")).to_be_visible()
            # клавиша C — новое событие с клавиатуры, Escape — отмена без следов
            page.keyboard.press("c")
            expect(page.get_by_role("dialog", name="Новое событие")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.get_by_role("dialog", name="Новое событие")).to_have_count(0)
        check("Календарь: день/3 дня/неделя, клавиши, событие протягиванием, перенос, растяжение, правка, экспорт, удаление с возвратом", calendar_and_events)

        def calendar_touch():
            # Телефон: настоящие касания через протокол Chrome — долгое нажатие, перенос пальцем, свайп по дням.
            mctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, reduced_motion="reduce")
            mp = mctx.new_page()
            login(mp, base, "galiev", "kampus-timur")
            mp.goto(base + "/schedule?view=day&date=2026-11-21")  # суббота Тимура: семинар утром, вечер свободен
            expect(mp.locator(".cal-col")).to_have_count(1)
            hour = mp.locator(".cal").evaluate("el => parseFloat(getComputedStyle(el).getPropertyValue('--hh'))")
            cdp = mctx.new_cdp_session(mp)
            touch = lambda typ, x=0, y=0: cdp.send("Input.dispatchTouchEvent", {"type": typ, "touchPoints": [] if typ == "touchEnd" else [{"x": x, "y": y}]})
            mp.locator(".cal-scroll").evaluate("(el, hour) => el.scrollTop = hour * 15", hour)
            col = mp.locator(".cal-col").first
            top = col.evaluate("el => el.getBoundingClientRect().top")
            box = col.bounding_box()
            x, y = box["x"] + box["width"] / 2, top + 17 * hour + 4
            # короткое касание пустой сетки ничего не создаёт
            touch("touchStart", x, y); mp.wait_for_timeout(80); touch("touchEnd")
            mp.wait_for_timeout(200)
            assert mp.locator(".ev-editor").count() == 0
            # долгое нажатие и протягивание: 17:00–18:30, редактор — шторка снизу
            touch("touchStart", x, y); mp.wait_for_timeout(600)
            for k in range(1, 9):
                touch("touchMove", x, y + k * hour * 1.5 / 8); mp.wait_for_timeout(30)
            touch("touchEnd")
            ed = mp.get_by_role("dialog", name="Новое событие")
            expect(ed).to_be_visible()
            assert "sheet" in ed.get_attribute("class")
            assert mp.locator(".ev-editor .pick-time").all_inner_texts() == ["17:00", "18:30"]
            mp.keyboard.type("Бег")
            mp.keyboard.press("Enter")
            ev = mp.locator(".cal-ev:not(.is-ghost)", has_text="Бег")
            expect(ev).to_contain_text("17:00–18:30")
            # долгое нажатие на событии и перенос на час позже
            b = ev.bounding_box()
            ex, ey = b["x"] + b["width"] / 2, b["y"] + 12
            touch("touchStart", ex, ey); mp.wait_for_timeout(600)
            for k in range(1, 9):
                touch("touchMove", ex, ey + k * hour / 8); mp.wait_for_timeout(30)
            touch("touchEnd")
            expect(ev).to_contain_text("18:00–19:30")
            # свайп влево — следующий день
            sy = top + 21 * hour
            touch("touchStart", 330, sy)
            for k in range(1, 7):
                touch("touchMove", 330 - k * 30, sy + k); mp.wait_for_timeout(16)
            touch("touchEnd")
            expect(mp).to_have_url(re.compile("date=2026-11-22"))
            # Неделя остаётся в читаемых колонках; панорамирование не меняет диапазон.
            mp.get_by_role("radio", name="Неделя", exact=True).click()
            expect(mp.locator(".cal-col")).to_have_count(7)
            assert mp.locator(".cal-col").first.bounding_box()["width"] >= 128
            before_url = mp.url
            mp.locator(".cal-scroll").evaluate("el => el.scrollLeft = 280")
            expect(mp.locator(".cal-header")).to_have_js_property("scrollLeft", 280)
            assert mp.locator(".cal-scroll").evaluate("el => el.scrollLeft") > 200
            assert mp.url == before_url
            hleft = mp.locator(".cal-dh").nth(3).bounding_box()["x"]
            cleft = mp.locator(".cal-col").nth(3).bounding_box()["x"]
            assert abs(hleft - cleft) < 1, (hleft, cleft)
            assert mp.evaluate("document.documentElement.scrollWidth <= innerWidth")
            mctx.close()
        check("Календарь на телефоне: долгое нажатие создаёт и переносит, касание не создаёт, свайп листает", calendar_touch)

        def sparkle_vector_motion():
            # Поворот меняет векторную геометрию, а не композитный слой с финальным скачком резкости.
            sctx = browser.new_context(viewport={"width": 834, "height": 804}, device_scale_factor=2)
            sp = sctx.new_page()
            login(sp, base)
            sp.locator(".btn-ai").hover()
            frames = sp.locator(".btn-ai .spark").evaluate("""svg => new Promise(resolve => {
                const frames = [], start = performance.now();
                const tick = now => {
                    const paths = svg.querySelectorAll('.spark-main path');
                    frames.push({d: paths[0].getAttribute('d'), tint: paths[1].getAttribute('d'), transform: getComputedStyle(paths[0].parentElement).transform});
                    if (now - start < 1000) requestAnimationFrame(tick); else resolve(frames);
                };
                requestAnimationFrame(tick);
            })""")
            assert all(f["transform"] == "none" and f["d"] == f["tint"] for f in frames)
            assert len({f["d"] for f in frames}) > 3
            assert len({f["d"] for f in frames[-5:]}) == 1
            sctx.close()
        check("Искра: непрерывный векторный поворот без смены слоя в конце", sparkle_vector_motion)


        def selectors_resize_and_settle():
            sctx = browser.new_context(viewport={"width": 868, "height": 804})
            sp = sctx.new_page()
            login(sp, base)
            sp.evaluate("document.fonts.ready")
            # Выбор плавно доходит до цели и больше не меняется на финальных кадрах.
            for name in ["Расписание", "Документы", "Оценки", "Сегодня"]:
                sp.evaluate("""() => {
                    window.__selectorFrames = [];
                    const start = performance.now();
                    function tick(now) {
                        const nav = document.querySelector('.nav'), marker = nav.querySelector('.nav-ind');
                        const a = nav.querySelector('[aria-current="page"]');
                        const b = marker.getBoundingClientRect(), r = a.getBoundingClientRect();
                        window.__selectorFrames.push({t: now-start, x:b.x, w:b.width, dx:b.x-r.x, dw:b.width-r.width, transform:getComputedStyle(marker).transform});
                        if(now-start < 700) requestAnimationFrame(tick);
                    }
                    requestAnimationFrame(tick);
                }""")
                sp.locator('.nav').get_by_role('link', name=name, exact=True).click()
                sp.wait_for_timeout(750)
                frames = sp.evaluate('window.__selectorFrames')
                assert all(f['transform'] == 'none' for f in frames), frames[-3:]
                assert all(abs(f['dx']) < .15 and abs(f['dw']) < .15 for f in frames[-8:]), frames[-8:]
                for a, b, c, d in zip(frames, frames[1:], frames[2:], frames[3:]):
                    assert not(abs(a['x']-b['x']) < .1 and abs(b['x']-c['x']) > 8 and abs(c['x']-d['x']) < .1), [a,b,c,d]
            sp.goto(base + '/schedule?view=day&date=2026-11-21')
            for width in [515, 1063, 360, 868, 1440, 390, 1063]:
                sp.set_viewport_size({"width": width, "height": 804})
                for view in ['День', '3 дня', 'Неделя']:
                    sp.get_by_role('radio', name=view, exact=True).click()
                    sp.wait_for_timeout(380)
                    # анимация плашки 320 мс может стартовать позже клика (перерисовка недели) — ждём её конца
                    for _ in range(30):  # wait_for_function со строкой запрещён CSP — опрашиваем
                        if sp.evaluate("() => [...document.querySelectorAll('.seg-ind,.nav-ind')].every(m => !m.getAnimations().some(a => a.playState === 'running'))"): break
                        sp.wait_for_timeout(50)
                    sizes = sp.evaluate("""() => {
                        const pairs = [[document.querySelector('.cal-toolbar .seg'), '.seg-ind', '[aria-checked="true"]'],
                                       [document.querySelector('.nav'), '.nav-ind', '[aria-current="page"]']];
                        return pairs.filter(([root])=>root?.getBoundingClientRect().width).map(([root, m, q])=>{
                            const a = root.querySelector(m).getBoundingClientRect(), b = root.querySelector(q).getBoundingClientRect();
                            return [a.x-b.x, a.width-b.width];
                        });
                    }""")
                    assert all(abs(x) < .15 and abs(w) < .15 for x,w in sizes), (width, view, sizes)
            sctx.close()
        check("Селекторы: плавный конец, точная ширина после живого resize 360–1440", selectors_resize_and_settle)

        def ai_hover_and_touch():
            # «Сводка недели» без стрелки (просьба пользователя, 22 ноября): при наведении реагирует только звезда, кнопка не меняет размер.
            sctx = browser.new_context(viewport={"width": 868, "height": 804})
            sp = sctx.new_page()
            login(sp, base)
            button = sp.locator('.btn-ai')
            assert button.locator('.ai-go').count() == 0
            sp.mouse.move(20, 190)
            sp.wait_for_timeout(500)
            before = button.bounding_box()
            button.hover()
            sp.wait_for_timeout(600)
            after = button.bounding_box()
            assert abs(after['width'] - before['width']) < .2 and abs(after['x'] - before['x']) < .2, (before, after)
            assert button.locator('svg.spark').count() == 1
            # фокус с клавиатуры (:focus-visible): программный focus() после мыши его не включает
            button.focus(); sp.keyboard.press('Shift+Tab'); sp.keyboard.press('Tab')
            assert button.evaluate("el => el.matches(':focus-visible')")
            sp.emulate_media(reduced_motion='reduce')
            sp.mouse.move(20, 190)
            sp.locator('.brand').focus()
            button.hover()
            sp.wait_for_timeout(50)
            assert not button.evaluate("el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running')")
            sctx.close()
            tctx = browser.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
            tp = tctx.new_page()
            login(tp, base)
            assert tp.locator('.btn-ai .ai-go').count() == 0
            assert tp.locator('.btn-ai').bounding_box()['width'] < 390
            tctx.close()
        check("Сводка: без стрелки, размер не меняется при наведении, фокус, touch и reduced motion", ai_hover_and_touch)

        def free_day_scene():
            # Неделя по настоящему расписанию: 7 плиток, столбики пар, отменённая — пунктиром; наведение и касание.
            fsrv, _, fbase = start()
            fsrv.cfg.store.set_preferences(1, demo_now='2026-11-21T12:00')
            fsrv.cfg.store.set_tour(1, True)
            fctx = browser.new_context(viewport={"width":868,"height":804})
            fp = fctx.new_page()
            login(fp, fbase)
            scene = fp.locator('.scene-week')
            expect(scene).to_be_visible()
            expect(scene.locator('.week-block')).to_have_count(15)  # пары недели 16–22 ноября у belova: 4+3+3+3+2
            fp.mouse.move(10, 180)
            fp.wait_for_timeout(1300)
            assert scene.get_attribute('aria-hidden') == 'true'
            assert scene.locator('.week-layer').count() == 7
            assert scene.bounding_box()['width'] > 300
            assert scene.locator('[data-week-day="3"] .week-block.is-off').count() == 1  # отменённый немецкий в четверг
            assert scene.locator('.week-sky.is-day .week-sun').count() == 1  # сегодня свободно: солнце над плиткой (12:00 — день)
            assert scene.locator('.week-shadow').count() == 5  # тени пн–пт по демо-часам
            expect(scene.locator('.week-cap')).to_contain_text('Сб, 21 ноября')
            expect(scene.locator('.week-cap')).to_contain_text('сегодня · пар нет')
            WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
            for theme in ['light', 'dark']:
                fp.evaluate("t=>document.documentElement.dataset.theme=t", theme)
                for day in range(7):
                    scene.locator('.week-hits > rect').nth(day).hover()
                    fp.wait_for_timeout(750)
                    expect(scene.locator('.week-layer.hot')).to_have_attribute('data-week-day', str(day))
                    expect(scene.locator('.week-cap')).to_contain_text(WD[day] + ',')
                    bounds = scene.evaluate("""svg=>{
                        const s=svg.getBoundingClientRect(), layers=[...svg.querySelectorAll('.week-layer')].map(e=>e.getBoundingClientRect());
                        const l=Math.min(...layers.map(r=>r.left)), r=Math.max(...layers.map(r=>r.right));
                        return {center:(l+r)/2-(s.left+s.right)/2, inside:layers.every(r=>r.top>=s.top-1&&r.bottom<=s.bottom+1&&r.left>=s.left&&r.right<=s.right)};
                    }""")
                    assert bounds['inside'] and abs(bounds['center']) <= 6, bounds
            scene.locator('.week-hits > rect').nth(0).hover()
            expect(scene.locator('.week-cap')).to_contain_text('4 пары · 09:00–15:30')
            fp.mouse.move(10, 180)
            fp.wait_for_timeout(900)
            expect(scene.locator('.week-layer.hot')).to_have_attribute('data-week-day', '5')
            assert scene.locator('.week-layer.dim').count() == 0
            # всё улеглось; движется только фон (лучи солнца), и он стоит, если «Живой интерфейс» выключен
            assert not scene.evaluate("el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&!a.effect.target.closest('.week-sun-rays'))")
            assert scene.evaluate("el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running')")
            fp.evaluate("document.documentElement.setAttribute('data-still','')")
            fp.wait_for_timeout(50)
            assert not scene.evaluate("el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running')")
            fp.evaluate("document.documentElement.removeAttribute('data-still')")
            fp.emulate_media(reduced_motion='reduce')
            scene.locator('.week-hits > rect').nth(0).hover()
            fp.wait_for_timeout(50)
            assert not scene.evaluate("el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running')")
            fctx.close()
            tctx = browser.new_context(viewport={"width":360,"height":800}, is_mobile=True, has_touch=True, reduced_motion='reduce')
            tp = tctx.new_page()
            login(tp, fbase)
            target = tp.locator('.week-hits > rect').nth(1)
            tp.mouse.move(1, 1)  # курсор Playwright после «Войти» не должен стоять над сценой: на телефоне его нет
            target.tap()
            expect(tp.locator('.week-layer.hot')).to_have_attribute('data-week-day', '1')
            target.tap()
            expect(tp.locator('.week-layer.hot')).to_have_attribute('data-week-day', '5')
            assert tp.evaluate('document.documentElement.scrollWidth <= innerWidth')
            tctx.close()
            fsrv.shutdown()
        check("Свободный день: неделя по расписанию, наведение, подпись, центр, обе темы, касания и reduced motion", free_day_scene)

        def calendar_subscription():
            page.goto(base + "/profile#calendar")
            page.get_by_role("button", name="Создать ссылку подписки").click()
            url = page.get_by_label("Ссылка подписки").input_value()
            assert re.match(r"^http://127\.0\.0\.1:\d+/cal/[A-Za-z0-9_-]{20,}\.ics$", url), url
            expect(page.get_by_role("link", name="Открыть в Календаре")).to_have_attribute("href", re.compile(r"^webcal://"))
            r = page.request.get(url)  # без cookie достаточно ссылки
            assert r.status == 200 and "BEGIN:VCALENDAR" in r.text()
            page.get_by_role("button", name="Перевыпустить или отключить").click()
            page.get_by_role("button", name="Отключить").click()
            expect(page.get_by_role("button", name="Создать ссылку подписки")).to_be_visible()
            assert page.request.get(url).status == 404
        check("Подписка на календарь: ссылка, webcal, перевыпуск/отключение", calendar_subscription)

        def offline_mode():
            # Офлайн: сервер обрывает все соединения (эмуляция set_offline в Chromium не действует на service worker).
            ost = open_store(os.path.join(tempfile.mkdtemp(), "off.db"))
            osrv = make_server(ost, port=0, dev=True, ai=WeekBriefAI(FakeModel()))
            port = osrv.server_address[1]
            threading.Thread(target=osrv.serve_forever, daemon=True).start()
            obase = "http://127.0.0.1:%d" % port
            c3 = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
            p3 = c3.new_page()
            login(p3, obase)
            p3.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null", timeout=10000)
            for path in ("/", "/schedule?view=week", "/grades"):
                p3.goto(obase + path)
                p3.wait_for_load_state("networkidle")
            p3.goto(obase + "/")
            expect(p3.get_by_role("heading", name="Пары сегодня")).to_be_visible()
            osrv.cfg.faults["offline"] = True  # связи нет: сервер рвёт каждое соединение
            p3.reload()
            expect(p3.get_by_role("heading", name="Пары сегодня")).to_be_visible()
            expect(p3.locator(".global-banners")).to_contain_text("сохранённые на устройстве")
            p3.get_by_role("link", name="Оценки").first.click()
            expect(p3.get_by_role("heading", name="Оценки и сессия")).to_be_visible()
            p3.get_by_role("link", name="Сегодня").first.click()
            p3.get_by_role("button", name=re.compile("^Подтвердить: изменена аудитория")).click()
            expect(p3.locator(".toast").last).to_contain_text("нет связи")
            osrv.cfg.faults["offline"] = False  # связь вернулась
            p3.evaluate("window.dispatchEvent(new Event('online'))")
            expect(p3.locator(".global-banners")).to_have_count(0)
            p3.goto(obase + "/profile")
            p3.get_by_role("button", name="Выйти").click()
            expect(p3.get_by_role("heading", name="Вход в кабинет")).to_be_visible()
            assert "kampus-api" not in p3.evaluate("caches.keys()"), "кэш данных не удалён при выходе"
            c3.close()
            osrv.shutdown()
        check("Офлайн: оболочка и сохранённые данные без сети, плашка, выход стирает кэш", offline_mode)

        def palette_search():
            page.goto(base + "/")
            expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()
            page.keyboard.press("Control+k")
            box = page.get_by_role("combobox", name="Поиск по кабинету")
            box.fill("318")
            expect(page.locator(".palette-foot")).to_contain_text(re.compile(r"Найдено: [1-9]"))
            box.fill("zzzz")
            expect(page.locator(".palette")).to_contain_text("Ничего не найдено")
            box.fill("318")
            expect(page.locator(".palette-item").first).to_be_visible()
            page.keyboard.press("ArrowDown")
            page.keyboard.press("ArrowUp")
            page.keyboard.press("Enter")
            expect(page).to_have_url(re.compile(r"/schedule/lesson/\d+"))
            page.keyboard.press("Escape")
        check("Поиск: Ctrl+K, честный счётчик, пустой результат, Enter", palette_search)

        def isolation():
            c2 = browser.new_context()
            p2 = c2.new_page()
            login(p2, base, "galiev", "kampus-timur")
            r = p2.evaluate("async () => (await fetch('/api/requests/1')).status")
            assert r == 404, r
            p2.goto(base + "/documents/1")
            expect(p2.get_by_role("dialog")).to_contain_text("Не найдено")
            c2.close()
        check("Изоляция аккаунтов: чужая заявка недоступна ни в API, ни по ссылке", isolation)

        def fault(body):
            page.evaluate("""async (b) => { const s = await (await fetch('/api/session')).json();
              await fetch('/api/dev/fault', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf}, body: JSON.stringify(b)}); }""", body)

        def offline_and_stale():
            page.goto(base + "/notifications")
            expect(page.locator(".ntf").first).to_be_visible()
            if page.locator(".ntf.is-unread").count() == 0:
                page.locator(".ntf").first.click()
                page.get_by_role("button", name="Вернуть в непрочитанные").click()
            btn = page.get_by_role("button", name=re.compile("Прочитать все"))
            expect(btn).to_be_enabled()
            fault({"fail_reads": 3})
            try:
                btn.click()
                expect(page.locator(".toast").first).to_contain_text("Прочитано")
                expect(page.locator(".global-banners")).to_be_visible()
                expect(page.locator(".ntf.is-unread")).to_have_count(0)  # подтверждённое состояние сохранено
            finally:
                fault({"fail_reads": 0})
            page.locator(".global-banners").get_by_role("button").click()
            expect(page.locator(".global-banners")).to_have_count(0)
        check("Подтверждённая запись при сбое чтения: баннер, повтор", offline_and_stale)

        def session_expiry():
            page.goto(base + "/grades")
            expect(page.get_by_role("heading", name="Оценки и сессия")).to_be_visible()
            page.wait_for_load_state("networkidle")  # иначе 401 у незавершённого запроса откроет диалог раньше клика
            page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
              await fetch('/api/dev/fault', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf}, body: JSON.stringify({expire_session:true})}); }""")
            page.get_by_role("link", name="Документы").first.click()
            dlg = page.get_by_role("dialog", name="Сессия истекла")
            expect(dlg).to_be_visible()
            page.keyboard.press("Escape")
            expect(dlg).to_be_visible()  # нельзя закрыть без входа
            dlg.get_by_label("Пароль").fill("kampus-anna")
            dlg.get_by_role("button", name="Войти").click()
            expect(dlg).to_have_count(0)
            expect(page).to_have_url(base + "/documents")
        check("Истёкшая сессия: вход поверх страницы без потери адреса", session_expiry)

        def keyboard_focus():
            page.goto(base + "/documents")
            page.get_by_role("link", name=re.compile("Обращение в деканат")).first.focus()
            page.keyboard.press("Enter")
            expect(page.get_by_role("dialog")).to_be_visible()
            page.wait_for_function("document.activeElement && document.activeElement.closest('[role=dialog]') !== null", timeout=2000)
            for _ in range(15):
                page.keyboard.press("Tab")
                assert page.evaluate("document.activeElement.closest('[role=dialog]') !== null"), "фокус вышел из диалога"
            page.keyboard.press("Escape")
            expect(page.get_by_role("dialog")).to_have_count(0)
            page.wait_for_timeout(100)
            name = page.evaluate("document.activeElement.textContent")
            assert "Обращение в деканат" in name, "фокус не вернулся: %r" % name
        check("Клавиатура: фокус в диалоге, возврат фокуса", keyboard_focus)

        def layout_matrix():
            # Свежий сервер: кадры показывают исходный демо-набор, не следы предыдущих проверок.
            fsrv, ftmp, fbase = start()
            fctx = browser.new_context(viewport={"width": 1146, "height": 646}, reduced_motion="reduce")
            page = fctx.new_page()
            login(page, fbase)
            base = fbase
            problems = []
            for theme in ("light", "dark"):
                for w, h in VIEWPORTS:
                    page.set_viewport_size({"width": w, "height": h})
                    page.emulate_media(color_scheme=theme)
                    for path in PAGES:
                        page.goto(base + path)
                        page.wait_for_load_state("networkidle")
                        settle(page)
                        sw = page.evaluate("document.documentElement.scrollWidth")
                        if sw > w:
                            problems.append("%s %dx%d %s: scrollWidth %d" % (theme, w, h, path, sw))
                        if SHOTS and path in ("/", "/schedule?view=week", "/documents", "/notifications?id=1", "/grades"):
                            out = os.path.join(ROOT, "docs", "screenshots", "%s-%dx%d-%s.png" % (theme, w, h, re.sub(r"[^a-z0-9]+", "-", path).strip("-") or "today"))
                            page.screenshot(path=out)
            fctx.close()
            fsrv.shutdown()
            shutil.rmtree(ftmp, ignore_errors=True)
            assert not problems, "\n".join(problems)
        check("Нет горизонтального переполнения: 4 ширины × 2 темы × %d страниц" % len(PAGES), layout_matrix)

        def demo_clock():
            # «Время идёт»: бейдж — живые часы; ползунок дня пересчитывает «Сегодня» без перезагрузки, время сохраняется.
            page.goto(base + "/")
            expect(page.locator(".lesson.is-now")).to_contain_text("Теория международных отношений")
            page.locator(".demo-badge").click()
            dlg = page.get_by_role("dialog", name="Демо-время")
            expect(dlg).to_be_visible()
            slider = dlg.get_by_role("slider", name="Время дня")
            expect(slider).to_have_attribute("aria-valuetext", "10:15")
            slider.focus()
            page.keyboard.press("PageUp")  # +1 час: 11:15 — идёт «Международное публичное право»
            expect(page.locator(".lesson.is-now")).to_contain_text("Международное публичное право")
            expect(slider).to_have_attribute("aria-valuetext", "11:15")
            page.keyboard.press("End")  # 22:00 — пары закончились, видна первая пара завтра
            expect(page.locator(".banner", has_text="Пары на сегодня закончились")).to_be_visible()
            expect(page.locator(".tomorrow")).to_contain_text("Завтра")
            sw = dlg.get_by_role("switch", name="Время идёт")
            sw.click()
            expect(sw).to_have_attribute("aria-checked", "false")
            page.keyboard.press("Escape")
            expect(dlg).to_have_count(0)
            page.reload()
            expect(page.locator(".demo-badge")).to_contain_text("22:00")  # сохранено в аккаунте
            s = page.evaluate("fetch('/api/session').then(r => r.json())")
            assert s["user"]["time_flow"] is False and s["user"]["demo_now"] == "2026-11-16T22:00", s["user"]
            page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
              await fetch('/api/preferences', {method: 'PATCH', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf},
                body: JSON.stringify({demo_now: '2026-11-16T10:15', time_flow: true})}); }""")
        check("«Время идёт»: ползунок дня пересчитывает «Сегодня» на лету, стоп часов, сохранение", demo_clock)

        def was_ghost():
            # Призрак «было»: перенос 14:10 → 12:40 в среду виден на старом месте, пока не подтверждён; потом — по наведению.
            page.goto(base + "/schedule?view=week&date=2026-11-16")
            moved = page.locator(".cal-lesson", has_text="Международное публичное право").nth(1)
            expect(moved).to_contain_text("12:40–14:00")
            box = page.locator(".cal-was-box")
            expect(box).to_have_count(1)
            expect(box).to_have_text("было 14:10–15:30")
            assert "перенесено с 14:10–15:30" in moved.get_attribute("aria-label")
            page.wait_for_timeout(400)
            a, g = moved.bounding_box(), box.bounding_box()
            assert abs((g["y"] - a["y"]) - 90 / 60 * 48) < 1.5, (a, g)  # старое начало на 90 минут ниже
            assert page.locator(".cal-was-link .tip").count() == 1
            if "is-changed" in (moved.get_attribute("class") or ""):
                assert page.locator(".cal-was.is-shown").count() == 1  # не подтверждено — видно всегда
                lid = moved.get_attribute("data-lesson")
                page.evaluate("""async (id) => { const s = await (await fetch('/api/session')).json();
                  await fetch('/api/lessons/' + id + '/ack', {method: 'POST', headers: {'X-CSRF-Token': s.csrf}}); }""", lid)
                page.reload()
            page.mouse.move(5, 5)
            page.wait_for_timeout(300)
            assert page.locator(".cal-was.is-shown").count() == 0
            assert box.evaluate("el => +getComputedStyle(el).opacity") < .05
            moved.hover()
            page.wait_for_timeout(500)
            assert box.evaluate("el => +getComputedStyle(el).opacity") == 1
            page.mouse.move(5, 5)
        check("Призрак «было»: старое место переноса, связка, подтверждение и наведение", was_ghost)

        def shared_flight():
            # Сквозной переход: пары «Сегодня» перелетают в колонку дня календаря и обратно; деталь пары открывается без перелёта названия.
            fctx = browser.new_context(viewport={"width": 1280, "height": 800})
            fp = fctx.new_page()
            login(fp, base)
            fp.wait_for_timeout(600)
            fp.evaluate("""() => { window.__fl = 0; const s = performance.now();
              const t = () => { window.__fl = Math.max(window.__fl, document.querySelectorAll('.flight-card').length); if (performance.now() - s < 1500) requestAnimationFrame(t); }; requestAnimationFrame(t); }""")
            fp.get_by_role("link", name="Вся неделя").click()
            fp.wait_for_timeout(1200)
            assert fp.evaluate("window.__fl") == 4, fp.evaluate("window.__fl")  # 4 пары сегодня
            assert fp.locator(".flight").count() == 0  # слой убран
            assert fp.evaluate("[...document.querySelectorAll('.cal-lesson')].every(e => e.style.opacity === '')")
            fp.go_back()
            fp.wait_for_timeout(1200)
            assert fp.locator(".flight").count() == 0
            assert fp.evaluate("[...document.querySelectorAll('#day .lesson')].every(e => e.style.opacity === '')")
            fp.locator(".lesson .lesson-link").first.click()
            fp.wait_for_timeout(80)
            assert fp.locator(".flight, .flight-title").count() == 0  # название не перелетает — шторка въезжает со своим заголовком
            fp.wait_for_timeout(700)
            assert fp.locator("#lesson-title").evaluate("el => getComputedStyle(el).opacity") == "1"
            assert fp.locator(".lesson .lesson-link").first.evaluate("el => getComputedStyle(el).visibility") == "visible"
            fp.keyboard.press("Escape")
            fp.wait_for_timeout(400)
            assert fp.evaluate("[...document.querySelectorAll('.lesson-link')].every(e => e.style.visibility === '')")
            fp.emulate_media(reduced_motion="reduce")
            fp.get_by_role("link", name="Вся неделя").click()
            fp.wait_for_timeout(50)
            assert fp.locator(".flight").count() == 0  # при reduced motion перелёта нет
            fctx.close()
        check("Сквозной переход: пары «Сегодня» ↔ календарь, деталь пары без перелёта названия, reduced motion", shared_flight)

        def three_days_scroll():
            # 3 дня: горизонтальная прокрутка сдвигает диапазон на день (Пн–Ср → Вт–Чт), вертикальная — время.
            page.goto(base + "/schedule?view=3days&date=2026-11-16")
            expect(page.locator(".cal-dh").first).to_contain_text("16")
            grid = page.locator(".cal-scroll")
            grid.hover()
            page.mouse.wheel(120, 0)
            expect(page).to_have_url(re.compile(r"date=2026-11-17"))
            expect(page.locator(".cal-dh").first).to_contain_text("17")
            expect(page.locator(".cal-dh").last).to_contain_text("19")
            page.wait_for_timeout(400)
            page.mouse.wheel(-120, 0)
            expect(page).to_have_url(re.compile(r"date=2026-11-16"))
            page.wait_for_timeout(400)
            top = grid.evaluate("el => el.scrollTop")
            page.mouse.wheel(0, 200)  # вертикаль — только время, диапазон тот же
            page.wait_for_timeout(300)
            assert "date=2026-11-16" in page.url and grid.evaluate("el => el.scrollTop") > top
            # один жест — один день: длинная серия событий (как инерция тачпада) сдвигает только на день
            for _ in range(25):
                page.mouse.wheel(90, 0)
                page.wait_for_timeout(30)
            page.wait_for_timeout(400)
            expect(page).to_have_url(re.compile(r"date=2026-11-17"))
            # своей полосы прокрутки у сетки нет
            assert grid.evaluate("el => el.offsetWidth - el.clientWidth") == 0
            # неделя: горизонтальный жест — на неделю вперёд, тоже ровно один шаг
            page.goto(base + "/schedule?view=week&date=2026-11-16")
            expect(page.locator(".cal-dh").first).to_contain_text("16")
            grid.hover()
            for _ in range(25):
                page.mouse.wheel(90, 0)
                page.wait_for_timeout(30)
            page.wait_for_timeout(500)
            expect(page.locator(".cal-dh").first).to_contain_text("23")
        check("3 дня: горизонтальная прокрутка сдвигает на день (один жест — один шаг), неделя — на неделю, вертикальная — время", three_days_scroll)

        def page_tours():
            # Знакомство с разделом — при первом заходе, один раз на аккаунт; уход закрывает его; «Пройти снова» сбрасывает.
            psrv, _, pbase = start()
            pctx = browser.new_context(viewport={"width": 1280, "height": 800})
            pp = pctx.new_page()
            login(pp, pbase, page_tours=True)
            pp.get_by_role("link", name="Расписание", exact=True).first.click()
            pop = pp.locator(".tour-pop")
            expect(pop).to_have_attribute("data-step", "views", timeout=6000)
            expect(pop).to_contain_text("Расписание · 1 из 4")
            for step in ("grid", "changed", "export"):
                pop.get_by_role("button", name="Дальше").click()
                expect(pop).to_have_attribute("data-step", step)
            pop.get_by_role("button", name="Готово").click()
            expect(pp.locator(".tour")).to_have_count(0)
            pp.reload()
            pp.wait_for_timeout(1500)
            assert pp.locator(".tour").count() == 0  # второй раз не показывается
            # уход в другой раздел закрывает знакомство с прежним, новый раздел — своё
            pp.goto(pbase + "/grades")
            expect(pop).to_contain_text("Оценки · 1 из 3", timeout=6000)
            pp.go_back()  # затемнение пропускает нажатия только в вырезе — уходим кнопкой «Назад»
            expect(pp.locator(".tour")).to_have_count(0)
            pp.goto(pbase + "/documents")
            expect(pop).to_contain_text("Документы · 1 из", timeout=6000)
            pp.keyboard.press("Escape")
            expect(pp.locator(".tour")).to_have_count(0)
            u = pp.evaluate("fetch('/api/session').then(r => r.json()).then(j => j.user)")
            assert u["tours_seen"] == ["schedule", "grades", "documents"], u["tours_seen"]
            # «Пройти снова» в профиле: главное знакомство сейчас, разделы — заново
            pp.goto(pbase + "/profile")
            expect(pop).to_contain_text("Профиль · 1 из 3", timeout=6000)
            pp.keyboard.press("Escape")
            pp.get_by_role("button", name="Пройти снова").click()
            expect(pop).to_have_attribute("data-step", "hello", timeout=6000)
            pp.wait_for_timeout(300)  # клавиши знакомство слушает с первого кадра после показа
            pp.keyboard.press("Escape")
            for _ in range(20):  # отметка «пройдено» уходит на сервер асинхронно
                u = pp.evaluate("fetch('/api/session').then(r => r.json()).then(j => j.user)")
                if u["tour_done"]: break
                pp.wait_for_timeout(100)
            assert u["tours_seen"] == [] and u["tour_done"] is True, u
            pctx.close()
            psrv.shutdown()
        check("Знакомство с разделами: первый заход, один раз, уход закрывает, «Пройти снова»", page_tours)
        def live_script():
            # «Живой» сценарий: в 10:17 демо-времени справка о стипендии готова — тост, колокольчик, статус, строка списка.
            import datetime as _dt
            lsrv, _, lbase = start()
            st = lsrv.cfg.store
            off = {"s": 0}
            st.frozen, st.clock = False, (lambda: _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=off["s"]))
            st.set_preferences(1, demo_now="2026-11-16T10:16")
            lctx = browser.new_context(viewport={"width": 1280, "height": 800})
            lp = lctx.new_page()
            lp.clock.install()
            login(lp, lbase)
            expect(lp.locator(".lessons, .today-grid").first).to_be_visible()
            before = lp.evaluate("fetch('/api/session').then(r => r.json()).then(j => [j.unread, j.user.next_live_at])")
            assert before[1] == "2026-11-16T10:17", before
            assert lp.locator(".toast").count() == 0
            off["s"] = 75  # минута с лишним: и сервер, и страница
            lp.clock.fast_forward(75000)
            toast = lp.locator(".toast")
            expect(toast).to_contain_text("Справка о стипендии готова", timeout=8000)
            expect(lp.locator(".icon-btn .badge")).to_contain_text(str(before[0] + 1))
            assert lp.locator(".icon-btn .ni-bell.ring").count() == 1
            toast.get_by_role("button", name="Открыть").click()
            expect(lp.locator(".drawer, [role=dialog]").first).to_contain_text("Готова", timeout=6000)
            # «Живой интерфейс» выключается в профиле и запоминается на устройстве
            lp.goto(lbase + "/profile")
            sw = lp.get_by_role("switch", name="Живой интерфейс")
            expect(sw).to_have_attribute("aria-checked", "true")
            sw.click()
            expect(sw).to_have_attribute("aria-checked", "false")
            assert lp.evaluate("document.documentElement.hasAttribute('data-still')")
            lp.reload()
            assert lp.evaluate("document.documentElement.hasAttribute('data-still')")
            lctx.close()
            lsrv.shutdown()
        check("Живой сценарий: событие по демо-часам — тост, колокольчик, статус; переключатель «Живой интерфейс»", live_script)
        def live_details():
            # Вторая партия: идущая пара заполняется, метка «сейчас» пульсирует, баллы дорастают, контур панели светлеет.
            dsrv, _, dbase = start()
            dsrv.cfg.store.set_preferences(1, demo_now="2026-11-16T10:58")
            dctx = browser.new_context(viewport={"width": 1280, "height": 800})
            dp = dctx.new_page()
            login(dp, dbase)
            dp.goto(dbase + "/schedule?view=3days&date=2026-11-16")
            cur = dp.locator(".cal-lesson.is-now")
            expect(cur).to_have_count(1)
            assert abs(float(cur.evaluate("e => getComputedStyle(e).getPropertyValue('--prog')")) - 0.35) < 0.01  # 10:30–11:50, сейчас 10:58
            fill = cur.evaluate("e => parseFloat(getComputedStyle(e, '::before').height) / e.offsetHeight")
            assert abs(fill - 0.35) < 0.03, fill
            pulse = "document.getAnimations().filter(a => a.animationName === 'now-pulse' && a.playState === 'running').length"
            assert dp.evaluate(pulse) == 1
            dp.evaluate("document.documentElement.setAttribute('data-still', '')")
            dp.wait_for_timeout(50)
            assert dp.evaluate(pulse) == 0  # «Живой интерфейс» выключен — фон стоит
            dp.evaluate("document.documentElement.removeAttribute('data-still')")
            dp.goto(dbase + "/grades")
            first = dp.locator(".score .count-up").first
            expect(first).to_be_visible()
            final = dp.evaluate("fetch('/api/grades').then(r => r.json()).then(j => String(j.subjects[0].score).replace('.', ','))")
            expect(first).to_have_text(final, timeout=3000)  # дорос до значения
            dp.goto(dbase + "/")
            panel = dp.locator(".today-side .panel").first
            expect(panel).to_be_visible()
            bb = panel.bounding_box()
            dp.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + 12)
            expect(panel).to_have_class(re.compile("is-glow"))
            # соседняя плашка («Заказать документ») тоже светится, если курсор у нижнего края первой
            second = dp.locator(".today-side .panel").nth(1)
            second.scroll_into_view_if_needed()
            b2 = second.bounding_box()
            dp.mouse.move(b2["x"] + b2["width"] / 2, b2["y"] - 30)  # между плашками, курсор не над второй
            expect(second).to_have_class(re.compile("is-glow"))
            expect(panel).to_have_class(re.compile("is-glow"))
            dp.mouse.move(2, 2)
            expect(panel).to_have_class(re.compile("glow-out"))  # гаснет плавно, а не сразу
            expect(panel).not_to_have_class(re.compile("is-glow"))
            expect(panel).not_to_have_class(re.compile("glow-out"), timeout=3000)
            dctx.close()
            dsrv.shutdown()
        check("Живые детали: идущая пара заполняется, пульс «сейчас», баллы дорастают, прожектор по соседним плашкам", live_details)
        def live_day():
            # Третья партия: срок истекает на глазах, перемена, отметка дела, направленный переход, «Коротко» ↔ полоска недели,
            # карточка входа листает примеры, «Прокрутить день».
            import datetime as _dt
            ysrv, _, ybase = start()
            st = ysrv.cfg.store
            off = {"s": 0}
            st.frozen, st.clock = False, (lambda: _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=off["s"]))
            yctx = browser.new_context(viewport={"width": 1280, "height": 820})
            yp = yctx.new_page()
            yp.clock.install()
            yp.goto(ybase + "/login")
            expect(yp.locator(".iso-cards [data-v]")).to_have_attribute("data-v", "0")
            yp.wait_for_timeout(100)  # наблюдатель видимости отзывается асинхронно
            yp.clock.fast_forward(9000)
            assert yp.locator(".iso-cards [data-v]").get_attribute("data-v") != "0"  # верхняя карточка сменила пример
            st.set_preferences(2, demo_now="2026-11-16T12:39")
            login(yp, ybase, "galiev", "kampus-timur")
            task = yp.locator(".todo", has_text="Домашнее задание 2")
            expect(task.locator(".meta")).to_contain_text("через 1 мин")
            off["s"] = 61
            yp.clock.fast_forward(61000)
            expect(task.locator(".meta")).to_contain_text("срок прошёл в 12:40", timeout=5000)
            expect(task).to_have_class(re.compile("just-overdue"))
            # перемена: 14:00–14:10
            st.set_preferences(2, demo_now="2026-11-16T14:05"); off["s"] = 0
            yp.reload()
            expect(yp.locator(".gap-line.is-live")).to_contain_text("Перерыв · ещё 5 мин")
            # отметка дела: зачёркивание рисуется, потом строка уходит в «Выполнено»
            essay = yp.locator("#todo .todo", has_text="Эссе по макроэкономике")
            essay.locator(".checkbox").check()
            expect(essay.first).to_have_class(re.compile("is-striking"))
            expect(yp.locator("#todo .done-tasks summary")).to_contain_text("1", timeout=4000)
            # направленный переход: «Оценки» правее «Сегодня»
            yp.get_by_role("link", name="Оценки", exact=True).first.click()
            expect(yp.locator("#main")).to_have_class(re.compile("dir-fwd"))
            yp.keyboard.press("Escape")
            yp.get_by_role("link", name="Сегодня", exact=True).first.click()
            expect(yp.locator("#main")).to_have_class(re.compile("dir-back"))
            # «Коротко»: полоска недели и упоминания дней подсвечиваются вместе
            yp.goto(ybase + "/summary/week")
            days = yp.locator(".ai-days .ai-day")
            expect(days).to_have_count(7)
            days.nth(2).hover()
            expect(days.nth(2)).to_have_class(re.compile("is-hot"))
            yp.keyboard.press("Escape")
            # «Прокрутить день»: часы бегут, плашка внизу, «Стоп» возвращает обычную скорость
            yp.goto(ybase + "/")
            yp.locator(".demo-badge").click()
            yp.get_by_role("button", name="Прокрутить день").click()
            bar = yp.locator(".lapse")
            expect(bar).to_be_visible()
            off["s"] = 5
            yp.clock.fast_forward(5000)
            expect(yp.locator(".lapse-now")).not_to_have_text(re.compile("^08:0"), timeout=4000)
            bar.get_by_role("button", name="Стоп").click()
            expect(bar).to_have_count(0, timeout=4000)
            u = yp.evaluate("fetch('/api/session').then(r => r.json()).then(j => j.user)")
            assert u["clock_speed"] == 1 and u["demo_now"] > "2026-11-16T09:00", u
            yctx.close()
            ysrv.shutdown()
        check("Живой день: срок истекает, перемена, отметка дела, направление, «Коротко», карточка входа, «Прокрутить день»", live_day)

        def axe_audit():
            found = []
            for theme in ("light", "dark"):
                page.emulate_media(color_scheme=theme)
                for path in ["/", "/schedule?view=week", "/grades", "/documents", "/notifications?id=1", "/profile", "/documents/new/study_cert", "/summary/week"]:
                    page.goto(base + path)
                    page.wait_for_load_state("networkidle")
                    settle(page)
                    page.add_script_tag(content=AXE)
                    res = page.evaluate("async () => (await axe.run(document, {runOnly: ['wcag2a','wcag2aa','wcag21aa']})).violations.map(v => v.id + ' ×' + v.nodes.length + ': ' + v.nodes.slice(0,2).map(n => n.target.join(' ')).join(' | '))")
                    for v in res:
                        found.append("%s %s — %s" % (theme, path, v))
            page.emulate_media(color_scheme="light")
            assert not found, "\n".join(found)
        check("axe-core WCAG 2.1 AA: 8 экранов × 2 темы", axe_audit)

        def reduced_motion():
            page.goto(base + "/")
            expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()
            dur = page.evaluate("getComputedStyle(document.querySelector('.page')).animationDuration")
            assert dur in ("0.001s", "1e-06s", "0s"), dur
        check("prefers-reduced-motion отключает движение", reduced_motion)

        check("Нет ошибок JavaScript", lambda: (_ for _ in ()).throw(AssertionError("; ".join(errors))) if errors else None)
        ctx.close()

        # Стрессовые данные — отдельный сервер и отдельные кадры.
        ssrv, stmp, sbase = start(stress=True)
        sctx = browser.new_context(viewport={"width": 360, "height": 800}, reduced_motion="reduce")
        sp = sctx.new_page()

        def stress_layout():
            login(sp, sbase, "stress", "kampus-stress")
            problems = []
            for w, h in ((360, 800), (1146, 646)):
                sp.set_viewport_size({"width": w, "height": h})
                for path in PAGES + ["/documents/1", "/grades/subject/1"]:
                    sp.goto(sbase + path)
                    sp.wait_for_load_state("networkidle")
                    settle(sp)
                    sw = sp.evaluate("document.documentElement.scrollWidth")
                    if sw > w:
                        problems.append("%dx%d %s: %d" % (w, h, path, sw))
                    if SHOTS and path in ("/", "/notifications?id=1"):
                        sp.screenshot(path=os.path.join(ROOT, "docs", "screenshots", "stress-%dx%d-%s.png" % (w, h, re.sub(r"[^a-z0-9]+", "-", path).strip("-") or "today")))
            assert not problems, "\n".join(problems)
        check("Стресс-набор (длинные строки, 48 уведомлений): без переполнения", stress_layout)
        sctx.close()
        browser.close()
        ssrv.shutdown()
        shutil.rmtree(stmp, ignore_errors=True)
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)

    width = max(len(r[0]) for r in results)
    print("\n" + "\n".join("%-*s  %s  %s" % (width, n, s, d) for n, s, d in results))
    failed = [r for r in results if r[1] != "OK"]
    print("\n%d/%d проверок прошли" % (len(results) - len(failed), len(results)))
    return 1 if failed else 0


if __name__ == "__main__":
    if SHOTS:
        os.makedirs(os.path.join(ROOT, "docs", "screenshots"), exist_ok=True)
    sys.exit(run())
