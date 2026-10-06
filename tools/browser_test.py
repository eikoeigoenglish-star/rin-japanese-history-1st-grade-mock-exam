#!/usr/bin/env python3
"""
演習モード／模試モードのブラウザ総合テスト（開発用・Playwright）。
演習モードは「回答だけ蓄積 → 最終問題で一括採点」方式を前提にしている。

  python3 -m http.server 8765 &      # リポジトリ直下で
  python3 tools/browser_test.py [--shots DIR]

サイトの動作には不要。GitHub Pages へは JSON/HTML/CSS/JS のみで配信される。
"""
import argparse
import glob
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://localhost:8765"
PROGRESS_KEY = "rin-japanese-history-practice-progress-v1"
SITE_NAME = "歴史能力検定 日本史1級模擬試験"

DATA = {}
for path in sorted(glob.glob(os.path.join(ROOT, "data", "mock*.json"))):
    no = int(os.path.basename(path)[4:7])
    with open(path, encoding="utf-8") as fh:
        DATA[no] = {q["number"]: q for q in json.load(fh)["questions"]}
TOTAL = sum(len(v) for v in DATA.values())
TYPE_TOTAL = {t: sum(1 for m in DATA.values() for q in m.values() if q["type"] == t) for t in ("4択", "記述", "論述")}
ALL_STAGES = ("new", "miss", "hit", "double", "triple")

results = []
console_errors = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


# ---------------------------------------------------------------- helpers
def open_practice(page):
    page.goto(f"{BASE}/practice.html")
    page.wait_for_function("window.RinPractice && window.RinPractice.loadStats")


def target_count(page):
    txt = page.locator("#target-summary").inner_text()
    m = re.search(r"対象：\s*(\d+)問", txt)
    return int(m.group(1)) if m else 0, txt


def set_input(page, input_id, want):
    """ユーザー同様に label をタップして状態を合わせる。"""
    inp = page.locator(f"#{input_id}")
    if inp.is_checked() != want:
        page.locator(f'label[for="{input_id}"]').click()
    assert inp.is_checked() == want, input_id


def set_group(page, name, values, all_values):
    for v in all_values:
        iid = page.locator(f'input[name="{name}"][value="{v}"]').get_attribute("id")
        set_input(page, iid, v in values)


def configure(page, mocks=None, types=("4択", "記述", "論述"), stages=ALL_STAGES, count="5", order="random"):
    page.click("#mock-clear-all")
    if mocks is None:
        page.click("#mock-select-all")
    else:
        for m in mocks:
            set_input(page, f"mock-{m:03d}", True)
    set_group(page, "qtype", types, ("4択", "記述", "論述"))
    set_group(page, "stage", stages, ALL_STAGES)
    set_input(page, f"count-{count}", True)
    set_input(page, f"order-{order}", True)


def start(page):
    page.click("#start-btn")
    page.wait_for_selector("#screen-quiz:not([hidden])")


def current_q(page):
    label = page.locator("#quiz-qlabel").inner_text()
    m = re.match(r"第(\d+)回\s*第(\d+)問", label)
    return int(m.group(1)), int(m.group(2))


def counter(page):
    a, b = page.locator("#quiz-counter").inner_text().replace(" ", "").split("/")
    return int(a), int(b)


def fill_answer(page, correct=True):
    """現在の問題に回答を入力・選択するだけ（採点はしない）。"""
    mno, qno = current_q(page)
    q = DATA[mno][qno]
    if q["type"] == "4択":
        label = q["answer"] if correct else [x for x in "①②③④" if x != q["answer"]][0]
        page.locator(f'#quiz-card .choice-btn[data-label="{label}"]').click()
    elif q["type"] == "記述":
        page.fill("#text-answer", q["answer"] if correct else "誤答テスト")
    else:
        for b in q["cloze"]["blanks"]:
            page.fill(f'[data-blank-id="{b["id"]}"]', b["answer"] if correct else "誤答")
    return q


