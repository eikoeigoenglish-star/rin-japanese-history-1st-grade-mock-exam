#!/usr/bin/env python3
"""
gazetteer.json（Wikidata の地点）と data/questions.json（過去問1100問）を突き合わせて、
地図用の data/places.json を作る。

使い方:
    python3 build_places.py

出力:
    data/places.json  [{name, lat, lng, qid, kinds, count, questions[]}, ...]
    unmatched.txt     どの地点にも結びつかなかった地名候補（人力で見る用）
"""

import json
import os
import re
import unicodedata
from collections import defaultdict

GAZETTEER = "gazetteer.json"
QUESTIONS = "data/questions.json"
OUT = "data/places.json"
STOPLIST = "stoplist.txt"

# 2文字の名前は、この字で終わるものだけ地点として認める。
# 「東寺」「金閣」は残し、「京都」「日本」「桃山」などは落とす。
SHORT_OK_TAIL = "寺社宮城山川池橋堂院庵閣殿門苑塚陵"

# Wikidata に載っていても地図に置くと邪魔になるもの
DEFAULT_STOP = {
    "京都", "京都府", "京都市", "日本", "山城国", "丹波国", "丹後国",
    "平安京", "近畿地方", "本州", "京都盆地",
}


def normalize(text):
    return unicodedata.normalize("NFKC", text)


def load_stoplist():
    stop = set(DEFAULT_STOP)

    if os.path.exists(STOPLIST):
        with open(STOPLIST, encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    stop.add(line)

    return stop


def acceptable(name, stop):
    if name in stop or len(name) < 2:
        return False

    if len(name) == 2 and name[-1] not in SHORT_OK_TAIL:
        return False

    # 数字だけ・英字だけのラベルは除く
    return bool(re.search(r"[一-龥ぁ-んァ-ヴ]", name))


def main():
    gazetteer = json.load(open(GAZETTEER, encoding="utf-8"))
    questions = json.load(open(QUESTIONS, encoding="utf-8"))
    stop = load_stoplist()

    # 表記 → 地点。別名も同じ地点に向ける。
    surface = {}
    for place in gazetteer:
        for name in [place["label"]] + place["aliases"]:
            name = normalize(name)
            if acceptable(name, stop):
                # 同じ表記が複数地点にぶつかったら、先に来たほうを優先
                surface.setdefault(name, place)

    # 長い名前から順に照合し、当たった範囲は伏せる。
    # これで「清水寺」が当たったあとに「清水」が二重で当たらない。
    names = sorted(surface, key=len, reverse=True)
    hits = defaultdict(set)

    for question in questions:
        text = normalize(question["question"] + "　" + question["correct"])
        masked = list(text)

        for name in names:
            start = 0
            while True:
                index = text.find(name, start)
                if index == -1:
                    break

                span = masked[index:index + len(name)]
                if all(character is not None for character in span):
                    masked[index:index + len(name)] = [None] * len(name)
                    hits[surface[name]["qid"]].add(question["id"])

                start = index + 1

    places = []
    for place in gazetteer:
        ids = hits.get(place["qid"])
        if not ids:
            continue

        places.append({
            "name": place["label"],
            "lat": place["lat"],
            "lng": place["lng"],
            "qid": place["qid"],
            "kinds": place["kinds"],
            "count": len(ids),
            "questions": sorted(ids),
        })

    places.sort(key=lambda p: (-p["count"], p["name"]))

    os.makedirs("data", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(places, f, ensure_ascii=False, indent=1)

    covered = len({qid for ids in hits.values() for qid in ids})
    tiers = {
        "5回以上": sum(1 for p in places if p["count"] >= 5),
        "3〜4回": sum(1 for p in places if 3 <= p["count"] < 5),
        "2回": sum(1 for p in places if p["count"] == 2),
        "1回のみ": sum(1 for p in places if p["count"] == 1),
    }

    print(f"{OUT} に {len(places)}地点を保存しました。")
    print(f"1100問中 {covered}問が、いずれかの地点に紐づきました。")
    for label, n in tiers.items():
        print(f"  {label}: {n}地点")


if __name__ == "__main__":
    main()
