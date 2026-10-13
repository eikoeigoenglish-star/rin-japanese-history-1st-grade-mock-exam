#!/usr/bin/env python3
"""
過去問に出てくる地名候補を日本語版Wikipediaに問い合わせ、
座標を持つものだけを地点として gazetteer.json に保存する。

途中で止まっても、もう一度同じコマンドを打てば続きから再開する。

使い方:
    python3 fetch_places.py          # 実行／再開
    python3 fetch_places.py --reset  # 最初からやり直す

出力:
    gazetteer.json     地点データ（build_places.py が読む）
    rejected.txt       地点でなかった候補（確認用）
    fetch_state.json   再開用の途中経過。完了後は消してよい
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://ja.wikipedia.org/w/api.php"
UA = "KyotoKenteiMap/1.0 (study tool; github.com/eikoeigoenglish-star/kyoto-kentei)"

QUESTIONS = "data/questions.json"
STATE = "fetch_state.json"

BATCH = 50           # 1リクエストあたりのページ数（API上限）
PAUSE = 3.0          # 通常時の間隔（秒）
BACKOFF = [30, 60, 120, 300, 600]   # 429を食らったときの待機（秒）

BOX = {"lat": (34.60, 35.85), "lng": (134.80, 136.20)}

KANJI = r"[一-龥々ヶヵ]"
SUFFIXES = [
    "寺", "神社", "大社", "神宮", "天満宮", "八幡宮", "宮", "院", "庵", "坊", "堂", "塔",
    "城", "館", "山荘", "山", "川", "池", "沼", "橋", "通", "小路", "大路", "坂", "峠",
    "谷", "島", "岳", "塚", "陵", "古墳", "窯", "御所", "離宮", "公園", "庭園", "邸",
    "亭", "屋敷", "門", "閣", "殿", "跡", "苑", "街道", "街", "町", "寮", "社",
]
SUFFIX_RE = re.compile("|".join(sorted(SUFFIXES, key=len, reverse=True)))


def collect_candidates():
    questions = json.load(open(QUESTIONS, encoding="utf-8"))
    candidates = set()

    for question in questions:
        for text in (question["question"], question["correct"]):
            for match in SUFFIX_RE.finditer(text):
                end, start = match.end(), match.start()
                head = start

                while head > 0 and start - head < 6 and re.match(KANJI, text[head - 1]):
                    head -= 1

                for cut in range(head, start + 1):
                    name = text[cut:end]
                    if len(name) >= 2:
                        candidates.add(name)

    return sorted(candidates)


def load_state():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            saved = json.load(f)
            return set(saved.get("done", [])), saved.get("places", {}), saved.get("rejected", [])

    return set(), {}, []


def save_state(done, places, rejected):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump({"done": sorted(done), "places": places, "rejected": rejected},
                  f, ensure_ascii=False)

    result = sorted(places.values(), key=lambda place: place["label"])
    with open("gazetteer.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    with open("rejected.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(set(rejected))))


def api_get(titles):
    """成功したら辞書、レート制限で粘っても駄目なら None を返す。"""
    params = {
        "action": "query", "format": "json", "formatversion": "2",
        "redirects": "1", "prop": "coordinates|pageprops",
        "ppprop": "wikibase_item", "coprimary": "primary",
        "titles": "|".join(titles),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": UA})

    for attempt, wait in enumerate(BACKOFF, start=1):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)

        except urllib.error.HTTPError as error:
            if error.code == 429:
                retry_after = error.headers.get("Retry-After")
                pause = int(retry_after) if (retry_after or "").isdigit() else wait
                print(f"\n  混雑中。{pause}秒待ちます（{attempt}/{len(BACKOFF)}）", flush=True)
                time.sleep(pause)
            else:
                print(f"\n  HTTPエラー {error.code}。{wait}秒待ちます", flush=True)
                time.sleep(wait)

        except Exception as error:
            print(f"\n  通信エラー: {error}。{wait}秒待ちます", flush=True)
            time.sleep(wait)

    return None


def in_box(lat, lng):
    return BOX["lat"][0] <= lat <= BOX["lat"][1] and BOX["lng"][0] <= lng <= BOX["lng"][1]


def guess_kind(name):
    for suffix, kind in [("神社", "神社"), ("大社", "神社"), ("神宮", "神社"),
                         ("天満宮", "神社"), ("八幡宮", "神社"), ("宮", "神社"),
                         ("寺", "寺院"), ("院", "寺院"), ("庵", "寺院"), ("堂", "寺院"),
                         ("城", "城"), ("館", "施設"), ("公園", "公園"), ("庭園", "庭園"),
                         ("御所", "御所"), ("離宮", "御所"), ("山", "山"), ("川", "川"),
                         ("橋", "橋"), ("通", "通り"), ("坂", "坂"), ("跡", "史跡")]:
        if name.endswith(suffix):
            return kind

    return "その他"


def handle(batch, data, places, rejected):
    query = data.get("query", {})

    alias_of = {}
    for redirect in query.get("redirects", []):
        alias_of.setdefault(redirect["to"], []).append(redirect["from"])
    for normalized in query.get("normalized", []):
        alias_of.setdefault(normalized["to"], []).append(normalized["from"])

    found = set()

    for page in query.get("pages", []):
        title = page.get("title", "")
        coords = page.get("coordinates")

        if not coords:
            continue

        lat, lng = coords[0]["lat"], coords[0]["lon"]

        if not in_box(lat, lng):
            rejected.append(f"{title}\t圏外 ({lat:.4f}, {lng:.4f})")
            continue

        key = str(page.get("pageid"))
        entry = places.setdefault(key, {
            "qid": page.get("pageprops", {}).get("wikibase_item", ""),
            "label": title,
            "aliases": [],
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "kinds": [guess_kind(title)],
        })

        for alias in alias_of.get(title, []):
            if alias != title and alias not in entry["aliases"]:
                entry["aliases"].append(alias)

        found.add(title)
        found.update(alias_of.get(title, []))

    for name in batch:
        if name not in found:
            rejected.append(f"{name}\t座標なし")


def main():
    if "--reset" in sys.argv:
        for path in (STATE, "gazetteer.json", "rejected.txt"):
            if os.path.exists(path):
                os.remove(path)
        print("途中経過を消しました。最初から取得します。\n")

    candidates = collect_candidates()
    done, places, rejected = load_state()
    remaining = [name for name in candidates if name not in done]

    if done:
        print(f"前回の続きから再開します（済 {len(done)}語 / 全 {len(candidates)}語、既に {len(places)}地点）\n")
    else:
        print(f"候補 {len(candidates)}語を照会します\n")

    if not remaining:
        print("すべて照会済みです。")
        save_state(done, places, rejected)
        print(f"gazetteer.json に {len(places)}地点。続けて python3 build_places.py を実行してください。")
        return

    total_batches = -(-len(remaining) // BATCH)
    stopped = False

    for number, index in enumerate(range(0, len(remaining), BATCH), start=1):
        batch = remaining[index:index + BATCH]
        print(f"  {number:>3}/{total_batches}  （{len(places)}地点）", end="\r", flush=True)

        data = api_get(batch)

        if data is None:
            print("\n\n制限が解けませんでした。ここまでを保存します。")
            stopped = True
            break

        handle(batch, data, places, rejected)
        done.update(batch)
        save_state(done, places, rejected)   # 1バッチごとに保存
        time.sleep(PAUSE)

    save_state(done, places, rejected)

    print(f"\n\ngazetteer.json に {len(places)}地点を保存しました（照会済 {len(done)}/{len(candidates)}語）")

    if stopped:
        print("\nしばらく待ってから、もう一度 python3 fetch_places.py を実行すると続きから再開します。")
    else:
        print("完了しました。続けて python3 build_places.py を実行してください。")
        print("（fetch_state.json は消して構いません）")


if __name__ == "__main__":
    main()