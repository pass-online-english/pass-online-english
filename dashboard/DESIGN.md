# 夫婦向けホームダッシュボード 設計書 (V1)

最重要ゴール: **「夫婦2人の今日どう動くかを3秒で把握できる常時表示型ホームダッシュボード」**

---

## 1. 推奨技術スタック

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| 実行環境 | **Cloudflare Workers**（Modules 形式 / ESM） | 無料枠 10万req/日、常時稼働、HTTPS 標準、コールドスタートほぼ無し |
| 静的配信 | **Workers Static Assets**（`assets` バインディング） | Pages を別管理せず Worker 1本に集約。API と同一オリジンで CORS 不要 |
| キャッシュ / 障害耐性 | **Workers KV** | 最後に成功したデータを保持。TV と iPhone で共有され Google API 呼び出しも節約 |
| フロントエンド | **素の HTML + CSS + ES5 JavaScript（ビルド無し）** | Fire TV の Silk ブラウザ（やや古い Chromium）でも壊れない。バンドラ・トランスパイラ不要でデプロイが一瞬 |
| 外部 API | Google Calendar API v3 / Google Tasks API v1 / Open-Meteo | 要件どおり。Open-Meteo は APIキー不要 |
| 認証 | Cloudflare Access（Zero Trust）＋ Worker 側デバイストークン | 「URLを知っていれば誰でも見られる」を排除 |
| ローカル開発 | Wrangler（`npx wrangler dev`）＋ `DEMO_MODE` | Google 連携前でもダミーデータで全画面確認可能 |

**フレームワークを使わない理由**: React/Vite 等はビルド成果物が Silk ブラウザの ES モジュール/最新構文に依存しやすく、
「古めのブラウザでも壊れにくい」という要件 (19) と相性が悪い。画面数 1・状態も単純なので素の JS が最も堅い。

## 2. 推奨クラウド構成

```
Google Calendar API ─┐
Google Tasks API   ─┤ (サーバー間通信・OAuth refresh token)
Open-Meteo         ─┘
        ↓
[Cloudflare Workers]  dashboard.example.com
  ├ /            静的アセット (index.html / style.css / app.js)
  ├ /api/config  クライアント用設定（秘密情報を含まない）
  ├ /api/calendar・/api/tasks・/api/weather  ソース別 JSON（状態付き）
  └ Workers KV   最終正常データ / アクセストークン / JWKS キャッシュ
        ↓
  ├ Fire TV Stick (Silk) → MAGICRAVEN 15.6"    … デバイストークンで常時表示
  └ iPhone Safari (外出先)                      … Cloudflare Access でログイン
```

- Mac・自宅PC は一切不要（開発時のみ使用）。
- 費用: Workers 無料枠 + KV 無料枠で **月0円**（独自ドメインを使う場合のみドメイン代）。
- 代替候補: Deno Deploy / Fly.io / Vercel。ただし「無料・常時稼働・認証・シークレット管理」の 4点を最も低コストで満たすのは Cloudflare。

## 3. Google Calendar / Tasks の認証方式

**OAuth 2.0 リフレッシュトークン方式（インストール済みアプリ / Web アプリのクライアント）を採用。**

- サービスアカウントは Google Workspace のドメイン全体委任が前提で、**個人 Gmail では使えない**ため不採用。
- 自分の Google アカウントで一度だけ同意画面を通し、`refresh_token` を取得 → Cloudflare の Secret に保存。
- Worker がサーバー間で `refresh_token` → `access_token` に交換（KV に有効期限までキャッシュ）。
  **ブラウザ側には client_secret も token も一切渡らない。**
- 妻のカレンダーは「妻の Google カレンダーを自分のアカウントへ共有（閲覧権限）」してもらい、
  自分のトークン 1本で読む。これでトークン管理が 1系統で済む。
- スコープ: `calendar.readonly` + `tasks.readonly`（読み取り専用。非ゴールの編集機能を構造的に排除）。
- Google Tasks は共有できないため、共有タスクは「共有カレンダー」か「同一 Google アカウントのタスクリスト」で運用する想定。

## 4. Cloudflare 等での認証方式

2段構えで、**どちらか一方が通らなければ 401**（無認証で見える構成は存在しない）。

