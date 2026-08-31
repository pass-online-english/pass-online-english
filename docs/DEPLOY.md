# サイトの管理とデプロイ

## 構成

本番サイト `https://pass-online-english.com` は **Cloudflare Pages** で公開しています。
デプロイは**手動アップロード**です（GitHub との自動連携はしていません）。

```
site/                   本番にアップロードするファイル一式（ここが唯一の正）
scripts/analytics/      GA4 / Search Console 分析ツール（サイトとは無関係）
docs/                   ドキュメント
reports/                分析結果の出力先（Git 管理外）
```

**`site/` の中身が本番サイトそのもの**です。ここを編集して、Cloudflare Pages にアップロードします。

## URL の仕組み（重要）

Cloudflare Pages は、ファイル名から拡張子を取り除いた URL でページを配信します。

| ファイル | 公開URL | `.html` 付きでアクセスした場合 |
|---|---|---|
| `site/index.html` | `/` | — |
| `site/toeic990.html` | `/toeic990` | `/toeic990.html` → **301リダイレクト** → `/toeic990` |
| `site/eiken-daigaku-riyou.html` | `/eiken-daigaku-riyou` | 同上 |

このため、次の2点を必ず守ってください。

- **ファイル名は変更しない。** リネームすると公開URLが変わり、検索評価がリセットされます
- **`canonical` は拡張子なしの URL を指定する。** `.html` を指定すると、リダイレクト元を正規URLとして宣言することになり、Google の評価が2つのURLに分散します

> 2026年8月に、全記事の canonical が `.html` 付きになっている問題が見つかりました。
> Search Console の表示回数943のうち791が `.html` 側URLに紐づき、GA4 は拡張子なしURLに
> 記録されるという分断が起きていました。同月中に修正済みです。

## 更新の手順

```bash
# 1. 最新を取得
cd ~/pass-online-english
git pull

# 2. site/ の中の HTML を編集する

# 3. 変更を記録する
git add site/
git commit -m "記事Xのタイトルを修正"
git push

# 4. Cloudflare Pages に site/ の中身をアップロードする
```

**3 を先に、4 を後に**行ってください。この順番なら、アップロードした内容が必ず Git に残ります。

## 変更前に確認すること

本番の状態は次のコマンドで確認できます。

```bash
# canonical が全ページ正しいか（.html が付いていないこと）
for p in "" toeic990 eiken-daigaku-riyou shogakko-eigo-genjo koukou-eigo-hyoutei eiken2-shougakusei; do
  echo "--- /$p"
  curl -s "https://pass-online-english.com/$p" | grep -io '<link[^>]*canonical[^>]*>'
done

# ページが正しく配信されているか（301 や 404 になっていないか）
curl -sI https://pass-online-english.com/toeic990 | head -1
```

## 計測について

全ページに GA4 タグ（`G-MYKHP4K4QN`）が入っています。新しいページを追加するときは、
**タグの記述を忘れないでください**。忘れるとそのページだけ計測されず、
Search Console には出るのに GA4 には出ない、という状態になります。

問い合わせ導線は LINE（`lin.ee`）への外部リンクです。外部サイトへの遷移のため、
GA4 で計測できるのは**クリックまで**で、その後の友だち追加や申込は計測できません。
LINE クリックは GA4 のキーイベント `line_click` として計上されます。

分析ツールの使い方は [ANALYTICS.md](ANALYTICS.md) を参照してください。
