#!/usr/bin/env node
/**
 * .env を対話形式で作成・更新する。
 *
 *   npm run analytics:setup
 *
 * テキストエディタで隠しファイルを開かなくても設定できるようにするためのコマンド。
 * 既存の .env がある場合は現在の値を初期値として引き継ぐ。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { main, log, section } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/env.mjs';

const ENV_PATH = path.join(REPO_ROOT, '.env');

/** 既存の .env を KEY=VALUE として読む（コメント・空行は無視） */
function readExistingEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}

/** 表示用に値を伏せる */
function mask(v) {
  if (!v) return '';
  return v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 4)}${'*'.repeat(8)}${v.slice(-4)}`;
}

const FIELDS = [
  {
    key: 'GOOGLE_OAUTH_CLIENT_ID',
    label: 'OAuth クライアント ID',
    help:
      'Google Cloud Console →「APIとサービス」→「認証情報」→\n' +
      '  「+ 認証情報を作成」→「OAuth クライアント ID」→ 種類「デスクトップ アプリ」\n' +
      '  で作成すると表示されます（xxxxx.apps.googleusercontent.com の形）',
    secret: false,
    validate(v) {
      if (!v) return '必須です。';
      if (!v.includes('.apps.googleusercontent.com')) {
        return '「xxxxx.apps.googleusercontent.com」の形式で入力してください。';
      }
      return null;
    },
  },
  {
    key: 'GOOGLE_OAUTH_CLIENT_SECRET',
    label: 'OAuth クライアント シークレット',
    help: '同じ画面に表示される「クライアント シークレット」です',
    secret: true,
    validate(v) {
      return v ? null : '必須です。';
    },
  },
  {
    key: 'GA4_PROPERTY_ID',
    label: 'GA4 プロパティID',
    help:
      'GA4 → 管理 →「プロパティ設定」→ 右上の「プロパティID」（数字9〜10桁）\n' +
      '  ※「G-」で始まる測定IDではありません',
    secret: false,
    validate(v) {
      if (!v) return '必須です。';
      if (/^G-/i.test(v)) {
        return 'それは測定IDです。GA4 → 管理 → プロパティ設定 → 右上の「プロパティID」（数字のみ）を入力してください。';
      }
      if (!/^\d+$/.test(v)) return '数字のみで入力してください。';
      return null;
    },
  },
  {
    key: 'SEARCH_CONSOLE_SITE_URL',
    label: 'Search Console のプロパティ',
    help:
      'Search Console の登録形式のまま入力してください\n' +
      '    ドメインプロパティ : sc-domain:example.com\n' +
      '    URLプレフィックス  : https://example.com/  ← 末尾のスラッシュまで必要',
    secret: false,
    validate(v) {
      if (!v) return '必須です。';
      if (v.startsWith('sc-domain:')) return null;
      if (!/^https?:\/\//.test(v)) {
        return '「sc-domain:example.com」または「https://example.com/」の形式で入力してください。';
      }
      if (!v.endsWith('/')) return `末尾にスラッシュが必要です。「${v}/」ではありませんか？`;
      return null;
    },
  },
  {
    key: 'SITE_ORIGIN',
    label: 'サイトの公開URL（任意・省略可）',
    help:
      'GA4 と Search Console のページを突き合わせるために使います\n' +
      '  省略すると Search Console のプロパティから自動推定します（例: https://example.com）',
    optional: true,
    secret: false,
    validate(v) {
      if (!v) return null;
      if (!/^https?:\/\//.test(v)) return '「https://」から始めてください。';
      return null;
    },
  },
];

/** 既存の .env の中で、対話で扱わないキーはそのまま残す */
function renderEnvFile(values, existing) {
  const managed = new Set(FIELDS.map((f) => f.key));
  const extras = Object.entries(existing).filter(([k]) => !managed.has(k) && values[k] === undefined);

  const quote = (v) => (/[\s#"']/.test(v) ? `"${v.replaceAll('"', '\\"')}"` : v);

  let out = '';
  out += '# GA4 / Search Console 分析ツールの設定\n';
  out += '# npm run analytics:setup で生成 / 更新されます。\n';
  out += '# このファイルは .gitignore 済みです（コミットされません）。\n\n';
  out += '# ---- 認証（ブラウザ認証 / OAuth） ----\n';
  out += `GOOGLE_OAUTH_CLIENT_ID=${quote(values.GOOGLE_OAUTH_CLIENT_ID ?? '')}\n`;
  out += `GOOGLE_OAUTH_CLIENT_SECRET=${quote(values.GOOGLE_OAUTH_CLIENT_SECRET ?? '')}\n\n`;
  out += '# ---- 分析対象 ----\n';
  out += `GA4_PROPERTY_ID=${quote(values.GA4_PROPERTY_ID ?? '')}\n`;
  out += `SEARCH_CONSOLE_SITE_URL=${quote(values.SEARCH_CONSOLE_SITE_URL ?? '')}\n`;
  out += `SITE_ORIGIN=${quote(values.SITE_ORIGIN ?? '')}\n`;

  if (extras.length) {
    out += '\n# ---- その他（既存の設定を引き継ぎ） ----\n';
    for (const [k, v] of extras) out += `${k}=${quote(v)}\n`;
  }
  return out;
}

await main(async () => {
  const existing = readExistingEnv();
  const rl = readline.createInterface({ input, output });

  section('分析ツールの初期設定');
  log('  質問に答えると .env を作成します。');
  log('  Enter だけを押すと [ ] 内の現在値をそのまま使います。');
  log('  途中でやめる場合は Ctrl+C。\n');
  if (fs.existsSync(ENV_PATH)) log(`  既存の .env を読み込みました: ${ENV_PATH}\n`);

  // 入力が閉じられた（Ctrl+D、パイプ入力の終端）場合に無限待機しないようにする
  const CLOSED = Symbol('closed');
  const onClosed = new Promise((resolve) => rl.once('close', () => resolve(CLOSED)));
  const ask = async (prompt) => {
    const answer = await Promise.race([rl.question(prompt), onClosed]);
    if (answer === CLOSED) {
      throw new Error(
        '入力が中断されました。設定は保存していません。\n' +
          '  `npm run analytics:setup` を対話的に実行し直すか、\n' +
          '  .env.example をコピーして .env を直接編集してください。'
      );
    }
    return answer;
  };

  const values = {};
  try {
    for (const field of FIELDS) {
      const current = existing[field.key] ?? '';
      log(`\n■ ${field.label}`);
      log(`  ${field.help}`);

      for (;;) {
        const shown = current ? `  [現在: ${field.secret ? mask(current) : current}]` : field.optional ? '  [空欄可]' : '';
        const answer = (await ask(`> ${shown ? `${shown}\n> ` : ''}`)).trim();
        const value = answer === '' ? current : answer;

        const error = field.validate(value);
        if (error) {
          log(`  ⚠️  ${error}`);
          continue;
        }
        values[field.key] = value;
        break;
      }
    }
  } finally {
    rl.close();
  }

  fs.writeFileSync(ENV_PATH, renderEnvFile(values, existing), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    // Windows など chmod が効かない環境では無視する
  }

  section('保存しました');
  log(`  ${ENV_PATH}\n`);
  log('  次のコマンドを順に実行してください:\n');
  log('    npm run analytics:login    ブラウザで Google にログイン');
  log('    npm run analytics:doctor   設定と疎通の確認\n');
});