def run_session(page, correct=lambda i, q: True):
    """全問に回答して最後に一括採点し、結果画面まで進める。回答した問題を返す。"""
    asked = []
    _, total = counter(page)
    for i in range(total):
        key = current_q(page)
        q = fill_answer(page, correct(i, DATA[key[0]][key[1]]))
        asked.append((key, q))
        page.click("#next-btn")
    page.wait_for_selector("#screen-result:not([hidden])")
    return asked


def progress_raw(page):
    return page.evaluate(f"localStorage.getItem('{PROGRESS_KEY}')")


def streaks(page):
    return page.evaluate("window.RinPractice.streaks")


def quiz_text(page):
    return page.locator("#screen-quiz").inner_text()


def quiz_html(page):
    return page.evaluate("document.getElementById('screen-quiz').innerHTML")


def no_feedback_in_quiz(page):
    """回答フェーズで採点情報が DOM に一切ないこと。"""
    html = quiz_html(page)
    txt = quiz_text(page)
    bad = []
    for sel in ("[data-verdict]", ".feedback", ".is-answer", ".is-wrong", ".cloze-result", ".model-answer", ".stage-transition", "[data-ai-copy]"):
        if page.locator(f"#screen-quiz {sel}").count():
            bad.append(sel)
    # 「模範解答の空欄を埋めてください」という操作説明は除外し、採点・解説系の表示語を検査する
    for word in ("不正解", "正解", "× ", "あなたの解答", "解説", "→ ヒット", "→ ミス", "→ ダブル", "→ トリプル"):
        if word in txt:
            bad.append(word)
    if "is-ok" in html or "is-ng" in html:
        bad.append("is-ok/is-ng")
    return bad


def no_hscroll(page):
    return page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")


