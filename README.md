# Passオンライン英語

英検対策を主軸としたオンライン英語レッスンのWebサイト。

## サイト構成

```
index.html            トップページ（LP）
style.css             全体のスタイル
blog/
  toeic990.html       ブログ記事: 新形式TOEIC990点の勉強法
```

素のHTML / CSS で構成された静的サイトです。ビルド処理はありません。

## アクセス解析・SEO分析

GA4 と Google Search Console のデータを取得・分析するツールを同梱しています。
**読み取り専用**で、サイト本体の動作には影響しません。

```bash
npm install
npm run analytics:setup               # .env を対話形式で作成（初回のみ）
npm run analytics:login               # ブラウザ認証（初回のみ / gcloud 不要）
npm run analytics:doctor              # 設定と疎通の確認
npm run analytics:report -- --days 28 # 統合レポートの生成
```

セットアップ手順・コマンド一覧・データ上の制約は **[docs/ANALYTICS.md](docs/ANALYTICS.md)** を参照してください。

| コマンド | 内容 |
|---|---|
| `npm run analytics:setup` | `.env` を対話形式で作成・更新 |
| `npm run analytics:login` | ブラウザ認証（初回・再認証時のみ） |
| `npm run analytics:doctor` | 設定・認証・API疎通の確認 |
| `npm run analytics:schema` | GA4 のディメンション/指標名の有効性を検証 |
| `npm run analytics:ga4` | GA4 データの取得 |
| `npm run analytics:gsc` | Search Console データの取得 |
| `npm run analytics:insights` | SEO 改善候補の抽出 |
| `npm run analytics:report` | GA4 × Search Console 統合レポート |
| `npm run analytics:selftest` | 分析ロジックの自己テスト（API接続なし） |

### 認証情報の取り扱い

- 認証情報は**リポジトリ外**に保存します（`~/.config/pass-analytics/`、パーミッション600）
- サービスアカウントの秘密鍵は作りません（組織ポリシーで鍵作成が禁止されていても利用可能）
- `.env` および credential ファイルは `.gitignore` で除外済みです
- 分析結果の出力先 `reports/` も Git 管理外です
- API のスコープは読み取り専用のみを要求しています

## 計測タグの設置状況

| ページ | GA4 タグ（`G-MYKHP4K4QN`） |
|---|---|
| `blog/toeic990.html` | 設置済み |
| `index.html` | **未設置** |

トップページには gtag.js が入っていないため、このリポジトリの内容がそのまま
公開されている場合、GA4 に届いているのはブログ記事へのアクセスのみになります。
`npm run analytics:report` の「突き合わせのカバレッジ」で、
Search Console にあって GA4 にないページを確認できます。
