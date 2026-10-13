# 公開テーマ（期間限定問題セット）の運用

過去問（`data/questions.json`・1100問）とは完全に別管理の、年度ごとの公開テーマ対策問題です。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `data/themes.json` | テーマ一覧（manifest）。`active` で表示・非表示を切り替える |
| `data/theme-2026-toyotomi.json` | 2026「豊臣家と京都」100問（解説付き） |
| `theme.js` | 学習モード切替・テーマ画面の描画・テーマ専用進捗 |
| `tools/theme_2026_toyotomi_source.py` | 100問の原稿（編集はここで行う） |
| `tools/build_theme_2026_toyotomi.py` | 原稿から JSON を生成し、機械監査を行う |

## 画面構成（学習モード）

スタート画面上部のタブで「過去問トレーニング」と「2026公開テーマ対策」を切り替えます。選択中でないモードの設定UI・進捗UIは完全に非表示になります。出題・回答・採点・解説の画面は両モードで共通です（`app.js` の実装をそのまま使用）。

- 過去問モード: `index.html`（パラメータなし）
- 公開テーマモード: `index.html?mode=theme-2026-toyotomi`（このURLで直接開けます）
- 旧リンク `index.html#theme-area` も公開テーマモードで開き、URLを `?mode=` 形式に直します
- 存在しない・`active:false` のテーマが指定された場合は過去問モードで開き、URLからパラメータを外します

## 進捗の分離

- 過去問: `kk2-progress-v1`（従来のまま・変更なし）
- 2026テーマ: `kk2-theme-2026-toyotomi-progress-v1`

テーマ問題の結果は過去問の進捗に加算されません。リセットもそれぞれ独立しています。

## 試験終了後（論理削除）

`data/themes.json` の該当テーマを `"active": false` にするだけです。

- モード切替タブ自体が表示されなくなり、テーマ画面・テーマ進捗カードも出なくなります（過去問だけの従来画面になります）
- 問題JSONと利用者の LocalStorage の進捗は削除されません
- 必要なら `data/theme-2026-toyotomi.json` の `meta.active` も `false` にできます（どちらかが false なら非表示）

## 2027年度以降のテーマ追加

1. `data/theme-2027-xxxx.json` を同じ構造（`meta` + `questions`）で作る
2. `data/themes.json` に1件追加する（`id` / `label` / `title` / `file` / `progressKey` / `active`）
3. `progressKey` は `kk2-theme-<id>-progress-v1` の形式で、他と重複させない

コードの変更は不要です。

## 問題を直すとき

```
python3 tools/build_theme_2026_toyotomi.py
```

問題数・カテゴリ配分（人物20／都市改造20／寺社25／史跡20／文化10／横断5）・難易度配分（標準70／やや難20／難10）・4択・正解の存在・選択肢の重複・問題文への正解の混入・既存過去問との類似を検査し、問題がなければ JSON を書き出します。選択肢の並びは問題IDをシードにした決定的シャッフルです（出題時にもさらにシャッフルされます）。