1. **Cloudflare Access (Zero Trust)** — iPhone / Mac 用。
   - Application を作成し、ポリシーは `Emails` に夫婦2人のアドレスのみ許可。
   - Worker 側でも `Cf-Access-Jwt-Assertion` を **JWKS で署名検証**し、`aud`・`exp`・`email ∈ authorizedUsers` を再チェック（多層防御）。
2. **デバイストークン** — Fire TV Stick 用。
   - Silk ブラウザで毎回 SSO ログインするのは現実的でないため、`?token=<長い乱数>` で一度アクセスすると
     `HttpOnly; Secure; SameSite=Lax` の 1年 Cookie を発行。以降はブックマークを開くだけ。
   - トークンは `DASHBOARD_TOKEN` Secret。比較は**時間一定比較**。
   - 推奨: Access を掛けるホスト名（`dash.…`）と TV 用ホスト名（`tv.…`）を分け、TV 用は Cloudflare WAF で自宅 IP に限定するとさらに安全。
3. どちらの Secret も未設定の場合は **503 を返して起動しない**（フェイルオープンしない）。

## 5. ディレクトリ構成

```
dashboard/
├── DESIGN.md              本書
├── README.md              セットアップ / 運用手順
├── wrangler.toml          Workers 設定（KV / assets / vars）
├── package.json
├── .dev.vars.example      ローカル用シークレット雛形
├── src/                   Worker（サーバー側）
│   ├── index.js           ルーティング・認証適用・レスポンス整形
│   ├── config.js          設定のデフォルト値と環境変数マージ
│   ├── auth.js            Access JWT 検証 / デバイストークン検証
│   ├── cache.js           KV ラッパ + ソース別ステータス管理 + 失敗時フォールバック
│   ├── google.js          OAuth トークン更新 / Calendar / Tasks 取得・正規化
│   ├── weather.js         Open-Meteo 取得 + ルールベース行動コメント
│   ├── time.js            タイムゾーン計算ユーティリティ
│   └── demo.js            DEMO_MODE 用ダミーデータ
├── public/                ブラウザ（クライアント側）
│   ├── index.html         TV / iPhone 共通のマークアップ
│   ├── style.css          TVレイアウト + レスポンシブ + 夜間モード
│   └── app.js             ES5。取得・再試行・時刻計算・描画
├── scripts/
│   └── get-refresh-token.mjs   リフレッシュトークン取得用ワンショット CLI
└── test/
    └── *.test.mjs         純粋関数のユニットテスト（node --test）
```

## 6. 必要な初期設定（Google / Cloudflare）

**Google Cloud Console**
1. プロジェクト作成 → 「Google Calendar API」「Google Tasks API」を有効化。
2. OAuth 同意画面: External / テストユーザーに夫婦2人を追加（公開申請は不要）。
3. 認証情報 → OAuth クライアント ID → **デスクトップアプリ**を作成（`http://localhost` リダイレクトが使える）。
4. `node scripts/get-refresh-token.mjs` を Mac で一度実行し `refresh_token` を取得。
5. Google カレンダー: 妻のカレンダーを自分に共有。各カレンダーの「カレンダー ID」を控える。

**Cloudflare**
1. Workers 有効化（無料プラン）。
2. KV 名前空間 `DASHBOARD_CACHE` を作成し `wrangler.toml` の id を差し替え。
3. `wrangler secret put` で各シークレットを登録。
4. （任意）独自ドメインを Cloudflare に載せ、Workers のカスタムドメインを設定。
5. Zero Trust → Access → Application を作成し、ポリシーで夫婦2人のメールのみ許可。`aud` タグを控える。

## 7. あなたが手動で取得・設定する値

| 種別 | 名前 | 例 / 取得元 |
| --- | --- | --- |
| Secret | `GOOGLE_CLIENT_ID` | Google Cloud Console |
| Secret | `GOOGLE_CLIENT_SECRET` | 同上 |
| Secret | `GOOGLE_REFRESH_TOKEN` | `scripts/get-refresh-token.mjs` の出力 |
| Secret | `DASHBOARD_TOKEN` | `openssl rand -hex 32` で自作（Fire TV 用） |
| Secret (任意) | `ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` |
| Secret (任意) | `ACCESS_AUD` | Access Application の Audience Tag |
| 変数 | `CONFIG_JSON` | カレンダーID・色・緯度経度など（下記） |
| 変数 | `LATITUDE` / `LONGITUDE` | 自宅の緯度経度（Google マップで右クリック） |
| 変数 | `AUTHORIZED_USERS` | `me@example.com,wife@example.com` |
| ID | calendarId | Google カレンダー設定 → 「カレンダーの統合」内の ID |
| ID | taskListId | 既定は `@default`。複数使うなら README の手順で ID を確認 |

