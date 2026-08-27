/**
 * Google API 認証。
 *
 * 【重要】スコープは読み取り専用のみを要求する。
 * 書き込み系スコープは意図的に一切含めない。トークンが漏れても
 * GA4 / Search Console の設定変更・削除は行えない。
 */
import { google } from 'googleapis';
import { assertCredentialsOutsideRepo, quotaProjectId, ConfigError } from './env.mjs';

/** 読み取り専用スコープ。ここを増やさないこと。 */
export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]);

let cachedClient = null;

export async function getAuthClient() {
  if (cachedClient) return cachedClient;

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

/** 認証情報の出所を表示用に説明する（値そのものは出さない）。 */
export function describeCredentialSource() {
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
    '  ADC（ユーザー認証）で設定する手順:\n' +
    '    1) gcloud auth application-default login \\\n' +
    `         --scopes=${['openid', 'https://www.googleapis.com/auth/cloud-platform', ...SCOPES].join(',')}\n` +
    '    2) gcloud auth application-default set-quota-project <PROJECT_ID>\n\n' +
    '  サービスアカウント鍵を使う場合:\n' +
    '    .env の GOOGLE_APPLICATION_CREDENTIALS に、リポジトリ外の鍵ファイルの絶対パスを設定してください。'
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
