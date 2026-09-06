# Passオンライン英語

英検対策を主軸としたオンライン英語レッスン `https://pass-online-english.com` のリポジトリ。

素の HTML / CSS による静的サイトで、ビルド処理はありません。
公開は **Cloudflare Pages への手動アップロード**です。

## 構成

```
site/                 本番にアップロードするファイル一式（サイトの実体）
scripts/analytics/    GA4 / Search Console 分析ツール（読み取り専用）
scripts/netsuper/     ネットスーパーの価格収集ツール（サイトとは無関係）
docs/
  DEPLOY.md           サイトの管理とデプロイ手順
  ANALYTICS.md        分析ツールのセットアップと使い方
  NETSUPER.md         ネットスーパー価格収集ツールの使い方
reports/              分析結果・収集結果の出力先（Git 管理外）
```

`package.json` はツール類（分析・価格収集）専用です。公開されるサイトの動作には関与しません。

## サイトを更新する

```bash
git pull
# site/ の中の HTML を編集
git add site/ && git commit -m "..." && git push
# Cloudflare Pages に site/ の中身をアップロード
```

**Git に記録してからアップロード**してください。詳細と注意点は **[docs/DEPLOY.md](docs/DEPLOY.md)**。

> ファイル名は変更しないでください。Cloudflare Pages がファイル名から公開URLを
> 生成しているため、リネームするとURLが変わり検索評価がリセットされます。

## アクセス解析・SEO分析

GA4 と Google Search Console のデータを取得・分析します。**読み取り専用**で、
サイト本体には影響しません。

```bash
npm install
npm run analytics:setup               # .env を対話形式で作成（初回のみ）
npm run analytics:login               # ブラウザ認証（初回のみ / gcloud 不要）
npm run analytics:doctor              # 設定と疎通の確認
npm run analytics:report -- --days 28 # 統合レポートの生成
```

セットアップ手順・データ上の制約は **[docs/ANALYTICS.md](docs/ANALYTICS.md)** を参照してください。

| コマンド | 内容 |
|---|---|
| `npm run analytics:setup` | `.env` を対話形式で作成・更新 |
| `npm run analytics:login` | ブラウザ認証（初回・再認証時のみ） |
| `npm run analytics:doctor` | 設定・認証・API疎通の確認 |
| `npm run analytics:schema` | GA4 のディメンション/指標名の有効性を検証 |
| `npm run analytics:ga4` | GA4 データの取得 |
| `npm run analytics:gsc` | Search Console データの取得 |
| `npm run analytics:insights` | SEO 改善候補の抽出 |
| `npm run analytics:keywords` | 検索ボリュームとの突き合わせ（キーワードギャップ） |
| `npm run analytics:report` | GA4 × Search Console 統合レポート |
| `npm run analytics:selftest` | 分析ロジックの自己テスト（API接続なし） |

### 認証情報の取り扱い

- 認証情報は**リポジトリ外**に保存します（`~/.config/pass-analytics/`、パーミッション600）
- サービスアカウントの秘密鍵は作りません（組織ポリシーで鍵作成が禁止されていても利用可能）
- `.env` および credential ファイルは `.gitignore` で除外済みです
- 分析結果の出力先 `reports/` も Git 管理外です（実データを含むため）
- API のスコープは読み取り専用のみを要求しています