def back_to_setup(page):
    if page.locator("#screen-result:not([hidden])").count():
        page.click("#back-setup-btn")
    page.wait_for_selector("#screen-setup:not([hidden])")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()
    shots = args.shots
    if shots:
        os.makedirs(shots, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
        dialog_ctl = {"mode": "accept", "messages": []}

        def on_dialog(d):
            dialog_ctl["messages"].append(d.message)
            d.accept() if dialog_ctl["mode"] == "accept" else d.dismiss()
        page.on("dialog", on_dialog)

        # ================= 41. 模試モード回帰 =================
        page.goto(f"{BASE}/index.html")
        page.wait_for_function("document.querySelectorAll('.mock-card').length === 29")
        datafiles = [json.load(open(f, encoding="utf-8")) for f in sorted(glob.glob(os.path.join(ROOT, "data", "mock*.json")))]
        hard = sum(1 for d in datafiles if d["exam_difficulty"] == "難")
        easy = sum(1 for d in datafiles if d["exam_difficulty"] == "易")
        check("41a index: 模試カード29件", page.locator(".mock-card").count() == 29)
        check("41b index: 難/易バッジ数がJSONと一致", page.locator(".mock-difficulty-mark.is-hard").count() == hard and page.locator(".mock-difficulty-mark.is-easy").count() == easy, f"難{hard} 易{easy}")
        check("41c index: 問題/解答リンク", page.locator('a[href="exam.html?mock=001"]').count() == 1 and page.locator('a[href="answers.html?mock=029"]').count() == 1)
        check("41d index: 模試モードが aria-current・白背景", page.locator('.mode-switch a[aria-current]').inner_text().strip() == "模試モード"
              and page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(255, 255, 255)")
        check("42b 模試モードのサイト名も統一", page.locator("h1").inner_text().strip() == SITE_NAME, page.locator("h1").inner_text())
        for mid in ("001", "025", "029"):
            page.goto(f"{BASE}/exam.html?mock={mid}")
            page.wait_for_selector(".question-card")
            check(f"41e exam.html?mock={mid}: 30問", page.locator(".question-card").count() == 30)
            page.goto(f"{BASE}/answers.html?mock={mid}")
            page.wait_for_selector(".answer-card")
            check(f"41f answers.html?mock={mid}: 30解答＋正解一覧", page.locator(".answer-card").count() == 30 and page.locator(".answer-summary-item").count() == 30)
        check("42c 解答ページの見出しも統一", SITE_NAME in page.locator(".eyebrow").inner_text())

        # ================= 39/40. 実URLで29 JSON 自動fetch =================
        page.goto(f"{BASE}/practice.html")
        page.wait_for_function("window.RinPractice && window.RinPractice.loadStats")
        page.evaluate("localStorage.clear()")
        net = {"ok": 0, "fail": 0, "urls": set()}

        def on_resp(r):
            if re.search(r"/data/mock\d{3}\.json", r.url):
                net["urls"].add(r.url)
                net["ok" if r.status == 200 else "fail"] += 1

        def on_fail(r):
            if "/data/mock" in r.url:
                net["fail"] += 1
        page.on("response", on_resp)
        page.on("requestfailed", on_fail)
        open_practice(page)
        page.remove_listener("response", on_resp)
        page.remove_listener("requestfailed", on_fail)
        stats = page.evaluate("window.RinPractice.loadStats")
        print("  loadStats:", stats, "network ok/fail:", net["ok"], net["fail"])
        check("39 mock001〜029 自動fetch成功（ネットワーク実測 29/0）", net["ok"] == 29 and net["fail"] == 0 and len(net["urls"]) == 29 and stats["ok"] == 29 and stats["failed"] == 0)
        check("40 総問題数870（4択580・記述232・論述58）", stats["total"] == TOTAL == 870 and stats["byType"] == {"4択": 580, "記述": 232, "論述": 58})
        check("40b エラーバナーなし・0 / 870 表示", page.locator("#load-notice").is_hidden() and "0 / 870" in page.locator("#mastery-headline").inner_text())
        check("42 演習モード左上が「歴史能力検定 日本史1級模擬試験」",
              page.evaluate("document.querySelector('.app-title-main').textContent.trim()") == SITE_NAME
              and "演習トレーニング" in page.locator(".app-title-sub").inner_text())
        check("38 ダークテーマ維持（背景 #101014）", page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(16, 16, 20)")

        # ================= 4択：回答フェーズ =================
        configure(page, mocks=[1], types=("4択",), count="3", order="sequential")
        before_raw = progress_raw(page)
        start(page)
        check("15a 1問目のボタンは「次へ」・前へは無効", page.locator("#next-btn").inner_text().strip() == "次へ" and page.locator("#prev-btn").is_disabled())
        q1 = DATA[1][1]
        page.click('#quiz-card .choice-btn[data-label="②"]')
        check("1 4択を選択しても正解・不正解が出ない", not no_feedback_in_quiz(page), ",".join(no_feedback_in_quiz(page)))
        check("2 4択回答後も正答・解説が表示されない", q1["explanation"][:20] not in quiz_text(page) and page.locator("#quiz-card .is-answer").count() == 0)
        check("1b 選択中は中立表示（選択中ラベル・緑赤なし）", page.locator('#quiz-card .choice-btn.is-selected').count() == 1 and "選択中" in page.locator('#quiz-card .choice-btn.is-selected').inner_text())
        if shots:
            page.screenshot(path=f"{shots}/B-choice-selected-390.png", full_page=True)
        page.click('#quiz-card .choice-btn[data-label="④"]')
        sel = page.locator('#quiz-card .choice-btn.is-selected')
        check("3 4択の選択を変更できる", sel.count() == 1 and sel.get_attribute("data-label") == "④" and page.locator('#quiz-card .choice-btn[aria-pressed="true"]').count() == 1)
        page.click("#next-btn")
        resp = page.evaluate("window.RinPractice.sessionResponses")
        check("4 次へで回答がセッションに保存される", resp[0] == {"choice": "④"} and current_q(page) == (1, 2), f"{resp[0]}")
        page.click("#prev-btn")
        check("5 前へ戻ると4択回答が復元される", current_q(page) == (1, 1) and page.locator('#quiz-card .choice-btn.is-selected').get_attribute("data-label") == "④")
        page.click('#quiz-card .choice-btn[data-label="①"]')
        page.click("#next-btn")
        # 未回答のまま次へ
        page.click("#next-btn")
        check("未回答で次へ→「回答を入力してください」", page.locator("[data-input-error]").is_visible() and "回答を入力してください" in page.locator("[data-input-error]").inner_text() and current_q(page) == (1, 2))
        page.click('#quiz-card .image-choice-btn[data-label="③"]')
        check("画像4択も選択のみ（正誤表示なし）", not no_feedback_in_quiz(page) and page.locator('#quiz-card .image-choice-btn.is-selected').count() == 1)
        page.click("#next-btn")
        check("15 最終問題のボタンが「採点して結果を見る」", page.locator("#next-btn").inner_text().strip() == "採点して結果を見る")
        if shots:
            page.screenshot(path=f"{shots}/E-last-question-390.png", full_page=False)
        check("13/14 演習途中では習得度・localStorageが変わらない", progress_raw(page) == before_raw and streaks(page) == {} and page.evaluate("window.RinPractice.sessionPhase") == "answering")
        fill_answer(page, True)
        page.click("#next-btn")
        page.wait_for_selector("#screen-result:not([hidden])")
        check("16 最終操作で全問一括採点", page.locator(".result-item").count() == 3 and page.evaluate("window.RinPractice.sessionPhase") == "graded")
        check("17 結果画面で初めて○/×", page.locator(".result-item .result-mark").count() == 3 and page.locator(".result-item.is-correct").count() == 2 and page.locator(".result-item.is-wrong").count() == 1)
        check("18 結果画面で初めて正答表示", q1["choices"][0]["text"][:15] in page.locator(".result-item").first.inner_text())
        wrong_item = page.locator(".result-item").nth(1)
        check("19 結果画面で解説が表示される（誤答は解説を最初から展開）",
              wrong_item.locator("details").first.get_attribute("open") is not None and DATA[1][2]["explanation"][:15] in wrong_item.inner_text())
        check("18b 4択は結果画面で自分の選択と正解を色分け", page.locator(".result-item").nth(1).locator(".result-choice.is-answer").count() == 1 and page.locator(".result-item").nth(1).locator(".result-choice.is-wrong").count() == 1)
        st = streaks(page)
        check("20 結果画面で習得度が更新・保存", st == {"mock001-q01": 1, "mock001-q02": 0, "mock001-q03": 1} and progress_raw(page) is not None, f"{st}")
        check("20b 結果に習得度変化（未出題→ヒット／→ミス）", "ヒット" in page.locator(".result-item").first.inner_text() and "ミス" in page.locator(".result-item").nth(1).inner_text())
        if shots:
            page.screenshot(path=f"{shots}/F-result-390.png", full_page=True)

        # 31/32 間違えた問題を再演習（一括採点）
        page.click("#retry-wrong-btn")
        page.wait_for_selector("#screen-quiz:not([hidden])")
        check("31 間違えた問題だけで再演習", counter(page) == (1, 1) and current_q(page) == (1, 2))
        page.click('#quiz-card .image-choice-btn[data-label="①"]')
        check("32 再演習も即時採点しない", not no_feedback_in_quiz(page) and page.locator("#next-btn").inner_text().strip() == "採点して結果を見る", ",".join(no_feedback_in_quiz(page)))
        page.click("#next-btn")
        page.wait_for_selector("#screen-result:not([hidden])")
        check("32b 再演習も最後に一括採点（ミス→ヒット）", streaks(page).get("mock001-q02") == 1)
        back_to_setup(page)

        # ================= 記述 =================
        page.evaluate(f"localStorage.removeItem('{PROGRESS_KEY}')")
        open_practice(page)
        configure(page, mocks=[26], types=("記述",), count="3", order="sequential")
        start(page)
        attrs = page.evaluate("(() => {const i=document.getElementById('text-answer'); return [i.getAttribute('autocomplete'), i.getAttribute('spellcheck'), parseFloat(getComputedStyle(i).fontSize)]})()")
        check("入力欄 autocomplete/spellcheck off・16px以上", attrs[0] == "off" and attrs[1] == "false" and attrs[2] >= 16, f"{attrs}")
        page.fill("#text-answer", "　防人　")
        page.evaluate("document.getElementById('text-answer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true, cancelable:true}))")
        page.evaluate("document.getElementById('text-answer').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:229, bubbles:true, cancelable:true}))")
        check("34 IME変換中のEnterで次へ進まない", current_q(page) == (26, 3))
        check("6 記述を入力しても即採点されない", not no_feedback_in_quiz(page))
        if shots:
            page.screenshot(path=f"{shots}/C-text-entered-390.png", full_page=True)
        page.locator("#text-answer").press("Enter")
        check("6b 通常のEnterで次の問題へ（採点なし）", current_q(page) == (26, 6) and not no_feedback_in_quiz(page))
        page.fill("#text-answer", "滝口")
        check("12 演習途中にaccepted_answersが表示されない", "滝口の武士" not in quiz_html(page) and "滝口の武者" not in quiz_html(page))
        page.click("#prev-btn")
        check("7 記述回答を戻ると復元される", page.input_value("#text-answer") == "　防人　")
        page.fill("#text-answer", "防人")
        page.click("#next-btn")
        check("7b 戻って編集後も次問の入力は保持", page.input_value("#text-answer") == "滝口")
        page.fill("#text-answer", "滝口の武者")
        page.click("#next-btn")
        page.click("[data-giveup]")
        check("「わからない」は未回答として記録（不正解とは表示しない）", page.locator("[data-giveup-note]").is_visible() and "不正解" not in quiz_text(page))
        page.click("#next-btn")
        page.wait_for_selector("#screen-result:not([hidden])")
        items = page.locator(".result-item")
        check("20c 記述の一括採点（完全一致○・別表記○・わからない×）",
              items.nth(0).get_attribute("class").find("is-correct") >= 0 and items.nth(1).get_attribute("class").find("is-correct") >= 0 and items.nth(2).get_attribute("class").find("is-wrong") >= 0)
        check("18c 記述：あなたの回答と正答を表示", "滝口の武者" in items.nth(1).inner_text() and "滝口の武士" in items.nth(1).inner_text())
        back_to_setup(page)

        # ================= 論述 =================
        configure(page, mocks=[25], types=("論述",), count="all", order="sequential")
        start(page)
        q10 = DATA[25][10]
        check("11 演習途中にmodel_answerが表示されない", q10["model_answer"] not in quiz_text(page) and all(b["answer"] not in quiz_html(page) for b in q10["cloze"]["blanks"]))
        check("10 演習途中にexplanationが表示されない", q10["explanation"][:20] not in quiz_text(page))
        page.fill('[data-blank-id="1"]', "細川・山名")
        page.click("#next-btn")
        check("論述に未入力欄→「回答を入力してください」", page.locator("[data-input-error]").is_visible() and current_q(page) == (25, 10))
        page.locator('[data-blank-id="1"]').press("Enter")
        check("Enterで次の空欄へ", page.evaluate("document.activeElement.dataset.blankId") == "2")
        page.fill('[data-blank-id="2"]', "守護・大名")
        check("8 論述を入力しても即採点されない", not no_feedback_in_quiz(page), ",".join(no_feedback_in_quiz(page)))
        if shots:
            page.screenshot(path=f"{shots}/D-cloze-entered-390.png", full_page=True)
        page.click("#next-btn")
        page.click("#prev-btn")
        check("9 論述回答を戻ると復元", page.input_value('[data-blank-id="1"]') == "細川・山名" and page.input_value('[data-blank-id="2"]') == "守護・大名")
        page.fill('[data-blank-id="2"]', "守護・国人")
        page.click("#next-btn")
        q30 = DATA[25][30]
        for i, b in enumerate(q30["cloze"]["blanks"]):
            page.fill(f'[data-blank-id="{b["id"]}"]', b["answer"] if i else b["answer"] + "x")
        page.click("#next-btn")
        page.wait_for_selector("#screen-result:not([hidden])")
        r0, r1 = page.locator(".result-item").nth(0), page.locator(".result-item").nth(1)
        check("22 論述 全空欄正解→○（戻って修正した回答で採点）", "is-correct" in r0.get_attribute("class"))
        check("23 論述 1空欄だけ誤答→問題全体×", "is-wrong" in r1.get_attribute("class") and r1.locator(".cloze-result tr.is-ng").count() == 1)
        check("論述の結果にmodel_answer・採点のポイント", r1.locator(".model-answer").count() == 1 and r1.locator("summary", has_text="採点のポイント").count() == 1)
        back_to_setup(page)

        # ================= 21/22 遷移・23 二重採点・33 中断 =================
        page.evaluate(f"localStorage.removeItem('{PROGRESS_KEY}')")
        open_practice(page)
        seen = []
        for ok in (True, True, True, True, False):
            configure(page, mocks=[1], types=("4択",), count="1", order="sequential")
            start(page)
            fill_answer(page, ok)
            page.click("#next-btn")
            page.wait_for_selector("#screen-result:not([hidden])")
            seen.append(page.locator(".result-item .stage-transition").inner_text().split("→")[-1].strip())
            back_to_setup(page)
        check("21 正解で 未出題→ヒット→ダブル→トリプル→トリプル", seen[:4] == ["ヒット", "ダブル", "トリプル", "トリプル"], f"{seen}")
        check("22 誤答でミスへ戻る", seen[4] == "ミス")
        configure(page, mocks=[1], types=("4択",), count="1", order="sequential")
        start(page)
        fill_answer(page, True)
        page.evaluate("(() => { const b = document.getElementById('next-btn'); b.click(); b.click(); b.click(); })()")
        page.wait_for_selector("#screen-result:not([hidden])")
        page.go_back()
        page.wait_for_timeout(300)
        page.evaluate("document.getElementById('next-btn').click()")
        check("23 採点の連打・戻る→再実行でも二重更新しない（ミス→ヒットの1段のみ）", streaks(page).get("mock001-q01") == 1, f"{streaks(page)}")
        back_to_setup(page) if page.locator("#screen-result:not([hidden])").count() else None
        page.wait_for_selector("#screen-setup:not([hidden])")
        snap = progress_raw(page)
        configure(page, mocks=[2], types=("4択",), count="3", order="sequential")
        start(page)
        fill_answer(page, True); page.click("#next-btn")
        fill_answer(page, False); page.click("#next-btn")
        dialog_ctl["messages"] = []
        page.click("#quit-btn")
        page.wait_for_selector("#screen-setup:not([hidden])")
        msg = dialog_ctl["messages"][-1] if dialog_ctl["messages"] else ""
        check("33 中断では習得度が変わらない（確認文言も仕様どおり）", progress_raw(page) == snap and "採点されず" in msg and "習得度にも反映されません" in msg, msg.replace("\n", " "))
        # 演習中のモード切替（キャンセル）
        start(page)
        dialog_ctl["mode"] = "dismiss"
        page.click('.mode-switch a[data-mode-link="mock"]')
        page.wait_for_timeout(300)
        dialog_ctl["mode"] = "accept"
        check("演習中のモード切替は確認（キャンセルで留まる）", page.url.endswith("practice.html") and page.evaluate("window.RinPractice.sessionPhase") == "answering")
        page.click("#quit-btn")
        page.wait_for_selector("#screen-setup:not([hidden])")

        # ================= 24〜30 セッション種別・問題数 =================
        page.evaluate(f"localStorage.removeItem('{PROGRESS_KEY}')")
        open_practice(page)
        for key, kw, n in (("24 4択のみセッション", dict(types=("4択",), count="5"), 5),
                           ("25 記述のみセッション", dict(types=("記述",), count="5"), 5),
                           ("26 論述のみセッション", dict(types=("論述",), count="3"), 3),
                           ("27 4択＋記述＋論述混合セッション", dict(mocks=[7], types=("4択", "記述", "論述"), count="all", order="sequential"), 30),
                           ("28 1問セッション", dict(count="1"), 1),
                           ("29 3問セッション", dict(count="3"), 3),
                           ("30 30問セッション", dict(count="30"), 30)):
            configure(page, **kw)
            start(page)
            mid_raw = progress_raw(page)
            asked = run_session(page, lambda i, q: i % 3 != 2)
            kinds = {q["type"] for _, q in asked}
            ok = page.locator(".result-item").count() == n and len(asked) == n
            if key.startswith("24"): ok = ok and kinds == {"4択"}
            if key.startswith("25"): ok = ok and kinds == {"記述"}
            if key.startswith("26"): ok = ok and kinds == {"論述"}
            if key.startswith("27"): ok = ok and kinds == {"4択", "記述", "論述"}
            expected_correct = sum(1 for i in range(n) if i % 3 != 2)
            ok = ok and page.locator(".result-item.is-correct").count() == expected_correct
            check(key, ok, f"{len(asked)}問 正解{page.locator('.result-item.is-correct').count()}")
            back_to_setup(page)
        configure(page, mocks=[7], types=("論述",), count="10")
        n, txt = target_count(page)
        check("指定数より少ない対象でもエラーにしない", not page.locator("#start-btn").is_disabled() and "出題：2問" in txt.replace(" ", ""), txt)

        # ================= 35〜37 画面幅 =================
        for w, label in ((320, "35 320px"), (390, "36 390px"), (1280, "37 PC 1280px")):
            page.set_viewport_size({"width": w, "height": 900})
            open_practice(page)
            ok_setup = no_hscroll(page)
            configure(page, mocks=[1], types=("4択", "記述", "論述"), count="all", order="sequential")
            start(page)
            ok_quiz = no_hscroll(page)
            # 画像4択（第1回第2問）
            fill_answer(page, True); page.click("#next-btn")
            ok_img = no_hscroll(page) and page.evaluate("getComputedStyle(document.querySelector('.image-choice-grid')).gridTemplateColumns.split(' ').length") == 2
            if w == 390:
                imgw = page.evaluate("document.querySelector('.image-choice-btn img').getBoundingClientRect().width")
                check("画像4択の画像が小さすぎない（390pxで140px以上）", imgw >= 140, f"{imgw:.0f}px")
                h = page.evaluate("Math.min(...[...document.querySelectorAll('#quiz-card .choice-btn, #next-btn, #prev-btn')].map(e=>e.getBoundingClientRect().height))")
                check("タッチターゲット44px以上（選択肢・前へ・次へ）", h >= 44, f"{h}")
            page.click("#quit-btn")
            page.wait_for_selector("#screen-setup:not([hidden])")
            configure(page, mocks=[2], types=("記述",), count="3", order="sequential")
            start(page)
            run_session(page)
            ok_res = no_hscroll(page)
            check(f"{label} 設定・出題・画像4択・結果で横スクロールなし", ok_setup and ok_quiz and ok_img and ok_res, f"{ok_setup},{ok_quiz},{ok_img},{ok_res}")
            if shots and w in (390, 1280):
                page.screenshot(path=f"{shots}/result-{w}.png", full_page=True)
            back_to_setup(page)
        page.set_viewport_size({"width": 390, "height": 844})

        # 史料・roman_items・画像資料
        def find(pred):
            for m, qs in DATA.items():
                for n_, q in sorted(qs.items()):
                    if pred(q):
                        return m, n_, q
        for key, (m, n_, q), sel in (("史料問題", find(lambda q: q["type"] == "4択" and q.get("source")), ".source-box"),
                                     ("roman_items問題", find(lambda q: q["type"] == "4択" and q.get("roman_items")), ".roman-items .roman-item"),
                                     ("画像資料問題", find(lambda q: q["type"] == "記述" and q.get("images")), ".question-images img")):
            open_practice(page)
            configure(page, mocks=[m], types=(q["type"],), count="all", order="sequential")
            start(page)
            for _ in range(40):
                if current_q(page) == (m, n_):
                    break
                fill_answer(page, True); page.click("#next-btn")
            if sel.endswith("img"):
                try:
                    page.wait_for_function("document.querySelector('#quiz-card .question-images img')?.naturalWidth > 0", timeout=10000)
                except Exception:
                    pass
            ok = current_q(page) == (m, n_) and page.locator(f"#quiz-card {sel}").first.is_visible()
            check(f"{key}（第{m}回第{n_}問）を表示", ok)
            page.click("#quit-btn")
            page.wait_for_selector("#screen-setup:not([hidden])")

        # 進捗リセット
        open_practice(page)
        page.click("#reset-progress-btn")
        check("進捗リセット", f"未出題 {TOTAL}" in page.locator(".mastery-legend").inner_text().replace("\n", " ") or "未出題" in page.locator(".mastery-legend").inner_text() and page.evaluate(f"localStorage.getItem('{PROGRESS_KEY}')") is None)
        check("25b リロード後も設定画面が正常", page.locator("#start-btn").is_enabled())

        # localStorage 不可でも動く
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844})
        ctx2.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });")
        p2 = ctx2.new_page()
        errs2 = []
        p2.on("pageerror", lambda e: errs2.append(str(e)))
        p2.on("dialog", lambda d: d.accept())
        open_practice(p2)
        configure(p2, mocks=[1], types=("4択",), count="1", order="sequential")
        start(p2)
        run_session(p2)
        check("localStorage不可でも演習・採点可能＋警告表示", not errs2 and p2.locator(".result-item").count() == 1 and "保存できません" in p2.locator("#mastery-note").inner_text())
        ctx2.close()

        # JSON 1件取得失敗
        ctx3 = browser.new_context(viewport={"width": 390, "height": 844})
        p3 = ctx3.new_page()
        errs3 = []
        p3.on("pageerror", lambda e: errs3.append(str(e)))
        p3.route("**/data/mock003.json", lambda r: r.fulfill(status=404, body="nf"))
        open_practice(p3)
        n, _ = target_count(p3)
        check("JSON1件取得失敗でも他回は演習可能", not errs3 and n == TOTAL - len(DATA[3]) and p3.locator("#load-notice .notice").is_visible(), f"{n}")
        ctx3.close()

        # file:// フォールバック（維持確認）
        ctx4 = browser.new_context(viewport={"width": 390, "height": 844})
        p4 = ctx4.new_page()
        errs4 = []
        p4.on("pageerror", lambda e: errs4.append(str(e)))
        p4.goto("file://" + os.path.join(ROOT, "practice.html"))
        p4.wait_for_selector("#pick-json-btn")
        check("file:// では原因と対処を表示", "file://" in p4.locator("#load-notice").inner_text() and p4.locator("#start-btn").is_disabled())
        p4.set_input_files("#folder-input", sorted(glob.glob(os.path.join(ROOT, "data", "mock*.json"))))
        p4.wait_for_function("window.RinPractice.loadStats && window.RinPractice.loadStats.total > 0")
        st4 = p4.evaluate("window.RinPractice.loadStats")
        check("file:// でもJSON選択で870問読込・開始可能", st4["ok"] == 29 and st4["total"] == 870 and p4.locator("#start-btn").is_enabled() and not errs4)
        ctx4.close()

        browser.close()

    serious = [e for e in console_errors if "favicon" not in e and "googletagmanager" not in e and "fonts.g" not in e and "ERR_" not in e]
    check("コンソールに重大エラーなし", not serious, "; ".join(serious[:5]))
    failed = [r for r in results if not r[1]]
    print(f"\n=== {len(results) - len(failed)} / {len(results)} passed ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
