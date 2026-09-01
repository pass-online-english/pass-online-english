# Home Dashboard — 夫婦2人の常時表示ダッシュボード

自宅の Fire TV Stick（MAGICRAVEN 15.6" モニター）と外出先の iPhone から、
**今日どう動くかを3秒で把握する**ための Information Radiator です。

- 実行環境: **Cloudflare Workers**（24時間稼働・Mac も自宅PCも不要・HTTPS）
- データ元: Google Calendar / Google Tasks / Open-Meteo
- 認証: Cloudflare Access ＋ デバイストークン（無認証では 1バイトも返しません）
- 秘密情報はすべてサーバー側。ブラウザには token も client_secret も calendarId も渡しません。

設計の全体像・技術選定の理由・リスクは [DESIGN.md](./DESIGN.md) を参照してください。

---

## 画面構成

| 領域 | 内容 |
| --- | --- |
| ヘッダー | 現在時刻・日付・曜日 / 現在の天気・最高最低・降水確率 / 各データの更新状態 |
| NEXT | 進行中の予定(NOW) と 次の予定（開始時刻・タイトル・あと何分） |
| TODAY | 今日の予定 ＋ 期限超過/今日期限のタスク ＋ 今日の天気の注意 |
| TONIGHT | 夕方以降(既定17:00〜)の予定を人物ごとに（7 DAYS と同じ色の丸付き）＋ 夜の天気 |
| 7 DAYS | 明後日からの7日間（`weekStartOffset` で変更可。日付・曜日・天気・予定、超過分は「+N件」） |
| TASKS | 期限超過 → 今日 → 近日 の順（完了済みは非表示。総量は見出しの「期限超過n · 全m件」で把握） |
| TOMORROW | 明日の天気・主な予定・タスク（既定20:00以降は枠を強調） |
| COMING UP | 7 DAYS より先の重要予定。判定基準（★ / 重要カレンダー）は見出しに表示 |
| FREE TOGETHER | 二人とも予定が入っていない時間帯（平日18:00〜23:00 / 週末10:00〜、1時間以上連続。すべて設定可） |

カードは**枠に収まるまで優先度の低い行から自動的に省略**され（終了済みの予定 → 通常行の順）、
天気の注意・期限超過タスクは最後まで残ります。スクロールは発生しません。

---

## セットアップ

### 0. 前提
- Cloudflare アカウント（無料プラン可）
- Google アカウント（Calendar / Tasks）
- Node.js 18+ の入った Mac（初回設定時のみ使用）

### 1. まずローカルでダミーデータを見る（Google 連携不要）

```bash
cd dashboard
node scripts/serve-local.mjs        # → http://localhost:8787/?token=localdev
```

`.dev.vars`（git に入りません）に設定を書くと、それを読んで起動します。
Google の3つの値が揃った時点で、自動的にダミーデータから実データへ切り替わります。

```bash
cp .dev.vars.example .dev.vars
```

### 2. Google 側の設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「API とサービス」→ **Google Calendar API** と **Google Tasks API** を有効化
3. OAuth 同意画面: 外部 / テストユーザーに自分（と妻）のアドレスを追加
4. 認証情報 → OAuth クライアント ID → **デスクトップアプリ**を作成
5. `.dev.vars` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を書く（`open -e .dev.vars` で開けます）
6. リフレッシュトークンを取得する（最後に「.dev.vars に保存しますか？」と聞かれるので Enter でOK）

```bash
node scripts/get-refresh-token.mjs      # = npm run token
```

7. カレンダー ID / タスクリスト ID を一覧表示する（`CONFIG_JSON` の雛形も出て、そのまま `.dev.vars` に保存できます）

```bash
node scripts/list-google-ids.mjs        # = npm run ids
```

   妻のカレンダーを含めるには、妻のアカウント側から自分へ
   「予定の表示（すべての予定の詳細）」で共有してもらってください。共有後は上記の一覧に現れます。

8. 実データで起動して確認

```bash
node scripts/serve-local.mjs            # [Google 実データ] と表示されれば連携成功
```

### 3. Cloudflare 側の設定

```bash
cd dashboard
npm install

# KV 名前空間を作成し、出力された id を wrangler.toml に貼る
npx wrangler kv namespace create DASHBOARD_CACHE

# シークレット登録
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put DASHBOARD_TOKEN        # openssl rand -hex 32 の出力を貼る
npx wrangler secret put CONFIG_JSON            # カレンダー定義（下記）。ID はメールアドレスなので Secret 推奨

# デプロイ
npx wrangler deploy
```

カレンダー定義は `CONFIG_JSON` に入れます。**カレンダー ID は個人のメールアドレスを含む**ため、
リポジトリが公開されている場合は `wrangler.toml` に直接書かず、上記のように **Secret** として登録してください。
（非公開リポジトリなら `wrangler.toml` の `[vars]` に書いても構いません）

```toml
CONFIG_JSON = '''
{
  "calendars": [
    { "key": "me",     "calendarId": "me@gmail.com",   "displayName": "夫",   "color": "#4FC3F7", "person": "me",     "enabled": true },
    { "key": "wife",   "calendarId": "wife@gmail.com", "displayName": "妻",   "color": "#F48FB1", "person": "wife",   "enabled": true },
    { "key": "shared", "calendarId": "xxx@group.calendar.google.com", "displayName": "共通", "color": "#A5D6A7", "person": "shared", "enabled": true }
  ],
  "comingUp": { "importantCalendarId": "yyy@group.calendar.google.com" }
}
'''
```

### 4. 認証の有効化

