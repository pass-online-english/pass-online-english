# CLAUDE.md

## このリポジトリについて

Passオンライン英語（英検対策中心のオンライン英語レッスン）のリポジトリ。
`https://pass-online-english.com` を **Cloudflare Pages** で公開している。
素の HTML / CSS のみで、ビルド処理はない。

```
site/                 本番にアップロードするファイル一式（サイトの実体）
scripts/analytics/    GA4 / Search Console 分析ツール（読み取り専用）
docs/DEPLOY.md        サイトの管理とデプロイ手順
docs/ANALYTICS.md     分析ツールの使い方
reports/              分析結果の出力先（.gitignore 済み）
```

`package.json` は分析ツール専用であり、公開されるサイトの動作には関与しない。

## サイトを編集するとき

- **編集対象は `site/` の中だけ。** ここが本番の実体
- **HTMLファイル名を変更しない。** Cloudflare Pages がファイル名から公開URLを生成しているため、
  リネームすると全URLが変わり検索評価がリセットされる
- **`canonical` は拡張子なしのURLにする。** `site/toeic990.html` の canonical は
  `https://pass-online-english.com/toeic990`。`.html` を付けると、リダイレクト元を
  正規URLとして宣言することになり、Google の評価が2つのURLに分散する
- 新しいページを追加したら **GA4タグ（`G-MYKHP4K4QN`）の記述を忘れない**
- デプロイは手動アップロード。**Git にコミットしてからアップロードする**

詳細は `docs/DEPLOY.md`。

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
| `.env` が未設定のとき | `npm run analytics:setup`（対話形式。利用者自身に実行してもらう） |
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
- **総数ではなく率で見る。** 2026年8月はXでのバズにより3日間で全体の73%の
  セッションが発生した。こうした単発の流入があると総数の比較は意味を持たない。

## やってはいけないこと

- GA4 / Search Console の**設定変更**（キーイベント設定、ユーザー権限、データ保持期間など）。
  このツールは読み取り専用スコープしか要求していない。設定が必要なら利用者に伝えるだけにする。
- 認証情報（`.env`、サービスアカウント鍵、トークン）を**リポジトリ内に置く / コミットする**。
- `reports/` の出力を**コミットする**（実データを含むため `.gitignore` 済み）。
- API に必要な ID（`GA4_PROPERTY_ID`、`SEARCH_CONSOLE_SITE_URL`）を**推測して設定する**。
  不明なら利用者に確認する。
- `site/` の HTML ファイル名を変更する。

## 既知の状態

- 問い合わせ導線は LINE（`lin.ee`）への外部リンクのみ。Googleフォームの導線は廃止済み。
  外部サイトへの遷移のため、**友だち追加や申込の完了は GA4 では計測できない**
  （計測できるのはクリックまで）。
- LINE クリックは GA4 のキーイベント `line_click` として計上される（2026年8月30日設定）。
  それ以前のデータには遡及しない。
- LINE の友だち追加は Anki デッキ（.apkg）の無料配布が動機になっている。
  そのため `line_click` は「レッスンへの関心」ではなく「特典への関心」を
  含んでいる点に注意する。

## ベースライン（2026-08-01 〜 08-28）

改善効果を判断するための基準値。

| 指標 | 値 |
|---|---|
| セッション / ユーザー | 674 / 547 |
| LINEクリック | 15ユーザー（全体の2.7%） |
| `/toeic990` の転換率 | 2.0%（448人中9人） |
| `/` の転換率 | 6.4%（93人中6人） |
| note.com への離脱 | 10ユーザー |
| 検索：表示 / クリック / 平均掲載順位 | 943 / 25 / 10.1位 |
| `/eiken-daigaku-riyou` のCTR | 約1%（599表示・6クリック） |

この期間の直後に、canonical の修正・記事内CTAの追加・タイトル改善を実施した。

## コードを変更したとき

```bash
npm run analytics:selftest
```

期間計算・URL 正規化・SEO 候補抽出・GA4×GSC 突き合わせ・レポート生成を
合成データで検証する。API 接続は不要。
