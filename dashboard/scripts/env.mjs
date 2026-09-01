// .dev.vars（KEY=VALUE 形式）を読み込む小さなヘルパー。
// シークレットをシェル履歴に残さずに済むよう、ローカル実行系のスクリプトで共有する。
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDevVars(file = path.join(ROOT, '.dev.vars')) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** .dev.vars → 環境変数 の順で解決（環境変数が優先） */
export function resolveEnv() {
  return { ...loadDevVars(), ...process.env };
}

/**
 * .dev.vars のキーを追加・更新する（既存のコメントや並びは保持）。
 * 長いトークンを手で貼らずに済むよう、各スクリプトから呼び出す。
 */
export function upsertDevVars(updates, file = path.join(ROOT, '.dev.vars')) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const remaining = { ...updates };

  const next = lines.map((line) => {
    const m = /^(\s*)(#\s*)?([A-Z0-9_]+)\s*=/.exec(line);
    if (!m) return line;
    const key = m[3];
    if (!(key in remaining)) return line;
    const value = remaining[key];
    delete remaining[key];
    return key + '=' + value;      // コメントアウトされていた行も有効化する
  });

  for (const [key, value] of Object.entries(remaining)) next.push(key + '=' + value);
  const body = next.join('\n').replace(/\n{3,}$/, '\n');
  writeFileSync(file, body.endsWith('\n') ? body : body + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch (_e) { /* 権限変更できなくても続行 */ }
  return file;
}
