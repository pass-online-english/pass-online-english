/**
 * 環境変数の読み込みと検証。
 * 値そのものはログに出さない（ID の先頭数文字のみ表示する）。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

class ConfigError extends Error {}

function blank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/** GA4 プロパティID。数字のみを受け付ける（測定ID G-XXXX との取り違え防止）。 */
export function ga4PropertyId() {
  const raw = (process.env.GA4_PROPERTY_ID ?? '').trim().replace(/^properties\//, '');
  if (blank(raw)) {
    throw new ConfigError(
      'GA4_PROPERTY_ID が未設定です。\n' +
        '  GA4 → 管理 → プロパティ設定 → 右上の「プロパティID」（数字9〜10桁）を .env に設定してください。'
    );
  }
  if (/^G-/i.test(raw)) {
    throw new ConfigError(
      `GA4_PROPERTY_ID に測定ID（${raw}）が設定されています。\n` +
        '  測定ID（G-から始まる値）は API では使えません。数字のみの「プロパティID」を設定してください。\n' +
        '  GA4 → 管理 → プロパティ設定 → 右上「プロパティID」'
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`GA4_PROPERTY_ID は数字のみで指定してください（現在: ${raw}）。`);
  }
  return raw;
}

/** Search Console のサイトURL。登録形式と完全一致が必要。 */
export function searchConsoleSiteUrl() {
  const raw = (process.env.SEARCH_CONSOLE_SITE_URL ?? '').trim();
  if (blank(raw)) {
    throw new ConfigError(
      'SEARCH_CONSOLE_SITE_URL が未設定です。\n' +
        '  Search Console の登録形式と完全一致させてください。\n' +
        '    ドメインプロパティ : sc-domain:example.com\n' +
        '    URLプレフィックス  : https://example.com/  （末尾スラッシュまで一致）'
    );
  }
  if (!raw.startsWith('sc-domain:') && !/^https?:\/\//.test(raw)) {
    throw new ConfigError(
      `SEARCH_CONSOLE_SITE_URL の形式が不正です（現在: ${raw}）。\n` +
        '  "sc-domain:example.com" または "https://example.com/" の形式で指定してください。'
    );
  }
  if (/^https?:\/\//.test(raw) && !raw.endsWith('/')) {
    throw new ConfigError(
      `SEARCH_CONSOLE_SITE_URL は末尾のスラッシュまで完全一致が必要です（現在: ${raw}）。\n` +
        `  "${raw}/" ではありませんか？`
    );
  }
  return raw;
}

/**
 * サイトの正規オリジン。GSC のページURL(絶対URL)と GA4 のパスを突き合わせるために使う。
 * 未設定なら SEARCH_CONSOLE_SITE_URL から推定する。
 */
export function siteOrigin() {
  const explicit = (process.env.SITE_ORIGIN ?? '').trim();
  if (!blank(explicit)) return explicit.replace(/\/+$/, '');

  const site = (process.env.SEARCH_CONSOLE_SITE_URL ?? '').trim();
  if (site.startsWith('sc-domain:')) return `https://${site.slice('sc-domain:'.length)}`;
  if (/^https?:\/\//.test(site)) {
    try {
      return new URL(site).origin;
    } catch {
      /* fallthrough */
    }
  }
  return '';
}

export function outputDir() {
  const raw = (process.env.ANALYTICS_OUTPUT_DIR ?? '').trim();
  return path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, blank(raw) ? 'reports' : raw);
}

export function gscLagDays() {
  const n = Number.parseInt(process.env.GSC_LAG_DAYS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export function ga4LagDays() {
  const n = Number.parseInt(process.env.GA4_LAG_DAYS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * サービスアカウント鍵がリポジトリ内を指していないか検査する。
 * 鍵をリポジトリ内に置く運用を防ぐためのガード。
 */
export function assertCredentialsOutsideRepo() {
  const p = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (blank(p)) return null;

  const abs = path.resolve(REPO_ROOT, p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const rel = path.relative(REPO_ROOT, abs);
  const insideRepo = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideRepo) {
    throw new ConfigError(
      `GOOGLE_APPLICATION_CREDENTIALS がリポジトリ内のパスを指しています:\n  ${abs}\n` +
        '  認証情報は必ずリポジトリ外に置いてください（例: ~/.config/google-credentials/…json）。'
    );
  }
  if (!fs.existsSync(abs)) {
    throw new ConfigError(
      `GOOGLE_APPLICATION_CREDENTIALS のファイルが見つかりません:\n  ${abs}\n` +
        '  パスを確認するか、ADC（gcloud auth application-default login）に切り替えてください。'
    );
  }
  return abs;
}

export function quotaProjectId() {
  const v = (process.env.GOOGLE_CLOUD_PROJECT ?? '').trim();
  return blank(v) ? null : v;
}

/**
 * OAuth（ブラウザ認証）で取得したトークンの保存先。
 * gcloud を入れられない環境向けの認証方式で使う。リポジトリ外に置く。
 */
export function oauthTokenPath() {
  const explicit = (process.env.GOOGLE_OAUTH_TOKEN_PATH ?? '').trim();
  if (!blank(explicit)) {
    return path.resolve(explicit.replace(/^~(?=$|\/)/, os.homedir()));
  }
  return path.join(os.homedir(), '.config', 'pass-analytics', 'oauth-token.json');
}

/** `npm run analytics:login` 実行時に必要な OAuth クライアント情報 */
export function oauthClientFromEnv() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  if (blank(clientId) || blank(clientSecret)) {
    throw new ConfigError(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET が未設定です。\n' +
        '  Google Cloud Console →「APIとサービス」→「認証情報」→\n' +
        '  「+ 認証情報を作成」→「OAuth クライアント ID」→ アプリの種類「デスクトップ アプリ」\n' +
        '  で作成し、表示されるクライアントIDとクライアントシークレットを .env に設定してください。\n\n' +
        '  ※ これはサービスアカウント鍵ではないため、\n' +
        '     「サービス アカウント キーの作成が無効になっています」の制限には該当しません。'
    );
  }
  return { clientId, clientSecret };
}

export { ConfigError };
