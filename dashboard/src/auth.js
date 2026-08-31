// 認証(要件21)。
// 1) Cloudflare Access の JWT を JWKS で署名検証（iPhone / Mac 用）
// 2) デバイストークン Cookie（Fire TV 用。SSOログインが現実的でないため）
// どちらも通らなければ 401。両方未設定なら 503（フェイルオープンしない）。

const TOKEN_COOKIE = 'hd_device';
const ACCESS_COOKIE = 'CF_Authorization';
const TOKEN_MAX_AGE = 60 * 60 * 24 * 365; // 1年

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** タイミング攻撃を避けるための固定時間比較 */
export function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function b64urlToBytes(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson(input) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

function normalizeTeamDomain(value) {
  let d = String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!d) return '';
  if (!d.includes('.')) d = d + '.cloudflareaccess.com';
  return d;
}

async function getJwks(teamDomain, store) {
  const key = 'jwks:' + teamDomain;
  const cached = await store.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const res = await fetch('https://' + teamDomain + '/cdn-cgi/access/certs');
  if (!res.ok) throw new Error('JWKS取得に失敗しました (' + res.status + ')');
  const body = await res.json();
  const keys = body.keys || [];
  await store.put(key, { keys, expiresAt: Date.now() + 60 * 60 * 1000 }, 3600);
  return keys;
}

/** Cloudflare Access の JWT を検証し、payload を返す */
export async function verifyAccessJwt(token, { teamDomain, aud, store }) {
  const segments = String(token || '').split('.');
  if (segments.length !== 3) throw new Error('JWTの形式が不正です');
  const header = b64urlToJson(segments[0]);
  const payload = b64urlToJson(segments[1]);

  if (header.alg !== 'RS256') throw new Error('未対応の署名アルゴリズムです: ' + header.alg);

  const keys = await getJwks(teamDomain, store);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('署名鍵が見つかりません');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    b64urlToBytes(segments[2]),
    new TextEncoder().encode(segments[0] + '.' + segments[1]),
  );
  if (!valid) throw new Error('JWTの署名検証に失敗しました');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('JWTの有効期限が切れています');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('JWTがまだ有効ではありません');
  if (payload.iss && payload.iss !== 'https://' + teamDomain) throw new Error('発行者が一致しません');
  if (aud) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error('Audienceが一致しません');
  }
  return payload;
}

/**
 * リクエストを認証する。
 * @returns {{ok:true, method:string, email:string|null, setToken?:string} | {ok:false, status:number, message:string}}
 */
export async function authenticate(request, env, config, store) {
  const url = new URL(request.url);
  const cookies = parseCookies(request);
  const deviceToken = env.DASHBOARD_TOKEN || '';
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const aud = env.ACCESS_AUD || '';

  if (!deviceToken && !teamDomain) {
    return {
      ok: false,
      status: 503,
      message: 'DASHBOARD_TOKEN もしくは ACCESS_TEAM_DOMAIN が未設定です。README のセットアップ手順を実行してください。',
    };
  }

  // 1) Cloudflare Access
  const accessJwt = request.headers.get('Cf-Access-Jwt-Assertion') || cookies[ACCESS_COOKIE];
  if (teamDomain && accessJwt) {
    try {
      const payload = await verifyAccessJwt(accessJwt, { teamDomain, aud, store });
      const email = String(payload.email || '').toLowerCase();
      const allow = config.authorizedUsers || [];
      if (allow.length && email && !allow.includes(email)) {
        return { ok: false, status: 403, message: 'このアカウントには閲覧権限がありません: ' + email };
      }
      return { ok: true, method: 'access', email: email || null };
    } catch (e) {
      // Access の検証に失敗してもデバイストークンでの認証は試す
      if (!deviceToken) {
        return { ok: false, status: 401, message: 'Cloudflare Access の検証に失敗しました: ' + e.message };
      }
    }
  }

  // 2) デバイストークン
  if (deviceToken) {
    const queryToken = url.searchParams.get('token');
    if (queryToken && safeEqual(queryToken, deviceToken)) {
      return { ok: true, method: 'device-token', email: null, setToken: deviceToken };
    }
    if (cookies[TOKEN_COOKIE] && safeEqual(cookies[TOKEN_COOKIE], deviceToken)) {
      return { ok: true, method: 'device-cookie', email: null };
    }
    const bearer = request.headers.get('Authorization');
    if (bearer && bearer.startsWith('Bearer ') && safeEqual(bearer.slice(7), deviceToken)) {
      return { ok: true, method: 'bearer', email: null };
    }
  }

  return { ok: false, status: 401, message: '認証が必要です。' };
}

export function deviceCookieHeader(token) {
  return TOKEN_COOKIE + '=' + encodeURIComponent(token)
    + '; Path=/; Max-Age=' + TOKEN_MAX_AGE
    + '; HttpOnly; Secure; SameSite=Lax';
}

export { TOKEN_COOKIE };
