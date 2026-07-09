#!/usr/bin/env tsx
// Temporary debug script — prints the raw GET_V2_SELLER_PERFORMANCE_REPORT
// JSON for GB so we can find the correct field for AHR score.
// Run: npx tsx src/cli/debug-perf-report.ts
// Delete after use.

import 'dotenv/config';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport } from '../lib/sp-api/reports.js';

async function main() {
  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  console.log('Requesting GET_V2_SELLER_PERFORMANCE_REPORT for GB...');
  const report = await runReport(spClient, {
    reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT',
    marketplaceIds: ['A1F83G8C2ARO7P'],
  });

  console.log('\n--- RAW REPORT JSON ---\n');
  try {
    // Pretty-print so it's readable in the logs
    const parsed = JSON.parse(report.rawText);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(report.rawText);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
