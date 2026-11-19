"""Покадровая проверка движения «Кампуса» (по правилам motion из скилла stageshow).

Во время реальных действий в браузере каждый кадр (requestAnimationFrame) записывает
прямоугольник и видимую прозрачность наблюдаемых элементов и находит:
  pop in   — элемент появился сразу непрозрачным и без анимации («Nothing pops»);
  pop out  — элемент исчез, будучи непрозрачным («stays mounted until its exit finishes»);
  jump     — оставшийся элемент сдвинулся > 8 px за один кадр без анимации
             («Neighbors make room continuously», «a new row carries the rows below it»).

Запуск: uv run --python 3.12 --with playwright==1.48.0 python tests/motion.py [--film] [--mobile]
--film сохраняет кадры каждого действия в docs/motion/ для просмотра.
Скрипт не заменяет просмотр движения глазами — он находит то, что глаз пропускает.
"""

import os
import re
import shutil
import sys
import tempfile
import threading

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

FILM = "--film" in sys.argv
WATCH = ".since, .since-row, .lesson, .lesson .above, .lesson .tag, .todo, .toast, .drawer, .dialog, .palette, .menu, .icon-btn .badge, .count, " \
        ".error-text, .ntf, .ntf .ud, .req, .ready-doc, .banner, .wcard, .seg-ind, .nav-ind"

SAMPLER = """
(() => {
  const W = %r;
  let id = 0, frames = [], run = true;
  const visOpacity = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
  const animating = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.getAnimations().some(a => a.playState === 'running')) return true; } return false; };
  function tick(t) {
    const f = { t, sy: scrollY, sx: scrollX, els: {} };
    document.querySelectorAll(W).forEach(el => {
      if (!el.dataset.mid) el.dataset.mid = String(++id);
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      f.els[el.dataset.mid] = { sel: (el.className.baseVal ?? el.className) + '', text: (el.textContent || '').trim().slice(0, 40),
        x: r.x + (getComputedStyle(el).position === 'fixed' ? 0 : scrollX), y: r.y + (el.closest('.topbar, .tabbar, .toasts, .overlay, .dialog-wrap, .drawer') ? 0 : scrollY), w: r.width, h: r.height, o: visOpacity(el), a: animating(el) };
    });
    frames.push(f);
    if (run) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__film = { stop: () => { run = false; return frames; } };
})();
""" % WATCH


def analyse(frames):
    found = []
    for i in range(1, len(frames)):
        prev, cur = frames[i - 1]["els"], frames[i]["els"]
        for k, e in cur.items():
            if k not in prev and e["o"] > 0.95 and not e["a"] and i > 1:
                found.append(("pop in", e))
        for k, e in prev.items():
            if k not in cur and e["o"] > 0.95 and not e["a"]:
                found.append(("pop out", e))
        # рывок: сдвиг > 8 px за один кадр, а в соседних кадрах элемент стоит (непрерывное движение — не рывок)
        before = frames[i - 2]["els"] if i >= 2 else {}
        after = frames[i + 1]["els"] if i + 1 < len(frames) else {}
        for k, e in cur.items():
            p = prev.get(k)
            if not p or e["a"] or p["a"]:
                continue
            dy, dx = e["y"] - p["y"], e["x"] - p["x"]
            if abs(dy) <= 8 and abs(dx) <= 8:
                continue
            still_before = k in before and abs(p["y"] - before[k]["y"]) < 1.5 and abs(p["x"] - before[k]["x"]) < 1.5
            still_after = k in after and abs(after[k]["y"] - e["y"]) < 1.5 and abs(after[k]["x"] - e["x"]) < 1.5
            if still_before and still_after:
                found.append(("jump %+dpx" % round(dy if abs(dy) > 8 else dx), e))
    out, seen = [], set()
    for kind, e in found:
        key = (kind.split()[0], e["sel"][:30], e["text"][:24])
        if key not in seen:
            seen.add(key)
            out.append("%-10s %-34s «%s»" % (kind, e["sel"][:34], e["text"][:40]))
    return out


def film(page, name, action, settle=900):
    page.evaluate(SAMPLER)
    page.wait_for_timeout(80)
    shots = []
    if FILM:
        os.makedirs(os.path.join(ROOT, "docs", "motion"), exist_ok=True)
    action()
    if FILM:
        for i in range(6):
            p = os.path.join(ROOT, "docs", "motion", "%s-%d.png" % (name, i))
            page.screenshot(path=p)
            shots.append(p)
            page.wait_for_timeout(45)
    page.wait_for_timeout(settle)
    frames = page.evaluate("window.__film.stop()")
    return analyse(frames), len(frames)


