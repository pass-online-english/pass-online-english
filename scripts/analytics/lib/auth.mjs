/**
 * Google API 認証。
 *
 * 【重要】スコープは読み取り専用のみを要求する。
 * 書き込み系スコープは意図的に一切含めない。トークンが漏れても
 * GA4 / Search Console の設定変更・削除は行えない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { assertCredentialsOutsideRepo, quotaProjectId, oauthTokenPath, ConfigError } from './env.mjs';

/** 読み取り専用スコープ。ここを増やさないこと。 */
export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]);

let cachedClient = null;

/**
 * 認証方式の優先順位
 *   1. OAuth（ブラウザ認証）— `npm run analytics:login` で作成。gcloud 不要
 *   2. サービスアカウント鍵 — GOOGLE_APPLICATION_CREDENTIALS を明示した場合
 *   3. ADC — gcloud auth application-default login
 */
export async function getAuthClient() {
  if (cachedClient) return cachedClient;

  const oauth = loadOAuthClient();
  if (oauth) {
    cachedClient = oauth;
    return oauth;
  }

  const keyFile = assertCredentialsOutsideRepo();
  const quota = quotaProjectId();

  const auth = new google.auth.GoogleAuth({
    scopes: [...SCOPES],
    ...(keyFile ? { keyFile } : {}),
    ...(quota ? { clientOptions: { quotaProjectId: quota } } : {}),
  });

  let client;
  try {
    client = await auth.getClient();
  } catch (err) {
    throw new ConfigError(authHelpMessage(err));
  }
  if (quota) client.quotaProjectId = quota;

  cachedClient = client;
  return client;
}

/** 保存済みの OAuth トークンからクライアントを組み立てる。無ければ null。 */
function loadOAuthClient() {
  const file = oauthTokenPath();
  if (!fs.existsSync(file)) return null;

  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `OAuth トークンファイルを読み込めませんでした:\n  ${file}\n  ${err.message}\n\n` +
        '  `npm run analytics:login` で作り直してください。'
    );
  }
  if (!saved?.tokens?.refresh_token) {
    throw new ConfigError(
      `OAuth トークンファイルにリフレッシュトークンがありません:\n  ${file}\n\n` +
        '  `npm run analytics:login` で作り直してください。'
    );
  }

  const client = new google.auth.OAuth2(saved.clientId, saved.clientSecret);
  client.setCredentials(saved.tokens);

  // 更新されたトークンを書き戻す（リフレッシュトークンが回転した場合に備える）
  client.on('tokens', (tokens) => {
    try {
      const merged = { ...saved, tokens: { ...saved.tokens, ...tokens } };
      writeOAuthToken(merged);
      saved = merged;
    } catch {
      // 書き戻しに失敗しても、そのセッションの実行は続行できる
    }
  });

  return client;
}

/** OAuth トークンをリポジトリ外に 0600 で保存する */
export function writeOAuthToken(data) {
  const file = oauthTokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows など chmod が効かない環境では無視する
  }
  return file;
}

/** 認証情報の出所を表示用に説明する（値そのものは出さない）。 */
export function describeCredentialSource() {
  const tokenFile = oauthTokenPath();
  if (fs.existsSync(tokenFile)) {
    let account = '';
    try {
      account = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).account ?? '';
    } catch {
      /* 表示用なので失敗しても無視 */
    }
    return {
      kind: 'oauth-user',
      detail: `${tokenFile}${account ? `（${account}）` : ''}`,
    };
  }
  const keyFile = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (keyFile) return { kind: 'service-account-key', detail: keyFile };
  return {
    kind: 'adc-user',
    detail: '~/.config/gcloud/application_default_credentials.json（gcloud ADC）',
  };
}

export function authHelpMessage(err) {
  return (
    `Google の認証情報を取得できませんでした。\n  原因: ${err?.message ?? err}\n\n` +
    '  【推奨】ブラウザ認証（gcloud のインストール不要）:\n' +
    '    1) Google Cloud Console →「APIとサービス」→「認証情報」で\n' +
    '       「OAuth クライアント ID」（種類: デスクトップ アプリ）を作成\n' +
    '    2) 表示された値を .env の GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET に設定\n' +
    '    3) npm run analytics:login\n\n' +
    '  gcloud を使う場合（ADC）:\n' +
    '    1) gcloud auth application-default login \\\n' +
    `         --scopes=${['openid', 'https://www.googleapis.com/auth/cloud-platform', ...SCOPES].join(',')}\n` +
    '    2) gcloud auth application-default set-quota-project <PROJECT_ID>\n\n' +
    '  サービスアカウント鍵を使う場合:\n' +
    '    .env の GOOGLE_APPLICATION_CREDENTIALS に、リポジトリ外の鍵ファイルの絶対パスを設定してください。\n' +
    '    （組織ポリシーで鍵の作成が禁止されている場合はこの方法は使えません）'
  );
}

/**
 * 権限不足・スコープ不足のエラーを日本語で説明し直す。
 */
export function explainApiError(err, api) {
  const status = err?.code ?? err?.response?.status;
  const raw = err?.response?.data?.error?.message ?? err?.message ?? String(err);

  if (status === 403 && /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(raw)) {
    return (
      `${api}: トークンのスコープが不足しています。\n  ${raw}\n\n` +
      '  ADC を作り直してください:\n' +
      `    gcloud auth application-default login --scopes=${['openid', 'https://www.googleapis.com/auth/cloud-platform', ...SCOPES].join(',')}`
    );
  }
  if (status === 403 && /SERVICE_DISABLED|has not been used in project|is disabled/i.test(raw)) {
    return (
      `${api}: API が有効化されていないか、割り当てプロジェクトが未設定です。\n  ${raw}\n\n` +
      '  1) Google Cloud Console → APIとサービス → ライブラリ で対象APIを有効化\n' +
      '  2) gcloud auth application-default set-quota-project <PROJECT_ID>'
    );
  }
  if (status === 403) {
    return (
      `${api}: 権限がありません（403）。\n  ${raw}\n\n` +
      '  GA4 は「プロパティのアクセス管理」で閲覧者以上、\n' +
      '  Search Console は「設定 → ユーザーと権限」で制限付き以上の権限が必要です。'
    );
  }
  if (status === 401) {
    return `${api}: 認証が失効しています（401）。\n  ${raw}\n\n  gcloud auth application-default login を再実行してください。`;
  }
  if (status === 404) {
    return (
      `${api}: 対象が見つかりません（404）。\n  ${raw}\n\n` +
      '  GA4_PROPERTY_ID / SEARCH_CONSOLE_SITE_URL の値を確認してください。\n' +
      '  Search Console は登録形式（sc-domain: か https:// か、末尾スラッシュ）が完全一致している必要があります。'
    );
  }
  return `${api}: ${raw}`;
}
