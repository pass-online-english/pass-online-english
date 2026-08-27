# GA4 / Google Search Console 分析ツール

Passオンライン英語サイトのアクセス解析・SEO分析を、コマンドで取得・分析するためのツールです。

**重要な原則**

- **読み取り専用**です。GA4 / Search Console の設定変更・ユーザー変更・削除・データ変更は一切行いません（書き込みスコープを要求していません）。
- **認証情報はリポジトリに保存しません**。`.gitignore` で `.env` と各種 credential ファイルを除外しています。
- 静的サイト本体（`index.html` / `style.css` / `blog/`）の動作には影響しません。`package.json` は分析ツール専用です。

---

## 目次

1. [初回セットアップ](#1-初回セットアップ)
2. [コマンド一覧](#2-コマンド一覧)
3. [オプション](#3-オプション)
4. [出力ファイル](#4-出力ファイル)
5. [分析の観点](#5-分析の観点)
6. [データ上の制約](#6-データ上の制約)
7. [トラブルシューティング](#7-トラブルシューティング)

---

## 1. 初回セットアップ

### 1-1. Node.js の準備

Node.js 20 以上が必要です。

```bash
node -v          # v20 以上であることを確認
npm install      # 依存パッケージをインストール
```

### 1-2. Google Cloud の設定

1. **プロジェクトを用意する**
   [Google Cloud Console](https://console.cloud.google.com/) → 上部のプロジェクト選択 →「新しいプロジェクト」
   （既存のプロジェクトがあればそれで構いません）

2. **API を2つ有効化する**
   「APIとサービス」→「ライブラリ」で以下を検索し、それぞれ「有効にする」

   - `Google Analytics Data API`
   - `Google Search Console API`

3. **gcloud CLI をインストールする**
   [インストール手順](https://cloud.google.com/sdk/docs/install)

### 1-3. 認証（ADC / ユーザー認証）

サービスアカウントの秘密鍵ファイルを作らない方式です。ご自身の Google アカウント
（GA4 と Search Console の権限をすでに持っているアカウント）で認証します。

```bash
gcloud auth login

gcloud auth application-default login \
  --scopes=openid,\
https://www.googleapis.com/auth/cloud-platform,\
https://www.googleapis.com/auth/analytics.readonly,\
https://www.googleapis.com/auth/webmasters.readonly

gcloud auth application-default set-quota-project <あなたのプロジェクトID>
```

> `--scopes` の指定は必須です。省略すると `cloud-platform` のみになり、
> GA4 / Search Console の API を呼んだ時点で「スコープ不足」エラーになります。

認証情報は `~/.config/gcloud/application_default_credentials.json`
（Windows は `%APPDATA%\gcloud\`）に保存されます。**リポジトリ内には保存されません。**

<details>
<summary>サービスアカウント鍵を使う場合（代替手段）</summary>

複数人で共有する、CI で回すなどの理由でサービスアカウントが必要な場合のみ。

1. Google Cloud Console →「APIとサービス」→「認証情報」→「+ 認証情報を作成」→「サービスアカウント」
   ロールは**選択しません**（GCP の IAM ロールは不要。権限は GA4 / Search Console 側で個別に付与します）
2. 作成したサービスアカウント →「キー」タブ →「鍵を追加」→「新しい鍵を作成」→ JSON
3. **リポジトリ外**に保存する

   ```bash
   mkdir -p ~/.config/google-credentials
   mv ~/Downloads/<ダウンロードしたファイル>.json ~/.config/google-credentials/pass-analytics.json
   chmod 600 ~/.config/google-credentials/pass-analytics.json
   ```

4. `.env` に絶対パスを設定する

   ```
   GOOGLE_APPLICATION_CREDENTIALS=/Users/you/.config/google-credentials/pass-analytics.json
   ```

5. GA4 → 管理 →「プロパティのアクセス管理」→ サービスアカウントのメールを**閲覧者**で追加
6. Search Console → 設定 →「ユーザーと権限」→ サービスアカウントのメールを**制限付き**で追加

リポジトリ内のパスを指定した場合、スクリプトは起動時にエラーで停止します。

</details>

### 1-4. 権限の確認

ADC（ユーザー認証）の場合、ご自身のアカウントの権限がそのまま使われます。必要なのは以下だけです。

| サービス | 必要な権限 | 確認場所 |
|---|---|---|
| GA4 | **閲覧者（Viewer）** 以上 | 管理 → プロパティのアクセス管理 |
| Search Console | **制限付き（Restricted）** 以上 | 設定 → ユーザーと権限 |

管理者権限は不要です。

### 1-5. 環境変数

```bash
cp .env.example .env
```

`.env` を開いて以下を設定します。

| 変数 | 内容 | 取得場所 |
|---|---|---|
| `GA4_PROPERTY_ID` | **数字のみ**のプロパティID | GA4 → 管理 → プロパティ設定 → 右上「プロパティID」 |
| `SEARCH_CONSOLE_SITE_URL` | 登録形式と**完全一致**する文字列 | Search Console のプロパティ一覧 |
| `SITE_ORIGIN` | サイトの正規オリジン（任意） | 例: `https://example.com` |

> `G-XXXXXXXXXX` は**測定ID**であり API では使えません。数字のプロパティIDが必要です。
> 誤って設定した場合はスクリプトがその旨を指摘して停止します。

`SEARCH_CONSOLE_SITE_URL` の形式は2種類あります。どちらかは Search Console の登録方法で決まります。

- ドメインプロパティ: `sc-domain:example.com`
- URLプレフィックス: `https://example.com/` ← **末尾スラッシュまで一致が必要**

正しい文字列がわからない場合は `npm run analytics:doctor` を実行すると、
アクセス可能なプロパティの一覧がそのままの形式で表示されます。

### 1-6. 疎通確認

```bash
npm run analytics:doctor
```

環境変数 → 認証 → GA4 API → Search Console API の順に確認し、
問題があれば箇所と対処法を表示します。すべて ✅ になればセットアップ完了です。

```bash
npm run analytics:schema
```

こちらは、使用している GA4 のディメンション・指標名が
**あなたのプロパティで現在有効か**をメタデータAPIから直接検証します。
GA4 は名称が改称されることがあるため（例: `conversions` → `keyEvents`）、
廃止済みの名称を使っていないかをここで確認できます。

---

## 2. コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run analytics:doctor` | 設定・認証・API疎通の確認 |
| `npm run analytics:schema` | GA4 のディメンション/指標名の有効性を検証 |
| `npm run analytics:ga4` | GA4 データの取得 |
| `npm run analytics:gsc` | Search Console データの取得 |
| `npm run analytics:insights` | SEO 改善候補の抽出（Search Console 単体） |
| `npm run analytics:report` | **GA4 × Search Console 統合レポート**（通常はこれ） |
| `npm run analytics:selftest` | 分析ロジックの自己テスト（API接続なし） |

### よく使う実行例

```bash
# 直近28日の統合レポート（前の28日と比較）
npm run analytics:report -- --days 28

# 直近7日 vs その前の7日
npm run analytics:report -- --days 7

# 直近3か月 vs 前年同期
npm run analytics:report -- --days 90 --compare yoy

# 期間を指定（比較なし）
npm run analytics:report -- --start 2026-01-01 --end 2026-03-31 --compare none

# 地域の偏りを詳しく調べる（市区町村 × デバイス/ブラウザ/流入元/LP）
npm run analytics:ga4 -- --days 28 --geo-cross

# SEO 改善候補だけを見る（しきい値を上げてノイズを減らす）
npm run analytics:insights -- --days 28 --min-impressions 50
```

---

## 3. オプション

すべてのコマンドで共通です。`npm run` 経由の場合は `--` を挟んでください。

| オプション | 既定値 | 内容 |
|---|---|---|
| `--days <n>` | `28` | 直近 n 日間（終端を含む） |
| `--start <YYYY-MM-DD>` | — | 開始日を明示 |
| `--end <YYYY-MM-DD>` | — | 終了日を明示 |
| `--compare <mode>` | `previous` | `none` / `previous` / `yoy` / `yoy-calendar` |
| `--format <list>` | `json,csv,md` | 出力形式をカンマ区切りで指定 |
| `--out <dir>` | — | 出力先ディレクトリを指定 |
| `--limit <n>` | — | 取得行数の上限 |
| `--quiet` | — | 進捗表示を抑制 |

コマンド固有のオプション

| コマンド | オプション | 内容 |
|---|---|---|
| `analytics:ga4` / `analytics:report` | `--geo-cross` | 地域偏り検証用のクロス分析を追加取得 |
| `analytics:ga4` | `--only <keys>` | 特定のレポートだけ取得（例: `--only geo-city,device`） |
| `analytics:gsc` | `--max-rows <n>` | 1レポートあたりの最大取得行数 |
| `analytics:insights` | `--min-impressions <n>` | 候補抽出の最小表示回数（既定 30） |
| `analytics:insights` | `--position-low <n>` / `--position-high <n>` | Opportunity A の順位帯（既定 4〜15） |

### 比較モードの違い

- `previous` … 直前の同じ長さの期間。例: 直近28日 → その前の28日
- `yoy` … **364日前**（52週前）。曜日が揃うため、週次の変動を比較しやすい
- `yoy-calendar` … 前年の同じ月日。曜日はずれる

---

## 4. 出力ファイル

`reports/<コマンド>-<日時>/` に出力されます。`reports/` は Git 管理外です。

### `analytics:report` の出力

| ファイル | 内容 |
|---|---|
| `report.md` | **人間が読むメインのレポート**。全セクションを含む |
| `report.json` | 全データの構造化出力。プログラム／AI による再分析用 |
| `combined-pages.csv` | ページ単位で GA4 と Search Console を突き合わせた表 |
| `A-ranking-upside.csv` | 順位4〜15位の伸びしろ候補 |
| `B-low-ctr-queries.csv` / `B-low-ctr-pages.csv` | CTR が低い改善候補 |
| `C-growing-queries.csv` | 急増しているクエリ |
| `D-declining-queries.csv` / `D-declining-pages.csv` | 劣化候補 |
| `no-click-pages.csv` | 表示されているがクリックされていないページ |
| `poor-behavior-pages.csv` | 流入後の行動が良くないページ |
| `ga4-*.csv` / `gsc-*.csv` | 各切り口の生データ |

`report.md` の構成

1. アクセス概況（日次推移・急増急減の検知を含む）
2. Google 検索の状況
3. 流入元
4. ランディングページ
5. 地域・デバイス
6. コンバージョン（キーイベント）
7. Search Console × GA4 統合分析（ファネル）
8. SEO 改善候補（A〜E）
9. データを読むうえでの制約
10. Executive Summary（**空欄**。データを読んだうえで記述する欄）

---

## 5. 分析の観点

### 抽出できるもの

| 観点 | 出力場所 |
|---|---|
| 検索では表示されているがクリックされていないページ | `report.md` §7 / `no-click-pages.csv` |
| Google から流入しているが、その後の行動が悪いページ | `report.md` §7 / `poor-behavior-pages.csv` |
| アクセスが増えている検索キーワード | Opportunity C |
| 順位4〜15位で伸びしろが大きいキーワード | Opportunity A |

### SEO 改善候補（Opportunity A〜E）

| 記号 | 内容 | 判定 |
|---|---|---|
| **A** | 掲載順位 4〜15位 かつ表示回数が多いクエリ | 順位帯 + 表示回数しきい値 |
| **B** | 表示回数の割に CTR が低いクエリ / ページ | 順位相応の CTR 目安との比較 |
| **C** | 表示回数・クリックが急増しているクエリ | 前期間比 1.5倍以上 |
| **D** | クリック・表示・順位が悪化しているクエリ / ページ | 前期間比 0.7倍以下、または順位1.5以上下落、または圏外化 |
| **E** | 同一クエリで複数ページが表示されている | 表示シェア15%以上のページが2つ以上 |

いずれも**統計上の「候補」**です。原因は API からは判定できません。
実際の検索結果画面・ページ内容・競合状況を確認したうえで判断してください。

### GA4 × Search Console の統合

ページURLをキーにした**集計値どうしの突き合わせ**です。ユーザー単位では結合していません
（Search Console は検索での表示・クリック、GA4 は到達後の行動を測っており、母数の定義が異なるため）。

ファネルは次の形で集計されます。

```
Google検索での表示 → 検索結果のクリック → GA4セッション（LP到達）
  → エンゲージのあったセッション → キーイベント
```

**クリック数とセッション数が一致しないのは正常です。**
ただし乖離が極端な場合（例: クリック比が 50% を切る）、計測タグ未設置・リダイレクト・
計測ブロックなどの可能性があります。`report.md` の「突き合わせのカバレッジ」で確認できます。

### 地域の偏りについて

GA4 の `city` / `region` は **IP アドレスからの推定**です。
Osaka / Yokohama / Shinjuku City / Minato City / Chiyoda City などに偏って見える場合、
以下がいずれも同じ分布を生みうるため、この数字だけでは実際の利用者分布とは判断できません。

- 実際にその地域に利用者がいる
- モバイルキャリアの IP 出口がその地域に集約されている
- VPN・企業ネットワーク経由
- データセンター経由のアクセス（クローラ・ボットを含む）

切り分けの材料として `--geo-cross` を使うと、以下のクロス集計が取得できます。

- 市区町村 × デバイス
- 市区町村 × ブラウザ
- 市区町村 × source / medium
- 市区町村 × ランディングページ
- 市区町村 × デバイス × source / medium
- 市区町村 × OS × ブラウザ

読み方の目安（いずれも決定的な判定ではありません）

- 特定の市区町村で `mobile` の比率が極端に高い → キャリアの IP 出口に寄っている可能性
- 特定の市区町村で `direct / (none)` の比率が極端に高い → ボット、社内アクセス、参照元欠落の可能性
- 特定の市区町村でエンゲージメント率が著しく低い・滞在時間が極端に短い → 自動アクセスの可能性
- 実ユーザーであれば、都市が違ってもランディングページ・流入元の構成は概ね似た形になりやすい

GA4 の API は1リクエストあたりのディメンション数とカーディナリティに上限があるため、
上記は意図的に複数クエリへ分割して取得しています。

---

## 6. データ上の制約

| 項目 | 制約 |
|---|---|
| Search Console データ保持 | **約16か月**。それ以前は取得不可。前年同期比較の上限もここ |
| Search Console データ遅延 | 直近2〜3日は未確定。既定で「今日 − 3日」を終端とする（`GSC_LAG_DAYS` で変更可） |
| Search Console 匿名化 | 検索数が少ないクエリは非開示。**クエリ別の合計はサイト全体値と一致しない**（仕様） |
| GA4 データ保持 | イベントデータ保持設定に依存（**既定2か月** / 最大14か月）。前年同期比較には14か月設定が必要 |
| GA4 データ遅延 | 直近24〜48時間は未確定。既定で「今日 − 1日」を終端とする（`GA4_LAG_DAYS` で変更可） |
| GA4 カーディナリティ | ディメンションの組み合わせが多いと `(other)` 行に集約される |
| GA4 サンプリング | 大規模データではサンプリングされる場合がある（`report.json` の `sampled` で確認可能） |

GA4 のデータ保持設定は「管理 → データ設定 → データ保持」で確認できます。
**このツールは設定の変更を行いません。**

---

## 7. トラブルシューティング

### `Could not load the default credentials`

ADC が未設定です。[1-3](#1-3-認証adc--ユーザー認証) の `gcloud auth application-default login` を実行してください。

### `insufficient authentication scopes` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`

`--scopes` を付けずに ADC を作成しています。作り直してください。

```bash
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly
```

### `SERVICE_DISABLED` / `has not been used in project`

API が未有効化か、割り当てプロジェクトが未設定です。

```bash
gcloud auth application-default set-quota-project <プロジェクトID>
```

に加えて、Google Cloud Console で該当の API が有効になっているか確認してください。

### `403 権限がありません`

GA4 は「プロパティのアクセス管理」で閲覧者以上、
Search Console は「設定 → ユーザーと権限」で制限付き以上が必要です。

### Search Console が `404`

`SEARCH_CONSOLE_SITE_URL` が登録形式と一致していません。
`npm run analytics:doctor` を実行すると、アクセス可能なプロパティが正しい形式で一覧表示されます。
その文字列をそのまま `.env` にコピーしてください。

### GA4 のセッションが 0 件

計測タグ（gtag.js）が設置されていないページがある可能性があります。
`report.md` の「突き合わせのカバレッジ」で、Search Console にあって GA4 にないページを確認できます。

### `(other)` 行が多い

GA4 のカーディナリティ上限です。`--only` や `--limit` で対象を絞るか、
ディメンション数の少ないレポートで確認してください。

### 「キーイベントが1件も計上されていません」と出る

GA4 でキーイベント（旧コンバージョン）が設定されていないか、期間内に発生していません。
**このツールは GA4 の設定を変更しません。** 設定が必要な場合は GA4 の管理画面で行ってください。

なお、問い合わせ導線が外部サイト（Google フォーム、LINE）への遷移である場合、
フォーム送信の完了自体は GA4 では計測できません。計測できるのは
「申込ボタンのクリック（外部リンククリック）」までです。

### ディメンション名・指標名のエラー

GA4 は名称が改称されることがあります。

```bash
npm run analytics:schema
```

でプロパティのメタデータと突き合わせて検証できます。
実行時は既知の新旧対応表による自動フォールバックが働きますが、
恒久対応として `scripts/analytics/lib/ga4-fields.mjs` の定義を更新してください。

---

## ファイル構成

```
scripts/analytics/
├── doctor.mjs             疎通確認
├── schema-check.mjs       GA4 スキーマ検証
├── ga4.mjs                GA4 データ取得
├── search-console.mjs     Search Console データ取得
├── insights.mjs           SEO 改善候補の抽出
├── report.mjs             統合レポート
├── selftest.mjs           分析ロジックの自己テスト
└── lib/
    ├── auth.mjs           認証（読み取り専用スコープ固定）
    ├── env.mjs            環境変数の読み込みと検証
    ├── args.mjs           CLI オプション解析
    ├── dates.mjs          期間・比較期間の計算
    ├── output.mjs         JSON / CSV / Markdown 出力
    ├── urls.mjs           URL 正規化（GA4 と GSC の突き合わせ用）
    ├── ga4-client.mjs     GA4 Data API クライアント
    ├── ga4-fields.mjs     GA4 レポート定義
    ├── gsc-client.mjs     Search Console API クライアント
    ├── opportunities.mjs  SEO 改善候補の抽出ロジック
    ├── combine.mjs        GA4 × GSC のページ単位突き合わせ
    └── cli.mjs            共通実行ラッパ
```