def main():
    tmp = tempfile.mkdtemp()
    store = open_store(os.path.join(tmp, "m.db"))
    srv = make_server(store, port=0, dev=True, ai=WeekBriefAI(FakeModel()))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    report = []
    with sync_playwright() as p:
        channel = os.environ.get("CAMPUS_E2E_CHANNEL")
        b = p.chromium.launch(channel=channel) if channel else p.chromium.launch()
        vw = (360, 800) if "--mobile" in sys.argv else (1146, 646)
        page = b.new_page(viewport={"width": vw[0], "height": vw[1]})
        page.goto(base + "/login")
        page.get_by_label("Логин").fill("belova")
        page.get_by_label("Пароль", exact=True).fill("kampus-anna")
        page.get_by_role("button", name="Войти").click()
        expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()
        page.wait_for_selector(".tour-pop", timeout=8000)  # первый вход: перелёт карточек, затем знакомство
        page.wait_for_timeout(800)
        pop = page.locator(".tour-pop")
        for key, title, act in [
            ("tour-start", "Знакомство: «Показать»", lambda: pop.get_by_role("button", name="Показать").click()),
            ("tour-next", "Знакомство: следующий шаг", lambda: pop.get_by_role("button", name="Дальше").click()),
            ("tour-next2", "Знакомство: шаг к «Нужно сделать»", lambda: pop.get_by_role("button", name="Дальше").click()),
            ("tour-back", "Знакомство: назад", lambda: pop.get_by_role("button", name="Назад").click()),
            ("tour-skip", "Знакомство: пропустить", lambda: page.keyboard.press("Escape")),
        ]:
            try:
                res, n = film(page, key, act, settle=1000)
            except Exception as e:  # noqa: BLE001
                res, n = ["ошибка сценария: %s" % str(e).splitlines()[0]], 0
            report.append((title, n, res))
        page.evaluate("window.scrollTo(0, 0)")
        # знакомства с разделами здесь не снимаются — отмечаем показанными, чтобы не закрывали сценарии
        page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
              await fetch('/api/tour', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf}, body: JSON.stringify({page: '*'})}); }""")
        page.reload()
        expect(page.get_by_role("heading", name="Пары сегодня")).to_be_visible()
        page.wait_for_timeout(500)

        steps = [
            ("ack-today", "Подтвердить изменение в ленте", lambda: page.get_by_role("button", name=re.compile("^Подтвердить: изменена аудитория")).click()),
            ("ack-side", "Подтвердить изменение в «Нужно сделать»", lambda: page.locator("#todo").get_by_role("button", name=re.compile("^Подтвердить")).first.click()),
            ("task-done", "Отметить срок выполненным", lambda: page.locator("#todo .todo .checkbox").first.click()),
            ("doc-received", "Отметить справку полученной", lambda: page.get_by_role("button", name=re.compile("^Отметить получение")).click()),
            ("drawer-open", "Открыть деталь занятия", lambda: page.locator(".lesson-link").first.click()),
            ("drawer-close", "Закрыть деталь (Escape)", lambda: page.keyboard.press("Escape")),
            ("palette-open", "Открыть поиск", lambda: page.keyboard.press("Control+k")),
            ("palette-close", "Закрыть поиск", lambda: page.keyboard.press("Escape")),
            ("menu-open", "Открыть меню аккаунта", lambda: page.get_by_role("button", name=re.compile("^Аккаунт")).click()),
            ("menu-close", "Закрыть меню", lambda: page.keyboard.press("Escape")),
            ("week-open", "Сводка недели: открыть (абзац модели)", lambda: page.locator(".btn-ai").click()),
            ("week-more", "Сводка недели: подробности", lambda: page.locator(".ws-more").click()),
            ("week-close", "Сводка недели: закрыть", lambda: page.keyboard.press("Escape")),
        ]
        for key, title, act in steps:
            try:
                res, n = film(page, key, act)
            except Exception as e:  # noqa: BLE001
                res, n = ["ошибка сценария: %s" % str(e).splitlines()[0]], 0
            report.append((title, n, res))
        # уведомления: открытие = прочтение (точка и счётчик), смена выбранной записи
        page.goto(base + "/notifications")
        expect(page.locator(".ntf").first).to_be_visible()
        page.wait_for_timeout(600)
        for key, title, act in [
            ("ntf-open", "Открыть уведомление (точка, счётчик)", lambda: page.locator(".ntf.is-unread").first.click()),
            ("ntf-unread", "Вернуть в непрочитанные", lambda: page.get_by_role("button", name="Вернуть в непрочитанные").click()),
            ("ntf-readall", "Прочитать все", lambda: page.get_by_role("button", name=re.compile("Прочитать все")).click()),
        ]:
            if key == "ntf-readall" and page.locator(".mobile-back").is_visible():
                page.get_by_role("button", name="К списку").click()
                page.wait_for_timeout(400)
            try:
                res, n = film(page, key, act, settle=1200)
            except Exception as e:  # noqa: BLE001
                res, n = ["ошибка сценария: %s" % str(e).splitlines()[0]], 0
            report.append((title, n, res))
        # «Время идёт»: ползунок дня — пара меняет фазу на глазах (строка состояния и полоса уезжают/приезжают)
        page.goto(base + "/")
        expect(page.locator(".lesson").first).to_be_visible()
        page.wait_for_timeout(600)
        page.locator(".demo-badge").click()
        page.wait_for_timeout(400)
        page.get_by_role("slider", name="Время дня").focus()
        for key, title, act in [
            ("clock-hour", "Демо-время: +1 час (пара сменяется)", lambda: page.keyboard.press("PageUp")),
            ("clock-end", "Демо-время: конец дня (пары закончились)", lambda: page.keyboard.press("End")),
            ("clock-back", "Демо-время: обратно к 10:15", lambda: page.keyboard.press("Home")),
        ]:
            try:
                res, n = film(page, key, act, settle=1200)
            except Exception as e:  # noqa: BLE001
                res, n = ["ошибка сценария: %s" % str(e).splitlines()[0]], 0
            report.append((title, n, res))
        page.keyboard.press("Escape")
        page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
          await fetch('/api/preferences', {method: 'PATCH', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf},
            body: JSON.stringify({demo_now: '2026-11-16T10:15'})}); }""")
        # календарь: смена вида и шаг вперёд (тело уходит и приходит), раскрытие своего списка
        page.goto(base + "/schedule?view=week&date=2026-11-16")
        expect(page.locator(".cal-col").first).to_be_visible()
        page.wait_for_timeout(600)
        for key, title, act in [
            ("cal-3days", "Календарь: неделя → 3 дня", lambda: page.keyboard.press("3")),
            ("cal-next", "Календарь: следующие 3 дня", lambda: page.keyboard.press("j")),
            ("cal-week", "Календарь: обратно к неделе", lambda: page.keyboard.press("w")),
        ]:
            try:
                res, n = film(page, key, act, settle=900)
            except Exception as e:  # noqa: BLE001
                res, n = ["ошибка сценария: %s" % str(e).splitlines()[0]], 0
            report.append((title, n, res))
        # призрак «было»: после подтверждения появляется по наведению и тает, когда курсор уходит
        page.goto(base + "/schedule?view=week&date=2026-11-16")
        expect(page.locator(".cal-col").first).to_be_visible()
        page.evaluate("""async () => { const s = await (await fetch('/api/session')).json();
          const id = document.querySelectorAll('.cal-lesson.is-changed')[0] && [...document.querySelectorAll('.cal-lesson[data-lesson]')].find(e => e.textContent.includes('Международное публичное') && e.textContent.includes('12:40'))?.dataset.lesson;
          if (id) await fetch('/api/lessons/' + id + '/ack', {method: 'POST', headers: {'X-CSRF-Token': s.csrf}}); }""")
        page.reload()
        expect(page.locator(".cal-was-box")).to_have_count(1)
        page.mouse.move(5, 5)
        page.wait_for_timeout(600)
        moved = page.locator(".cal-lesson", has_text="Международное публичное право").nth(1)
        moved.scroll_into_view_if_needed()
        for key, title, act in [
            ("was-in", "Призрак «было»: наведение на перенесённую пару", lambda: moved.hover()),
            ("was-out", "Призрак «было»: курсор ушёл", lambda: page.mouse.move(5, 5)),
        ]:
            try:
                res, n = film(page, key, act, settle=700)
            except Exception as e:  # noqa: BLE001
                res, n = ["ошибка сценария: %s" % str(e).splitlines()[0]], 0
            report.append((title, n, res))
        # форма: ошибки полей
        page.goto(base + "/documents/new/dean_appeal")
        expect(page.get_by_role("dialog")).to_be_visible()
        page.wait_for_timeout(500)
        res, n = film(page, "form-errors", lambda: page.get_by_role("button", name="Отправить заявку").click())
        report.append(("Ошибки формы", n, res))
        b.close()
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    total = 0
    for title, n, res in report:
        total += len(res)
        print("\n■ %s  (%d кадров)%s" % (title, n, "  — чисто" if not res else ""))
        for r in res:
            print("   " + r)
    print("\nНаходок: %d" % total)


if __name__ == "__main__":
    main()
