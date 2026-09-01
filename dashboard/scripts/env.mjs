// .dev.vars（KEY=VALUE 形式）を読み込む小さなヘルパー。
// シークレットをシェル履歴に残さずに済むよう、ローカル実行系のスクリプトで共有する。
import { readFileSync, existsSync } from 'node:fs';
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
