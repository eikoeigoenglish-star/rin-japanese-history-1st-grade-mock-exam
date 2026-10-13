# -*- coding: utf-8 -*-
"""
公開テーマ「豊臣家と京都」100問の JSON を生成し、機械的な監査を行う。

使い方（プロジェクトルートで）:
    python3 tools/build_theme_2026_toyotomi.py

出力:
    data/theme-2026-toyotomi.json
監査内容:
    - 問題数・カテゴリ配分・難易度配分
    - 4択であること / 正解が選択肢に含まれること / 選択肢の重複なし
    - 問題文の重複・類似（本セット内、既存 questions.json との間）
    - 正解だけ極端に長い選択肢の検出
    - 問題文に正解の文字列がそのまま含まれていないか
"""
import difflib
import hashlib
import json
import os
import random
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from theme_2026_toyotomi_source import QUESTIONS  # noqa: E402

THEME_ID = "theme-2026-toyotomi"
OUT = os.path.join(ROOT, "data", f"{THEME_ID}.json")
EXISTING = os.path.join(ROOT, "data", "questions.json")

EXPECTED_CATEGORIES = {
    "人物・家族・側近": 20,
    "都市改造・町割り": 20,
    "寺社・建築": 25,
    "史跡・城郭": 20,
    "文化・茶・行事": 10,
    "横断": 5,
}
EXPECTED_DIFFICULTY = {"標準": 70, "やや難": 20, "難": 10}


def stable_shuffle(items, seed_text):
    seed = int(hashlib.sha256(seed_text.encode("utf-8")).hexdigest(), 16)
    rng = random.Random(seed)
    result = list(items)
    rng.shuffle(result)
    return result


def build():
    questions = []
    for index, (category, difficulty, text, correct, wrongs, explanation, tags) in enumerate(QUESTIONS, start=1):
        qid = f"{THEME_ID}-{index:03d}"
        choices = stable_shuffle([correct, *wrongs], qid)
        questions.append({
            "id": qid,
            "questionNumber": index,
            "grade": 2,
            "type": "choice",
            "sourceType": "annual-theme",
            "theme": "豊臣家と京都",
            "year": 2026,
            "category": category,
            "difficulty": difficulty,
            "question": text,
            "choices": choices,
            "correct": correct,
            "explanation": explanation,
            "tags": tags,
        })

    return {
        "meta": {
            "id": THEME_ID,
            "title": "2026公開テーマ：豊臣家と京都",
            "theme": "豊臣家と京都",
            "description": "京都の町に大きな影響を及ぼした秀吉やその弟・秀長など、京都に残る豊臣家の足跡を、問題を通じて辿る。",
            "grade": 2,
            "year": 2026,
            "type": "limited-theme",
            "sourceType": "annual-theme",
            "active": True,
            "questionCount": len(questions),
            "note": "過去問ではない独自問題。頻出度（freq / answerRounds）の概念は持たない。試験終了後は active:false で論理削除する。",
        },
        "questions": questions,
    }


def audit(data):
    errors, warnings = [], []
    qs = data["questions"]

    if len(qs) != 100:
        errors.append(f"問題数が100ではありません: {len(qs)}")

    cat = Counter(q["category"] for q in qs)
    dif = Counter(q["difficulty"] for q in qs)
    if dict(cat) != EXPECTED_CATEGORIES:
        errors.append(f"カテゴリ配分が想定と異なります: {dict(cat)}")
    if dict(dif) != EXPECTED_DIFFICULTY:
        errors.append(f"難易度配分が想定と異なります: {dict(dif)}")

    ids = [q["id"] for q in qs]
    if len(set(ids)) != len(ids):
        errors.append("ID が重複しています")

    for q in qs:
        c = q["choices"]
        if len(c) != 4:
            errors.append(f"{q['id']}: 4択ではありません")
        if len(set(c)) != len(c):
            errors.append(f"{q['id']}: 選択肢が重複しています")
        if q["correct"] not in c:
            errors.append(f"{q['id']}: 正解が選択肢にありません")
        if not q["explanation"].strip():
            errors.append(f"{q['id']}: 解説がありません")
        if q["correct"] in q["question"]:
            errors.append(f"{q['id']}: 問題文に正解の文字列が含まれています")
        others = [len(x) for x in c if x != q["correct"]]
        if len(q["correct"]) > max(others) * 1.6 and len(q["correct"]) - max(others) >= 4:
            warnings.append(f"{q['id']}: 正解だけ長い可能性 ({q['correct']} / {c})")
        # 正解の位置は決定的シャッフル。分布は後で確認する。

    # 本セット内の問題文の類似
    for i in range(len(qs)):
        for j in range(i + 1, len(qs)):
            r = difflib.SequenceMatcher(None, qs[i]["question"], qs[j]["question"]).ratio()
            if r > 0.6:
                warnings.append(f"類似問題: {qs[i]['id']} と {qs[j]['id']} (ratio={r:.2f})")
            if qs[i]["correct"] == qs[j]["correct"]:
                warnings.append(f"同一正解: {qs[i]['id']} と {qs[j]['id']} → {qs[i]['correct']}")

    # 既存過去問との類似
    existing = json.load(open(EXISTING, encoding="utf-8"))
    for q in qs:
        for e in existing:
            r = difflib.SequenceMatcher(None, q["question"], e["question"]).ratio()
            if r > 0.55:
                warnings.append(f"既存過去問と類似: {q['id']} ~ {e['id']} (ratio={r:.2f}) {e['question']}")

    pos = Counter(q["choices"].index(q["correct"]) for q in qs)
    return errors, warnings, cat, dif, pos


def main():
    data = build()
    errors, warnings, cat, dif, pos = audit(data)

    print("カテゴリ:", dict(cat))
    print("難易度:", dict(dif))
    print("正解位置の分布（0始まり、表示時はさらにシャッフル）:", dict(sorted(pos.items())))
    for w in warnings:
        print("WARN", w)
    for e in errors:
        print("ERROR", e)
    if errors:
        sys.exit(1)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("書き出し:", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
