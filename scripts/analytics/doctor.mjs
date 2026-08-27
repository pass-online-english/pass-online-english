#!/usr/bin/env node
/**
 * 疎通確認。実装した分析スクリプトを動かす前に、
 * 環境変数・認証・API有効化・権限を1つずつ確かめる。
 *
 *   npm run analytics:doctor
 */
import { main, log, section } from './lib/cli.mjs';
import { SCOPES, describeCredentialSource, getAuthClient } from './lib/auth.mjs';
import * as env from './lib/env.mjs';
import { runReport, getMetadata } from './lib/ga4-client.mjs';
import { listSites, queryTotals } from './lib/gsc-client.mjs';
import { resolveRange } from './lib/dates.mjs';

const ok = (m) => log(`  ✅ ${m}`);
const ng = (m) => log(`  ❌ ${m}`);
const info = (m) => log(`  ・ ${m}`);

function mask(v) {
  const s = String(v ?? '');
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(0, s.length - 6))}${s.slice(-3)}`;
}

await main(async () => {
  let failures = 0;

  section('1. 環境変数');
  let propertyId = null;
  let siteUrl = null;
  try {
    propertyId = env.ga4PropertyId();
    ok(`GA4_PROPERTY_ID = ${mask(propertyId)}`);
  } catch (e) {
    ng(e.message);
    failures += 1;
  }
  try {
    siteUrl = env.searchConsoleSiteUrl();
    ok(`SEARCH_CONSOLE_SITE_URL = ${siteUrl}`);
  } catch (e) {
    ng(e.message);
    failures += 1;
  }
  const origin = env.siteOrigin();
  if (origin) ok(`SITE_ORIGIN = ${origin}（GA4とSearch Consoleのページ突き合わせに使用）`);
  else ng('SITE_ORIGIN を推定できませんでした。統合分析の精度が落ちます。');

  info(`GA4 データ確定待ち: ${env.ga4LagDays()}日 / Search Console: ${env.gscLagDays()}日`);
  info(`出力先: ${env.outputDir()}`);

  section('2. 認証');
  const src = describeCredentialSource();
  info(`方式: ${src.kind === 'adc-user' ? 'ADC（ユーザー認証）' : 'サービスアカウント鍵'}`);
  info(`参照先: ${src.detail}`);
  info(`要求スコープ（読み取り専用のみ）:\n     - ${SCOPES.join('\n     - ')}`);
  try {
    const client = await getAuthClient();
    await client.getAccessToken();
    ok('アクセストークンを取得できました');
    if (client.quotaProjectId) info(`割り当てプロジェクト: ${client.quotaProjectId}`);
  } catch (e) {
    ng(e.message);
    failures += 1;
  }

  section('3. GA4 Data API');
  if (propertyId && failures === 0) {
    try {
      const meta = await getMetadata();
      ok(`メタデータ取得成功（dimension ${meta.dimensions?.length ?? 0}件 / metric ${meta.metrics?.length ?? 0}件）`);
    } catch (e) {
      ng(e.message);
      failures += 1;
    }
    try {
      const range = resolveRange({ days: 7, lagDays: env.ga4LagDays() });
      const res = await runReport({
        dimensions: ['date'],
        metrics: ['sessions', 'totalUsers'],
        dateRanges: [range],
        limit: 10,
      });
      const sessions = res.rows.reduce((s, r) => s + (r.sessions ?? 0), 0);
      ok(`直近7日（${range.startDate}〜${range.endDate}）: ${res.rows.length}日分 / sessions 合計 ${sessions}`);
      if (sessions === 0) {
        info('セッションが0件です。計測タグの設置状況、またはプロパティIDをご確認ください。');
      }
    } catch (e) {
      ng(e.message);
      failures += 1;
    }
  } else {
    info('前段のエラーのためスキップしました。');
  }

  section('4. Search Console API');
  if (siteUrl && failures === 0) {
    try {
      const sites = await listSites();
      ok(`アクセス可能なプロパティ: ${sites.length}件`);
      for (const s of sites) info(`${s.siteUrl}  [権限: ${s.permissionLevel}]`);
      const match = sites.find((s) => s.siteUrl === siteUrl);
      if (match) {
        ok(`SEARCH_CONSOLE_SITE_URL は登録形式と一致しています（権限: ${match.permissionLevel}）`);
        if (/Owner/i.test(match.permissionLevel)) {
          info('※ オーナー権限が付与されています。本ツールは読み取りしか行いませんが、権限を「制限付き」に下げても動作します。');
        }
      } else {
        ng(
          `SEARCH_CONSOLE_SITE_URL が上記一覧と一致しません。\n     上の一覧の文字列をそのまま .env にコピーしてください。`
        );
        failures += 1;
      }
    } catch (e) {
      ng(e.message);
      failures += 1;
    }
    try {
      const range = resolveRange({ days: 7, lagDays: env.gscLagDays() });
      const totals = await queryTotals(range);
      ok(
        `直近7日（${range.startDate}〜${range.endDate}）: クリック ${totals.clicks} / 表示 ${totals.impressions} / 平均掲載順位 ${totals.position.toFixed(1)}`
      );
    } catch (e) {
      ng(e.message);
      failures += 1;
    }
  } else {
    info('前段のエラーのためスキップしました。');
  }

  section('結果');
  if (failures === 0) {
    log('  すべての確認項目を通過しました。分析スクリプトを実行できます。\n');
    log('    npm run analytics:ga4     -- --days 28');
    log('    npm run analytics:gsc     -- --days 28');
    log('    npm run analytics:report  -- --days 28\n');
  } else {
    log(`  ${failures}件の問題があります。上のメッセージに従って設定を見直してください。\n`);
    process.exitCode = 1;
  }
});