`CONFIG_JSON` の例:
```json
{
  "calendars": [
    { "key": "me",     "calendarId": "me@gmail.com",  "displayName": "自分", "color": "#4FC3F7", "person": "me",     "enabled": true },
    { "key": "wife",   "calendarId": "wife@gmail.com","displayName": "妻",   "color": "#F48FB1", "person": "wife",   "enabled": true },
    { "key": "shared", "calendarId": "xxx@group.calendar.google.com", "displayName": "共通", "color": "#A5D6A7", "person": "shared", "enabled": true }
  ],
  "importantCalendarId": "yyy@group.calendar.google.com"
}
```

## 8. 実装ステップ（フェーズ）

| Phase | 内容 | 完了時に確認できること |
| --- | --- | --- |
| 1 | 技術構成確定 / 画面モック / レスポンシブ UI / ダミーデータで全画面 | `DEMO_MODE=1` で TV・iPhone 両レイアウトが完成 |
| 2 | Open-Meteo・Google Calendar・Google Tasks 連携 | 実データが表示される |
| 3 | NEXT / TODAY / TONIGHT / TOMORROW / 天気コメント | 「どう動くか」が読める状態 |
| 4 | 認証・本番デプロイ・Fire TV / iPhone 実機確認 | 外出先から安全に閲覧できる |
| 5 | キャッシュ / API障害対応 / 自動復旧 / UI 改善 | 通信を切っても表示が継続し、復旧で自動追従 |

## 9. 想定されるリスク

| リスク | 対策 |
| --- | --- |
| Google OAuth の refresh_token 失効（テストユーザー状態で 7日、パスワード変更時など） | 同意画面を「本番」に切り替えるか、失効時は `/api/health` と画面上のエラーバッジで即検知。再取得手順を README 化 |
| Google API のクォータ超過 | KV でサーバー側キャッシュ（5分）。複数端末でも上流アクセスは共有 1回 |
| Fire TV Silk の描画差異 / 省電力スリープ | ES5・CSS Grid の基本機能のみ使用。時刻ジャンプ検知で復帰時に即再取得。定期フルリロードも設定可 |
| Access のセッション切れで TV が真っ白 | TV はデバイストークン Cookie（1年）で運用。Access は携帯側のみ |
| KV の結果整合性（最大60秒） | 表示は「最終正常更新時刻」を必ず併記し、古さが分かる設計に |
| 秘密情報の漏洩 | Secret は Cloudflare 側のみ。`/api/config` はカレンダー ID すら返さない（内部 key に変換） |
| 全画面が単一障害点 | ソース別に取得・ソース別にステータス管理。1つ落ちても他は描画継続 |
| モニターの焼き付き | 夜間モードで減光。将来的に微小オフセットを入れる余地あり |

## 10. 現時点で不足している情報（デフォルトで進めた項目）

| 項目 | 置いたデフォルト | 後から変更する場所 |
| --- | --- | --- |
| 自宅の緯度経度 | 東京駅 35.681236 / 139.767125 | `LATITUDE` / `LONGITUDE` |
| カレンダー ID・色 | `primary` + 未設定の「妻」「共通」枠（色は水色/ピンク/緑） | `CONFIG_JSON.calendars` |
| タスクリスト | `@default` 1つ | `CONFIG_JSON.taskLists` |
| 独自ドメイン有無 | 無し（`*.workers.dev` で動作） | `wrangler.toml` の routes |
| Access 利用有無 | 未設定でもデバイストークンのみで運用可 | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` |
| 夫婦の呼称 | 「自分」「妻」「共通」 | `CONFIG_JSON.calendars[].displayName` |
| 終日イベントを NEXT に含めるか | 含めない | `nextIncludesAllDay` |
| 夜間モード | 00:00–06:00 に減光 | `nightMode` |
| 障害メール通知 (Could) | 未実装（画面上のバッジと `/api/health` で代替） | 将来 Cron Trigger で追加可能 |
