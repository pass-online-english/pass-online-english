import { parseArgs } from 'node:util';

/**
 * 共通CLIオプションの解析。
 * `npm run x -- --days 28` の形で渡されることを想定し、未知のフラグでは落とさない。
 */
export function parseCliArgs(extraOptions = {}) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      days: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      compare: { type: 'string' },
      format: { type: 'string' },
      limit: { type: 'string' },
      out: { type: 'string' },
      'no-compare': { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      ...extraOptions,
    },
    strict: false,
    allowPositionals: true,
  });

  if (values['no-compare']) values.compare = 'none';
  return values;
}

export function parseFormats(raw, fallback = ['json', 'csv', 'md']) {
  if (!raw) return fallback;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s === 'markdown' ? 'md' : s));
  const allowed = new Set(['json', 'csv', 'md']);
  const bad = list.filter((f) => !allowed.has(f));
  if (bad.length) throw new Error(`--format に不正な値があります: ${bad.join(', ')}（json | csv | md）`);
  return list.length ? list : fallback;
}

export function parseLimit(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`--limit は1以上の整数で指定してください（受け取った値: ${raw}）`);
  return n;
}
