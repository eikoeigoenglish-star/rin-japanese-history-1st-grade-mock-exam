#!/usr/bin/env python3
"""受け入れ確認用スクリーンショット（開発用）。 python3 tools/screenshots.py OUTDIR"""
import sys, re
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
BASE = "http://localhost:8765"

def setup(pg, settings):
    pg.goto(f"{BASE}/practice.html")
    pg.evaluate("s => { localStorage.clear(); localStorage.setItem('rin-japanese-history-practice-settings-v1', JSON.stringify(s)); }", settings)
    pg.reload()
    pg.wait_for_function("window.RinPractice && window.RinPractice.loadStats")

ALL = ["new", "miss", "hit", "double", "triple"]
with sync_playwright() as p:
    b = p.chromium.launch()
    for w in (1280, 390):
        pg = b.new_page(viewport={"width": w, "height": 900}, device_scale_factor=2)
        pg.goto(f"{BASE}/practice.html"); pg.evaluate("localStorage.clear()"); pg.reload()
        pg.wait_for_function("window.RinPractice && window.RinPractice.loadStats")
        assert pg.locator("#load-notice").is_hidden()
        pg.screenshot(path=f"{OUT}/01-setup-{w}.png", full_page=True)
        pg.close()
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg.on("dialog", lambda d: d.accept())
    mocks = [f"{i:03d}" for i in range(1, 28)]
    # 4択
    setup(pg, {"mocks": ["003"], "types": ["4択"], "stages": ALL, "count": "5", "order": "sequential"})
    pg.click("#start-btn"); pg.wait_for_selector(".choice-btn"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"{OUT}/02-choice-390.png", full_page=True)
    pg.click('.choice-btn[data-label="②"]'); pg.wait_for_timeout(700); pg.evaluate("scrollTo(0,0)")
    pg.screenshot(path=f"{OUT}/03-choice-answered-390.png", full_page=True)
    # 記述
    setup(pg, {"mocks": ["026"], "types": ["記述"], "stages": ALL, "count": "3", "order": "sequential"})
    pg.click("#start-btn"); pg.wait_for_selector("#text-answer"); pg.wait_for_timeout(600)
    pg.fill("#text-answer", "防人")
    pg.screenshot(path=f"{OUT}/04-text-390.png", full_page=True)
    pg.click("[data-submit]"); pg.wait_for_timeout(700); pg.evaluate("scrollTo(0,0)")
    pg.screenshot(path=f"{OUT}/05-text-answered-390.png", full_page=True)
    pg.click("#next-btn"); pg.fill("#text-answer", "滝口"); pg.click("[data-submit]")
    pg.click("#next-btn"); pg.fill("#text-answer", "職原鈔"); pg.click("[data-submit]")
    pg.click("#next-btn"); pg.wait_for_selector("#screen-result:not([hidden])"); pg.wait_for_timeout(700)
    pg.screenshot(path=f"{OUT}/08-result-390.png", full_page=True)
    # 論述
    setup(pg, {"mocks": ["025"], "types": ["論述"], "stages": ALL, "count": "all", "order": "sequential"})
    pg.click("#start-btn"); pg.wait_for_selector("[data-blank-id]"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"{OUT}/06-cloze-390.png", full_page=True)
    pg.fill('[data-blank-id="1"]', "細川・山名"); pg.fill('[data-blank-id="2"]', "守護・大名")
    pg.click("[data-submit]"); pg.wait_for_timeout(700); pg.evaluate("scrollTo(0,0)")
    pg.screenshot(path=f"{OUT}/07-cloze-answered-390.png", full_page=True)
    b.close()
print("ok")
