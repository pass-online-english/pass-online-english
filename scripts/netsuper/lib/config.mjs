/**
 * netsuper.config.json の読み書きと検証。
 *
 * 収集対象（カテゴリURL）と、判明していればセレクタを持つ。
 * セレクタは任意 —— 未設定なら extract.mjs の自動判定が使われる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { configPath, configExamplePath, relativeToCwd } from './paths.mjs';

export class ConfigError extends Error {}

export const DEFAULT_CONFIG = {
  store: '',
  entryUrl: '',
  waitMs: 1500,
  // 画面を出さないブラウザでは中身を描画しないサイトがあるため、常時表示に切り替えられる
  headed: false,
  // 商品データが載っている通信を選ぶための正規表現（省略時は graphql / api を含むURL）
  apiPattern: '',
  categories: [],
  selectors: { item: '', name: '', price: '' },
  pagination: { mode: 'scroll', nextSelector: '', queryParam: 'page', maxPages: 20 },
};

export function configExists(file = configPath()) {
  return fs.existsSync(file);
}

export function loadConfig({ requireCategories = true, file = configPath() } = {}) {
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `設定ファイルが見つかりません: ${relativeToCwd(file)}\n` +
        `  ${relativeToCwd(configExamplePath())} をコピーして、店舗のカテゴリURLを書いてください。\n` +
        '    cp netsuper.config.example.json netsuper.config.json'
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`設定ファイルの JSON が壊れています（${relativeToCwd(file)}）: ${err.message}`);
  }

  const cfg = {
    ...DEFAULT_CONFIG,
    ...raw,
    selectors: { ...DEFAULT_CONFIG.selectors, ...(raw.selectors || {}) },
    pagination: { ...DEFAULT_CONFIG.pagination, ...(raw.pagination || {}) },
  };

  cfg.categories = (cfg.categories || []).filter((c) => c && c.url && !c.disabled);
  for (const c of cfg.categories) {
    if (!/^https?:\/\//.test(c.url)) {
      throw new ConfigError(`categories の url は http(s) で始めてください（現在: ${c.url}）`);
    }
    if (!c.name) c.name = new URL(c.url).pathname;
  }
  if (requireCategories && !cfg.categories.length) {
    throw new ConfigError(
      `収集対象のカテゴリが1件もありません（${relativeToCwd(file)}）。\n` +
        '  ネットスーパーで見たい売場を開き、そのURLを categories に追加してください。'
    );
  }

  const modes = new Set(['none', 'scroll', 'next', 'query']);
  if (!modes.has(cfg.pagination.mode)) {
    throw new ConfigError(`pagination.mode は ${[...modes].join(' | ')} のいずれかです（現在: ${cfg.pagination.mode}）`);
  }
  // 空文字は「未設定」として扱う（自動判定に回す）
  for (const k of ['item', 'name', 'price']) {
    if (!cfg.selectors[k]) delete cfg.selectors[k];
  }
  return cfg;
}

export function saveConfig(cfg, file = configPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return file;
}

/** probe の結果からセレクタだけを書き戻す。 */
export function updateSelectors(selectors, file = configPath()) {
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ...DEFAULT_CONFIG };
  cfg.selectors = { ...(cfg.selectors || {}), ...selectors };
  return saveConfig(cfg, file);
}