**iPhone / Mac（Cloudflare Access）**
1. Zero Trust → Access → Applications → Add an application（Self-hosted）
2. ドメインに Worker のホスト名を指定
3. Policy: Action=Allow / Include=Emails → 夫婦2人のアドレス
4. Application の **Audience (AUD) Tag** を控えて登録

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # 例: yourteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD
npx wrangler secret put AUTHORIZED_USERS     # me@example.com,wife@example.com （vars でも可）
```

**Fire TV Stick（デバイストークン）**
Silk ブラウザで一度だけ次を開くと、1年間有効な HttpOnly Cookie が入り、以後はブックマークだけで表示できます。

```
https://<your-worker>.workers.dev/?token=<DASHBOARD_TOKEN>
```

> Access をホスト名全体に掛けると Fire TV も SSO を要求されます。
> TV を常時表示にする場合は「Access を掛けるホスト名」と「TV 用ホスト名」を分け、
> TV 用は WAF で自宅 IP に限定するのが安全かつ運用が楽です（DESIGN.md 参照）。

### 5. Fire TV Stick 側

1. Silk ブラウザをインストールし、上記 URL を開く → ブックマーク
2. 画面の自動スリープを無効化（設定 → ディスプレイとサウンド → スクリーンセーバー）
3. マウス・キーボード操作は不要です（データは自動更新、6時間ごとにページも自動再読込）

---

## 設定値一覧（要件26）

すべて `wrangler.toml` の `[vars]`（または `CONFIG_JSON`）で変更できます。コードの変更は不要です。

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `timezone` | `Asia/Tokyo` | 表示タイムゾーン |
| `latitude` / `longitude` | 東京駅 | 天気取得位置 |
| `locationName` | `東京` | 画面に出す地名 |
| `calendars[]` | 夫/妻/共通 | `key` `calendarId` `displayName` `color` `person` `enabled` |
| `taskLists[]` | `@default` | `id` `name` `enabled` |
| `daysToDisplay` | `7` | 7 DAYS の日数 |
| `weekStartOffset` | `2` | 7 DAYS の開始日（今日から何日後か）。`2` = 明後日から（今日は TODAY、明日は TOMORROW が担当するため重複しない）。`0` にすると「今日を含む7日間」 |
| `maxEventsPerDay` | `4` | 1日あたりの最大表示件数 |
| `maxTodayEvents` | `6` | TODAY の最大件数 |
| `maxTasks` | `6` | TASKS の最大件数 |
| `tonightStartTime` | `17:00` | TONIGHT の開始時刻 |
| `tomorrowEmphasisTime` | `20:00` | TOMORROW を強調し始める時刻 |
| `nextIncludesAllDay` | `false` | 終日イベントを NEXT の対象にするか |
| `nextLookaheadHours` | `36` | NEXT を探す範囲 |
| `refresh.calendar / tasks / weather / clock / page` | 5分 / 5分 / 30分 / 1秒 / 6時間 | 更新間隔(ms) |
| `refresh.retryBaseMs / retryMaxMs` | 15秒 / 5分 | 失敗時の指数バックオフ |
| `comingUp` | 3件 / 30日 | 7 DAYS より先の予定を拾う。`mode: "important"`（既定）は `importantCalendarId` のカレンダー、またはタイトルに `importantTags`（既定 `★` `【重要】` `#imp`）を含む予定のみ。`mode: "all"` にすると重要判定をせず単に直近から3件 |
| `nightMode` | 00:00–06:00 | 深夜は減光し、時計中心の簡易表示に |
| `freeTogether` | 平日18:00–23:00 / 週末10:00〜 | 空き時間の算出条件 |
| `weatherThresholds` | 雨50% / 猛暑35℃ / 寒暖差10℃ ほか | 天気コメントの判定閾値 |
| `authorizedUsers` | （空） | Access で許可するメールアドレス |

---

## 運用

| 目的 | コマンド / URL |
| --- | --- |
| デプロイ | `npm run deploy` |
| ログ確認 | `npm run tail` |
| 稼働確認 | `GET /api/health`（各ソースの status / lastSuccessAt / error） |
| 強制更新 | `GET /api/calendar?force=1` |
| Cookie 破棄 | `GET /logout` |
| テスト | `npm test`（48件） |

### 障害時の挙動（要件23/24）

- どれか1つの API が落ちても、**他は通常表示のまま**。
- 失敗したデータ種別は最後に成功した内容を表示し続け、
  ヘッダーに `⚠ カレンダー更新失敗 最終正常 19:45` と表示します。
- クライアントは指数バックオフ（15秒→最大5分）で再試行し、復旧すると自動で最新に戻ります。
- 端末のスリープ復帰・回線復帰（`online` イベント）でも即時再取得します。
- 手動リロードは不要です。

### よくあるトラブル

| 症状 | 原因 / 対処 |
| --- | --- |
| 503「DASHBOARD_TOKEN もしくは ACCESS_TEAM_DOMAIN が未設定です」 | シークレット未登録。上記セットアップ4を実施 |
| `invalid_grant` | リフレッシュトークン失効。`scripts/get-refresh-token.mjs` で再取得し、Secret を入れ直す（同意画面がテスト状態だと7日で失効するため、本番へ切り替え推奨） |
| カレンダーが1つだけ出ない | そのカレンダーの共有設定を確認。`/api/health` と画面の「(一部失敗)」表示で切り分け |
| DEMO DATA と出る | Google のシークレット未設定、または `DEMO_MODE=1` |
| Fire TV で文字が小さい | `daysToDisplay` を減らすか、`maxEventsPerDay` を下げる |
