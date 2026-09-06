/**
 * ネットスーパー収集ツールのパス解決。
 *
 * 方針:
 *  - ログインセッション（Cookie / localStorage）は **リポジトリの外** に 0600 で置く。
 *  - 収集結果は reports/ 配下（.gitignore 済み）に置く。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const expandHome = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));

/** 設定ファイル（カテゴリURL・セレクタ）。既定はリポジトリ直下、.gitignore 済み。 */
export function configPath() {
  const explicit = process.env.NETSUPER_CONFIG;
  if (!blank(explicit)) return expandHome(explicit);
  return path.join(REPO_ROOT, 'netsuper.config.json');
}

export function configExamplePath() {
  return path.join(REPO_ROOT, 'netsuper.config.example.json');
}

/**
 * ログインセッションの保存先。
 * リポジトリ内を指定された場合は事故防止のため拒否する。
 */
export function sessionPath() {
  const explicit = process.env.NETSUPER_SESSION;
  const file = blank(explicit)
    ? path.join(os.homedir(), '.config', 'pass-netsuper', 'session.json')
    : expandHome(explicit);
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(
      `ログインセッションの保存先がリポジトリ内です（${file}）。\n` +
        '  誤ってコミットする事故を防ぐため、リポジトリ外のパスを NETSUPER_SESSION に指定してください。'
    );
  }
  return file;
}

/** 収集結果の出力先ルート（reports/netsuper/）。 */
export function outputRoot() {
  const explicit = process.env.NETSUPER_OUTPUT_DIR;
  return blank(explicit) ? path.join(REPO_ROOT, 'reports', 'netsuper') : expandHome(explicit);
}

/** reports/netsuper/<slug>/ を作って返す。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** YYYY-MM-DD（ローカル時刻） */
export function today(d = new Date()) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export function relativeToCwd(p) {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
}
