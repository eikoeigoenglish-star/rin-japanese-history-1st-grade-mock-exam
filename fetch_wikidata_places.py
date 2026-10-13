#!/usr/bin/env python3
"""
Wikidata から京都周辺の実在地点（座標付き）を取得して gazetteer.json に保存する。

使い方:
    python3 fetch_wikidata_places.py

出力:
    gazetteer.json   [{qid, label, aliases[], lat, lng, kinds[]}, ...]

Wikidata のデータは CC0（著作権表示不要）。ネット接続が必要。
"""

import json
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://query.wikidata.org/sparql"
UA = "KyotoKenteiMap/1.0 (study tool; contact: github.com/eikoeigoenglish-star/kyoto-kentei)"

# 京都府をおおむね覆う矩形。府外に少しはみ出すが、
# 過去問に出てくる大坂城・平城京・石山寺などを拾えるので都合がよい。
SW_LON, SW_LAT = 134.80, 34.60
NE_LON, NE_LAT = 136.20, 35.85

# 取得対象の種別。P31/P279* で子クラスまで辿る。
KINDS = {
    "Q44539": "寺院",
    "Q845945": "神社",
    "Q23413": "城",
    "Q33506": "博物館・美術館",
    "Q22698": "公園",
    "Q8502": "山",
    "Q4022": "川",
    "Q12280": "橋",
    "Q1107656": "庭園",
    "Q16560": "宮殿・御所",
    "Q839954": "遺跡",
    "Q3947": "邸宅・建物",
    "Q473972": "保護地区",
    "Q57821": "要塞・城郭",
    "Q34442": "道・街道",
    "Q39614": "墓・陵",
}

QUERY = """
SELECT ?item ?itemLabel ?lat ?lng
       (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
WHERE {{
  SERVICE wikibase:box {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point({sw_lon} {sw_lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point({ne_lon} {ne_lat})"^^geo:wktLiteral .
  }}
  ?item wdt:P31/wdt:P279* wd:{qid} .
  ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "ja")
  OPTIONAL {{ ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "ja") }}
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lng)
}}
GROUP BY ?item ?itemLabel ?lat ?lng
"""


def run_query(qid):
    sparql = QUERY.format(
        qid=qid, sw_lon=SW_LON, sw_lat=SW_LAT, ne_lon=NE_LON, ne_lat=NE_LAT
    )
    url = ENDPOINT + "?" + urllib.parse.urlencode({"query": sparql, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})

    with urllib.request.urlopen(req, timeout=180) as res:
        return json.load(res)["results"]["bindings"]


def main():
    places = {}

    for qid, kind in KINDS.items():
        print(f"取得中: {kind} ({qid}) ... ", end="", flush=True)

        try:
            rows = run_query(qid)
        except Exception as error:
            print(f"失敗 {error}")
            print("  → 時間をおいて再実行するか、この種別だけ KINDS から外してください。")
            continue

        added = 0
        for row in rows:
            item_qid = row["item"]["value"].rsplit("/", 1)[-1]
            label = row["itemLabel"]["value"]

            # ラベルが Q123 のままのものは日本語名がないので捨てる
            if label.startswith("Q") and label[1:].isdigit():
                continue

            entry = places.setdefault(item_qid, {
                "qid": item_qid,
                "label": label,
                "aliases": [],
                "lat": round(float(row["lat"]["value"]), 6),
                "lng": round(float(row["lng"]["value"]), 6),
                "kinds": [],
            })

            if kind not in entry["kinds"]:
                entry["kinds"].append(kind)

            raw_aliases = row.get("aliases", {}).get("value", "")
            for alias in raw_aliases.split("|"):
                alias = alias.strip()
                if alias and alias != label and alias not in entry["aliases"]:
                    entry["aliases"].append(alias)

            added += 1

        print(f"{added}件")
        time.sleep(2)  # クエリサービスへの負荷を抑える

    result = sorted(places.values(), key=lambda p: p["label"])

    with open("gazetteer.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    print(f"\ngazetteer.json に {len(result)}地点を保存しました。")


if __name__ == "__main__":
    main()
