#!/usr/bin/env node
/**
 * GA4 の dimension / metric 名を、あなたのプロパティのメタデータAPIから
 * 直接取得して検証する。
 *
 * ドキュメントの記憶や古い記事に頼らず、「今このプロパティで実際に使える名前」
 * を確認するためのコマンド。廃止済み（deprecatedApiNames に載っている）名称を
 * 使っていればここで検出される。
 *
 *   npm run analytics:schema
 */
import { main, log, section } from './lib/cli.mjs';
import { getMetadata } from './lib/ga4-client.mjs';
import { allFieldNames, GA4_REPORTS, GA4_GEO_CROSS_REPORTS } from './lib/ga4-fields.mjs';

await main(async () => {
  const meta = await getMetadata();

  const dimIndex = new Map();
  const dimDeprecated = new Map(); // 旧名 -> 新名
  for (const d of meta.dimensions ?? []) {
    dimIndex.set(d.apiName, d);
    for (const old of d.deprecatedApiNames ?? []) dimDeprecated.set(old, d.apiName);
  }
  const metIndex = new Map();
  const metDeprecated = new Map();
  for (const m of meta.metrics ?? []) {
    metIndex.set(m.apiName, m);
    for (const old of m.deprecatedApiNames ?? []) metDeprecated.set(old, m.apiName);
  }

  section('プロパティのメタデータ');
  log(`  dimension: ${dimIndex.size}件 / metric: ${metIndex.size}件`);
  if (dimDeprecated.size || metDeprecated.size) {
    log(`  廃止済み別名: dimension ${dimDeprecated.size}件 / metric ${metDeprecated.size}件`);
  }

  const used = allFieldNames();
  const problems = [];

  const check = (name, index, deprecated, kind) => {
    if (index.has(name)) return { name, status: 'ok' };
    if (deprecated.has(name)) {
      const replacement = deprecated.get(name);
      problems.push(`${kind} "${name}" は廃止済みです。"${replacement}" を使ってください。`);
      return { name, status: 'deprecated', replacement };
    }
    problems.push(`${kind} "${name}" はこのプロパティで利用できません。`);
    return { name, status: 'missing' };
  };

  section('使用しているディメンション');
  for (const name of used.dimensions) {
    const r = check(name, dimIndex, dimDeprecated, 'dimension');
    const mark = r.status === 'ok' ? '✅' : r.status === 'deprecated' ? '⚠️ ' : '❌';
    const note =
      r.status === 'ok'
        ? dimIndex.get(name).uiName ?? ''
        : r.status === 'deprecated'
          ? `→ ${r.replacement}`
          : '利用不可';
    log(`  ${mark} ${name.padEnd(34)} ${note}`);
  }

  section('使用している指標');
  for (const name of used.metrics) {
    const r = check(name, metIndex, metDeprecated, 'metric');
    const mark = r.status === 'ok' ? '✅' : r.status === 'deprecated' ? '⚠️ ' : '❌';
    const note =
      r.status === 'ok'
        ? metIndex.get(name).uiName ?? ''
        : r.status === 'deprecated'
          ? `→ ${r.replacement}`
          : '利用不可';
    log(`  ${mark} ${name.padEnd(34)} ${note}`);
  }

  section('カスタム定義（カスタムディメンション / 指標）');
  const custom = [
    ...(meta.dimensions ?? []).filter((d) => d.customDefinition).map((d) => `dimension  ${d.apiName}  (${d.uiName})`),
    ...(meta.metrics ?? []).filter((m) => m.customDefinition).map((m) => `metric     ${m.apiName}  (${m.uiName})`),
  ];
  if (custom.length) custom.forEach((c) => log(`  ・ ${c}`));
  else log('  カスタム定義は登録されていません。');

  section('レポート定義');
  for (const r of [...GA4_REPORTS, ...GA4_GEO_CROSS_REPORTS]) {
    const dims = r.dimensions.length ? r.dimensions.join(' × ') : '（なし）';
    log(`  ${r.key.padEnd(30)} ${dims}`);
  }

  section('結果');
  if (problems.length === 0) {
    log('  使用中の名称はすべてこのプロパティで有効です。廃止済みの名称は使っていません。\n');
  } else {
    problems.forEach((p) => log(`  ⚠️  ${p}`));
    log(
      '\n  実行時は scripts/analytics/lib/ga4-client.mjs のフォールバックで自動的に代替名へ' +
        '\n  置き換わりますが、恒久対応として lib/ga4-fields.mjs の定義を更新してください。\n'
    );
  }
});
