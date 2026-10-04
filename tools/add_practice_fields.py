#!/usr/bin/env python3
"""
演習モード用メタデータ（accepted_answers / cloze）を data/mockXXX.json に付与する開発用スクリプト。

- 実行は開発時のみ。サイトの動作に Python は不要（GitHub Pages では JSON をそのまま読む）。
- 既存フィールド（text / answer / model_answer / choices / explanation など）は一切変更しない。
- 何度実行しても同じ結果になる（冪等）。

accepted_answers:
  answer を必ず先頭に含め、accepted_variants の中で「可」「認める」「正答扱い」等と
  明示されている表記だけを EXTRA_ACCEPTED に人手で登録している。
  accepted_variants の文章を機械的に解析することはしない。

cloze:
  model_answer から 2〜4 個の語句を空欄にする。CLOZE_SPECS には空欄にする語句を
  model_answer 内の出現順に並べる。空欄化は「前の空欄の後ろで最初に現れる位置」で行い、
  埋め戻すと model_answer と完全一致することを、このスクリプトと監査スクリプトの両方で検証する。

使い方:
  python3 tools/add_practice_fields.py
  python3 tools/audit_practice_data.py
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

# ------------------------------------------------------------------
# 記述：answer 以外に正答として明示的に許容される表記
# キーは安定ID（mockXXX-qNN）。ここにない問題は [answer] のみ。
# ------------------------------------------------------------------
EXTRA_ACCEPTED = {
    "mock001-q13": ["天竜寺船"],                     # 「天竜寺船」も可
    "mock007-q06": ["倭名類聚抄"],                   # 同じ書物を指す表記（漢字5字）
    "mock008-q20": ["俵物三品"],                     # 「俵物三品」も可
    "mock008-q28": ["齋藤隆夫"],                     # 「齋藤隆夫」も可
    "mock008-q29": ["ガダルカナル島"],               # 「ガダルカナル島」も可
    "mock010-q06": ["今内裏"],                       # 「今内裏」も可とする
    "mock011-q15": ["神谷寿禎"],                     # 正答扱いとする
    "mock011-q27": ["挙国一致内閣"],                 # 可とする
    "mock011-q29": ["ケネス・ロイヤル", "ケネス・C・ロイヤル", "Kenneth C. Royall"],  # 正答とする
    "mock012-q15": ["寧波争貢事件"],                 # 可とする
    "mock012-q20": ["七分金積立"],                   # 可とする
    "mock012-q27": ["石井＝ランシング協定"],         # 可
    "mock012-q30": ["マルタ"],                       # 正答扱いとする
    "mock013-q04": ["唐大和上東征傳", "東征伝"],     # 認める
    "mock013-q10": ["愚管鈔"],                       # 可
    "mock013-q30": ["コロンボ・プラン", "コロンボプラン"],  # 認める
    "mock014-q24": ["ノルマントン事件"],             # 認める
    "mock015-q05": ["醫心方"],
    "mock015-q10": ["稱名寺"],
    "mock015-q11": ["砂石集"],
    "mock015-q16": ["金地院崇傳"],
    "mock015-q22": ["大藏永常"],
    "mock015-q24": ["福澤諭吉"],
    "mock015-q27": ["柳宗悅"],
    "mock016-q06": ["勸學院"],
    "mock016-q12": ["看聞御記"],
    "mock016-q18": ["田中勝助"],
    "mock017-q13": ["正中の變"],
    "mock017-q25": ["與謝野晶子"],
    "mock018-q20": ["石田梅巌", "石田梅巖"],
    "mock020-q13": ["反銭"],
    "mock021-q20": ["三方領地替"],
    "mock021-q29": ["L・T貿易"],
    "mock022-q14": ["差出検地"],
    "mock022-q24": ["甲申政変"],
    "mock022-q27": ["塘沽協定"],
    "mock023-q10": ["今川貞世"],
    "mock023-q20": ["均田法"],
    "mock023-q28": ["陸海軍大臣現役武官制"],
    "mock024-q03": ["蔭位の制"],
    "mock025-q12": ["兵庫北関入舩納帳"],
    "mock026-q06": ["滝口の武者"],
    "mock026-q12": ["職原鈔"],
}

# ------------------------------------------------------------------
# 論述：空欄にする語句（model_answer 内の出現順）
# ------------------------------------------------------------------
CLOZE_SPECS = {
    "mock001-q22": ["差益", "物価騰貴", "新井白石"],
    "mock001-q30": ["外国人判事", "日英通商航海条約", "領事裁判権", "関税自主権"],
    "mock002-q14": ["観応の擾乱", "兵粮米", "国人"],
    "mock002-q30": ["アジア市場", "債権国", "欧州製品"],
    "mock003-q23": ["運上・冥加", "松平定信", "農村再建"],
    "mock003-q30": ["金解禁", "生糸", "豊作飢饉"],
    "mock004-q16": ["妻子", "服属", "宿駅"],
    "mock004-q26": ["紙幣整理", "繭価", "小作"],
    "mock005-q12": ["蒙古襲来", "恩賞", "無償取戻し"],
    "mock005-q29": ["在村地主", "不在地主", "寄生地主制"],
    "mock006-q06": ["桓武天皇", "郡司子弟", "健児"],
    "mock006-q30": ["第四次中東戦争", "マイナス成長", "安定成長"],
    "mock007-q05": ["宋商人", "大宰府", "鴻臚館"],
    "mock007-q30": ["防衛義務", "事前協議", "岸内閣", "強行採決"],
    "mock008-q05": ["三世一身法", "墾田永年私財法", "初期荘園"],
    "mock008-q25": ["綿花", "入超", "繭", "米国"],
    "mock009-q02": ["水城", "百済人", "朝鮮式山城", "近江大津宮"],
    "mock009-q25": ["寺内内閣", "立憲政友会", "三円", "小選挙区制"],
    "mock010-q18": ["金銀", "清・オランダ", "海舶互市新例"],
    "mock010-q27": ["武断政治", "三・一独立運動", "文官", "文化政治"],
    "mock011-q06": ["道鏡", "平城京", "最澄", "天台宗"],
    "mock011-q30": ["平和条約", "復帰運動", "佐藤・ニクソン会談"],
    "mock012-q08": ["外戚", "院庁", "知行国", "院領荘園"],
    "mock012-q28": ["納税資格", "無産政党", "日ソ"],
    "mock013-q05": ["郡司子弟", "健児", "蝦夷"],
    "mock013-q21": ["堀勝名", "時習館", "櫨・楮", "専売"],
    "mock014-q13": ["足利義満", "三種の神器", "両統迭立", "称光天皇"],
    "mock014-q26": ["外交権", "統監府", "内政", "義兵闘争"],
    "mock015-q13": ["下総", "足利政知", "伊豆"],
    "mock015-q20": ["貨幣収入", "帳簿上", "差金決済"],
    "mock016-q08": ["重源", "寄進", "木材"],
    "mock016-q29": ["貿易・為替自由化", "国際収支", "経常取引"],
    "mock017-q12": ["二毛作", "余剰", "銭納"],
    "mock017-q24": ["旧公家・旧大名", "維新功臣", "貴族院"],
    "mock018-q11": ["承久の乱", "新補地頭", "六波羅探題", "朝廷監視"],
    "mock018-q30": ["出撃・補給", "北爆", "反基地運動"],
    "mock019-q17": ["由井正雪", "慶安の変", "改易", "末期養子の禁"],
    "mock019-q23": ["開拓使官有物払下げ事件", "大隈重信", "国会開設の勅諭", "プロイセン"],
    "mock020-q10": ["知行国", "大輪田泊", "日宋貿易", "宋銭"],
    "mock020-q30": ["プラザ合意", "公定歩合", "土地・株式", "バブル景気"],
    "mock021-q08": ["田堵", "負名", "官物"],
    "mock021-q27": ["金輸出", "赤字国債", "円安", "二・二六事件"],
    "mock022-q10": ["在京", "応仁の乱", "国人"],
    "mock022-q22": ["流通独占", "上方", "再興"],
    "mock023-q04": ["長屋王の変", "藤原四子", "天然痘", "橘諸兄"],
    "mock023-q27": ["ドッジ・ライン", "超均衡予算", "単一為替レート", "朝鮮戦争"],
    "mock024-q10": ["単独相続", "地縁的結合", "両朝"],
    "mock024-q17": ["京都・堺・長崎", "糸割符仲間", "ポルトガル"],
    "mock025-q10": ["細川・山名", "守護・国人"],
    "mock025-q30": ["左右社会党", "自民党", "安保改定"],
    "mock026-q10": ["六波羅探題", "御家人", "新補地頭"],
    "mock026-q30": ["持株会社整理委員会", "過度経済力集中排除法", "冷戦"],
    "mock027-q10": ["日本国王", "冊封", "勘合", "臣従"],
    "mock027-q30": ["技術導入", "設備投資", "石油", "耐久消費財"],
}


def qid(mock_no, number):
    return f"mock{mock_no}-q{int(number):02d}"


def insert_after(d, after_key, new_key, value):
    """dict のキー順を保ったまま after_key の直後に new_key を入れる（既存なら置換）。"""
    items = [(k, v) for k, v in d.items() if k != new_key]
    out = {}
    inserted = False
    for k, v in items:
        out[k] = v
        if k == after_key:
            out[new_key] = value
            inserted = True
    if not inserted:
        out[new_key] = value
    return out


def build_cloze(model_answer, terms, label):
    text_parts = []
    pos = 0
    blanks = []
    for i, term in enumerate(terms, start=1):
        idx = model_answer.find(term, pos)
        if idx < 0:
            raise ValueError(f"{label}: 「{term}」が model_answer の想定位置に見つかりません")
        text_parts.append(model_answer[pos:idx])
        text_parts.append("{{%d}}" % i)
        pos = idx + len(term)
        blanks.append({"id": i, "answer": term, "accepted_answers": [term]})
    text_parts.append(model_answer[pos:])
    text = "".join(text_parts)
    # 埋め戻し検証
    restored = text
    for b in blanks:
        restored = restored.replace("{{%d}}" % b["id"], b["answer"], 1)
    if restored != model_answer:
        raise ValueError(f"{label}: 埋め戻し結果が model_answer と一致しません")
    for b in blanks:
        if b["answer"] in text:
            raise ValueError(f"{label}: 空欄の答え「{b['answer']}」が cloze 本文に残っています")
    return {"text": text, "blanks": blanks}


def main():
    files = sorted(glob.glob(os.path.join(DATA_DIR, "mock*.json")))
    used_extra, used_cloze = set(), set()
    counts = {"記述": 0, "論述": 0, "accepted": 0, "cloze": 0}
    for path in files:
        mock_no = os.path.basename(path)[4:7]
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        new_questions = []
        for q in data["questions"]:
            key = qid(mock_no, q["number"])
            if q.get("type") == "記述":
                counts["記述"] += 1
                acc = [q["answer"]]
                for extra in EXTRA_ACCEPTED.get(key, []):
                    if extra not in acc:
                        acc.append(extra)
                if key in EXTRA_ACCEPTED:
                    used_extra.add(key)
                q = insert_after(q, "answer", "accepted_answers", acc)
                counts["accepted"] += 1
            elif q.get("type") == "論述":
                counts["論述"] += 1
                if key not in CLOZE_SPECS:
                    raise SystemExit(f"{key}: CLOZE_SPECS が未定義です")
                cloze = build_cloze(q["model_answer"], CLOZE_SPECS[key], key)
                used_cloze.add(key)
                q = insert_after(q, "model_answer", "cloze", cloze)
                counts["cloze"] += 1
            new_questions.append(q)
        data["questions"] = new_questions
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    unused = (set(EXTRA_ACCEPTED) - used_extra) | (set(CLOZE_SPECS) - used_cloze)
    if unused:
        raise SystemExit(f"未使用の定義があります（IDの誤り）: {sorted(unused)}")
    print(f"files={len(files)} 記述={counts['記述']} accepted_answers付与={counts['accepted']} "
          f"論述={counts['論述']} cloze付与={counts['cloze']}")


if __name__ == "__main__":
    sys.exit(main())
