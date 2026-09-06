# ネットスーパー価格の収集

ログイン済みのネットスーパーから商品名と価格を取り出し、
店頭価格メモと突き合わせて「ネットで買ってよさそうなもの」を出すツール。

サイト本体（`site/`）とは無関係で、`npm run netsuper:*` からだけ動く。

## できること

| やりたいこと | コマンド |
|---|---|
| ログインしてセッションを保存する | `npm run netsuper:login` |
| セッションが生きているか確認する | `npm run netsuper:login -- --check` |
| 一覧ページから取り出せるか試す | `npm run netsuper:probe` |
| 全カテゴリを巡回して価格を集める | `npm run netsuper:scrape` |
| 店頭価格・前回と比べる | `npm run netsuper:diff` |
| ロジックの自己テスト（接続なし） | `npm run netsuper:selftest` |

## 準備（初回だけ）

```bash
npm install
npx playwright install chromium     # ブラウザ本体（約150MB）
cp netsuper.config.example.json netsuper.config.json
```

`netsuper.config.json` に、ネットスーパーで売場を開いたときの
**アドレスバーのURLをそのまま**書く。

```json
{
  "store": "文化堂 豊洲店（ツイディ）",
  "entryUrl": "https://.../login",
  "categories": [
    { "name": "野菜", "url": "https://.../category/vegetable" },
    { "name": "精肉", "url": "https://.../category/meat" }
  ]
}
```

このファイルは `.gitignore` 済み。

## 毎週の手順

```bash
npm run netsuper:login    # セッションが切れていたときだけ
npm run netsuper:scrape
npm run netsuper:diff
```

出力は `reports/netsuper/<収集日>/` に入る（`reports/` は `.gitignore` 済み）。

| ファイル | 中身 |
|---|---|
| `items.csv` | 商品名・価格・内容量・カテゴリ・URL。表計算で開く用 |
| `items.json` | 次週の差分比較に使う |
| `summary.md` | カテゴリ別の件数と平均価格 |
| `diff.md` | 買い物リストと前回からの変化 |
| `buy-online.csv` | 「ネットで買ってよさそう」だけを抜いたもの |

## 店頭価格メモ

`data/netsuper/store-prices.csv` に把握している店頭価格を書いておくと、
差額が `diff.md` に出る。

```csv
商品名,店頭価格,メモ
明治 おいしい牛乳 900ml,235,毎週買う
たまご Mサイズ 10個入,268,特売日は198
```

- 列名は `商品名 / 店頭価格 / メモ`（`name / price / note` でも可）
- 商品名はネットスーパー側の表記と完全一致でなくてよい。
  表記ゆれは自動で吸収し、`diff.md` に一致度（1.00 が完全一致）が出る
- 一致度 0.6 未満は突き合わせない。誤って別商品と比較するより、
  「見つからず」と出したほうが安全なため

`npm run netsuper:diff -- --tolerance 15 --yen 30` で
「ほぼ同じ」とみなす幅を変えられる（％と円のゆるいほうを採用）。

## ログインの扱い

- **ID / パスワードはスクリプトを通らない。** `netsuper:login` はブラウザを開くだけで、
  ログインは人が手でやる
- 保存されるのはログイン後の Cookie / localStorage のみ。
  置き場所は**リポジトリの外**（既定 `~/.config/pass-netsuper/session.json`、パーミッション 0600）
- リポジトリ内のパスを `NETSUPER_SESSION` に指定するとエラーで止まる（誤コミット防止）
- セッションが切れたら `npm run netsuper:login` をやり直す

## 商品の取り出し方

店舗ごとに HTML がまったく違うため、セレクタは決め打ちしていない。

1. ページ内で「価格らしきテキストを含む末端の要素」をすべて探す
2. その祖先をたどり、**同じ形の要素が最も多く並び、かつ1つにつき価格が1つだけ**
   含まれる階層を商品カードとみなす
3. カード内から商品名・URL・画像・売り切れ表示を拾う

ヘッダの「3,000円以上で送料無料」やフッタの金額は、
同じ形で繰り返されないため商品として拾われない。

うまく取れないときは `npm run netsuper:probe` を実行する。
判定結果と、そのときの `page.html` / `page.png` が
`reports/netsuper/probe-…/` に残るので、それを見てセレクタを詰められる。

セレクタを固定したい場合:

```bash
npm run netsuper:probe -- --save     # 判定できたセレクタを設定に書き戻す
```

`netsuper.config.json` の `selectors.name` / `selectors.price` を手で書けば、
商品名や価格の取り違えも直せる。

### ページ送り

`pagination.mode` で指定する。

| 値 | 対象 |
|---|---|
| `scroll`（既定） | 下にスクロールすると続きが読み込まれる |
| `next` | 「次へ」ボタンがある（`nextSelector` も指定する） |
| `query` | URL に `?page=2` が付く |
| `none` | 1ページで全部出る |

## 価格の読み取り

表示のゆれが大きいため、数値をすべて拾ってから選ぶ。

- 「本体 298円（税込 321円）」→ **321円**（税込を優先）
- 「298円 321円」→ **321円**（税込表記がなければ大きいほう。`priceCandidates` に両方残す）
- 「980円 100gあたり 245円」→ **980円**（単位あたり価格は本体価格として扱わない）
- 価格を読めなければ `null`。0円にはしない

`items.csv` の `priceKind` が `single` / `tax_included` 以外の行は
元の表示（`priceRaw`）を確認する。

## 注意

- **表示価格をそのまま記録するだけ**で、送料・手数料・ポイントは含まない
- 同じ商品名でも内容量が違えば価格差は当然生じる。`unit` 列も見る
- 会員限定価格やタイムセールは、ログイン状態と収集時刻によって変わる
- ページは1枚ずつ順番に開き、既定で 1.5 秒空ける（`waitMs`）。並列アクセスはしない。
  相手のサーバに負荷をかけない範囲で、自分の買い物のために使うこと
- 収集結果（`reports/`）と設定（`netsuper.config.json`）はコミットしない

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `NETSUPER_CONFIG` | `netsuper.config.json` | 設定ファイルの場所 |
| `NETSUPER_SESSION` | `~/.config/pass-netsuper/session.json` | セッションの保存先（リポジトリ内は不可） |
| `NETSUPER_OUTPUT_DIR` | `reports/netsuper` | 出力先 |
| `NETSUPER_CHROMIUM_PATH` | — | Chromium を自前で用意する場合の実行ファイル |
| `NETSUPER_USER_AGENT` | Chrome 相当 | User-Agent を変えたい場合 |
