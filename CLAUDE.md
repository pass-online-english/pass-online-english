# CLAUDE.md

## このリポジトリについて

Passオンライン英語（英検対策中心のオンライン英語レッスン）の静的サイト。
素の HTML / CSS のみで、ビルド処理はない。`package.json` はアクセス解析ツール専用であり、
公開される静的サイトの動作には関与しない。

```
index.html            トップページ（LP）
style.css
blog/toeic990.html    ブログ記事
scripts/analytics/    GA4 / Search Console 分析ツール（読み取り専用）
```

## アクセス解析を依頼されたとき

まず `npm run analytics:report -- --days 28` を実行し、
出力された `reports/report-*/report.md` を読んでから分析する。
`report.json` には全データが構造化されて入っているので、追加の集計が必要ならそちらを使う。

| 依頼内容 | 使うコマンド |
|---|---|
| 全体のアクセス分析・レポート | `npm run analytics:report -- --days 28` |
| 前期間比較 | `--compare previous`（既定） |
| 前年同期比較 | `--compare yoy` |
| GA4 だけ | `npm run analytics:ga4 -- --days 28` |
| Search Console だけ | `npm run analytics:gsc -- --days 28` |
| SEO 改善候補だけ | `npm run analytics:insights -- --days 28` |
| 地域の偏りを調べる | `npm run analytics:ga4 -- --days 28 --geo-cross` |
| 設定・疎通が怪しいとき | `npm run analytics:doctor` |
| 認証が切れた／未設定のとき | `npm run analytics:login`（ブラウザ認証・gcloud 不要） |
| GA4 の指標名エラー | `npm run analytics:schema` |

詳細は `docs/ANALYTICS.md`。

## 分析するときの原則

- **原因を断定しない。** API から確認できるのは数値だけ。
  「〜の可能性がある」「確認が必要」という書き方をする。
- **地域データは IP 推定。** Osaka / Yokohama / Shinjuku City などの偏りは、
  実際の利用者分布・キャリアの IP 出口・VPN・ボットのいずれでも生じうる。
  `--geo-cross` のクロス集計で切り分け材料を集めてから述べる。
- **Search Console のクリック数と GA4 のセッション数は一致しない。**
  計測方法が違うため正常。乖離が極端な場合のみ、計測上の問題を疑う。
- **Search Console のクエリ別合計はサイト全体値と一致しない。**
  検索数の少ないクエリが非開示になる仕様。
- **SEO 改善候補は「候補」。** 実際の検索結果とページ内容の確認が前提。

## やってはいけないこと

- GA4 / Search Console の**設定変更**（キーイベント設定、ユーザー権限、データ保持期間など）。
  このツールは読み取り専用スコープしか要求していない。設定が必要なら利用者に伝えるだけにする。
- 認証情報（`.env`、サービスアカウント鍵、トークン）を**リポジトリ内に置く / コミットする**。
- `reports/` の出力を**コミットする**（実データを含むため `.gitignore` 済み）。
- API に必要な ID（`GA4_PROPERTY_ID`、`SEARCH_CONSOLE_SITE_URL`）を**推測して設定する**。
  不明なら利用者に確認する。

## 既知の状態

- GA4 タグ（`G-MYKHP4K4QN`）は `blog/toeic990.html` にのみ設置。`index.html` には未設置。
- 問い合わせ導線は Google フォームと LINE への外部リンク。
  そのため**フォーム送信の完了は GA4 では計測できない**（計測できるのはボタンクリックまで）。

## コードを変更したとき

```bash
npm run analytics:selftest
```

期間計算・URL 正規化・SEO 候補抽出・GA4×GSC 突き合わせ・レポート生成を
合成データで検証する。API 接続は不要。
