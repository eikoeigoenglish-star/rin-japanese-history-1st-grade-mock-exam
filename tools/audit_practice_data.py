#!/usr/bin/env python3
"""
演習用メタデータの機械監査（開発用）。

  python3 tools/audit_practice_data.py                 # 監査のみ
  python3 tools/audit_practice_data.py --orig DIR      # 改修前JSONと比較し、既存フィールド不変も検査

1件でも ERROR があれば終了コード 1。
"""
import argparse
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
PRACTICE_KEYS = {"accepted_answers", "cloze"}


def check_answer_list(label, values, must_include, errors):
    if not isinstance(values, list):
        errors.append(f"{label}: accepted_answers が配列ではありません")
        return
    if len(values) == 0:
        errors.append(f"{label}: accepted_answers が空です")
    for v in values:
        if not isinstance(v, str) or v.strip() == "":
            errors.append(f"{label}: accepted_answers に空文字または非文字列があります")
        elif v != v.strip():
            errors.append(f"{label}: accepted_answers「{v}」に前後空白があります")
    if len(set(values)) != len(values):
        errors.append(f"{label}: accepted_answers に重複があります")
    if must_include not in values:
        errors.append(f"{label}: answer「{must_include}」が accepted_answers に含まれていません")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orig", help="改修前の data ディレクトリ")
    args = ap.parse_args()

    errors, warnings = [], []
    stats = {"files": 0, "4択": 0, "記述": 0, "論述": 0, "accepted": 0, "cloze": 0, "blanks": 0}
    ids = set()

    files = sorted(glob.glob(os.path.join(DATA_DIR, "mock*.json")))
    for path in files:
        stats["files"] += 1
        name = os.path.basename(path)
        mock_no = name[4:7]
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        orig = None
        if args.orig:
            with open(os.path.join(args.orig, name), encoding="utf-8") as fh:
                orig = json.load(fh)
            top_new = {k: v for k, v in data.items() if k != "questions"}
            top_old = {k: v for k, v in orig.items() if k != "questions"}
            if top_new != top_old:
                errors.append(f"{name}: トップレベルのフィールドが変更されています")
            if len(orig["questions"]) != len(data["questions"]):
                errors.append(f"{name}: 問題数が変わっています")

        for i, q in enumerate(data["questions"]):
            label = f"mock{mock_no}-q{int(q['number']):02d}"
            if label in ids:
                errors.append(f"{label}: 問題IDが重複しています")
            ids.add(label)
            t = q.get("type")
            stats[t] = stats.get(t, 0) + 1

            if orig is not None:
                o = orig["questions"][i]
                stripped = {k: v for k, v in q.items() if k not in PRACTICE_KEYS}
                if stripped != o or list(stripped.keys()) != list(o.keys()):
                    errors.append(f"{label}: 既存フィールドが変更されています")

            if t == "記述":
                if "accepted_answers" not in q:
                    errors.append(f"{label}: accepted_answers がありません")
                    continue
                stats["accepted"] += 1
                check_answer_list(label, q["accepted_answers"], q.get("answer"), errors)
            elif t == "論述":
                cz = q.get("cloze")
                if not isinstance(cz, dict):
                    errors.append(f"{label}: cloze がありません")
                    continue
                stats["cloze"] += 1
                text = cz.get("text")
                blanks = cz.get("blanks")
                if not isinstance(text, str) or not text:
                    errors.append(f"{label}: cloze.text がありません")
                    continue
                if not isinstance(blanks, list) or not (2 <= len(blanks) <= 4):
                    errors.append(f"{label}: blanks が2〜4個ではありません")
                    continue
                stats["blanks"] += len(blanks)
                bids = [b.get("id") for b in blanks]
                if len(set(bids)) != len(bids):
                    errors.append(f"{label}: blank id が重複しています")
                placeholders = re.findall(r"\{\{(\d+)\}\}", text)
                if sorted(int(p) for p in placeholders) != sorted(bids) or len(placeholders) != len(bids):
                    errors.append(f"{label}: cloze.text のプレースホルダと blanks が対応していません")
                restored = text
                for b in blanks:
                    bl = f"{label} blank{b.get('id')}"
                    ans = b.get("answer")
                    if not isinstance(ans, str) or not ans.strip():
                        errors.append(f"{bl}: answer がありません")
                        continue
                    if "accepted_answers" not in b:
                        errors.append(f"{bl}: accepted_answers がありません")
                    else:
                        check_answer_list(bl, b["accepted_answers"], ans, errors)
                    if ans in text:
                        errors.append(f"{bl}: 答え「{ans}」が cloze 本文に露出しています")
                    for acc in b.get("accepted_answers", []):
                        if acc in text:
                            errors.append(f"{bl}: 許容解「{acc}」が cloze 本文に露出しています")
                    if ans in (q.get("text") or ""):
                        warnings.append(f"{bl}: 答え「{ans}」が設問文に含まれています")
                    restored = restored.replace("{{%s}}" % b.get("id"), ans, 1)
                if restored != q.get("model_answer"):
                    errors.append(f"{label}: 埋め戻し結果が model_answer と一致しません")
            elif t == "4択":
                if q.get("answer") not in ["①", "②", "③", "④"]:
                    errors.append(f"{label}: 4択の answer が①〜④ではありません")
                if not q.get("choices") and len(q.get("images") or []) < 2:
                    errors.append(f"{label}: 4択に choices も画像選択肢もありません")
            for img in q.get("images") or []:
                if not os.path.exists(os.path.join(ROOT, img.get("src", ""))):
                    warnings.append(f"{label}: 画像ファイルがありません {img.get('src')}")

    print("=== 演習用JSON監査 ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    for w in warnings:
        print("WARN ", w)
    for e in errors:
        print("ERROR", e)
    ok = not errors and stats["accepted"] == stats["記述"] and stats["cloze"] == stats["論述"]
    print("RESULT:", "PASS" if ok else "FAIL", f"(errors={len(errors)}, warnings={len(warnings)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
