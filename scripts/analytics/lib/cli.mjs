/**
 * スクリプト共通の実行ラッパ。エラーを日本語で整形して終了コードを返す。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './env.mjs';

/**
 * このモジュールが `node xxx.mjs` として直接起動されたかを判定する。
 * report.mjs が ga4.mjs / search-console.mjs を import して関数だけを使うため、
 * import されただけで CLI 本体が走らないようにする。
 */
export function isEntrypoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(fileURLToPath(importMetaUrl)) === path.resolve(entry);
}

export function log(...args) {
  if (!process.argv.includes('--quiet')) console.log(...args);
}

export function warn(...args) {
  console.warn(...args);
}

export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    console.error('');
    if (err instanceof ConfigError) {
      console.error('【設定エラー】');
      console.error(err.message);
      console.error('\n  .env の設定は .env.example を参照してください。');
    } else {
      console.error('【エラー】');
      console.error(err?.message ?? err);
      if (process.env.ANALYTICS_DEBUG && err?.stack) console.error(`\n${err.stack}`);
    }
    console.error('');
    process.exitCode = 1;
  }
}

export function section(title) {
  log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
}
