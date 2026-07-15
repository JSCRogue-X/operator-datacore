#!/usr/bin/env tsx
// debug-paneu-raw.ts
// Fetches the most recently completed GET_PAN_EU_OFFER_STATUS report and
// prints the first 3 lines raw so we can see the actual column headers
// and data format coming from SP-API.
// Run: npx tsx src/cli/debug-paneu-raw.ts

import 'dotenv/config';
import { gunzipSync } from 'node:zlib';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';

async function main() {
  const env = loadEnvForAmazon();
  const client = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const list = await client.request<{ reports: Array<{ reportId: string; reportDocumentId: string; processingEndTime: string; marketplaceIds?: string[] }> }>({
    method: 'GET',
    path: '/reports/2021-06-30/reports',
    query: { reportTypes: 'GET_PAN_EU_OFFER_STATUS', processingStatuses: 'DONE', pageSize: '5' },
  });

  const reports = list.payload.reports ?? [];
  console.log(`Found ${reports.length} completed GET_PAN_EU_OFFER_STATUS report(s):\n`);

  for (const r of reports) {
    console.log(`  Report: ${r.reportId} | Completed: ${r.processingEndTime} | Marketplaces: ${(r.marketplaceIds ?? []).join(', ')}`);
  }

  const latest = reports[0];
  if (!latest?.reportDocumentId) {
    console.log('No completed reports found.');
    return;
  }

  console.log(`\nFetching document for most recent report (${latest.reportId})...`);
  const doc = await client.request<{ url: string; compressionAlgorithm?: string }>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${latest.reportDocumentId}`,
  });

  const fetched = await fetch(doc.payload.url);
  const buf = Buffer.from(await fetched.arrayBuffer());
  const raw = doc.payload.compressionAlgorithm === 'GZIP' ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');

  const lines = raw.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
  console.log(`\nTotal lines in raw file: ${lines.length}`);
  console.log(`\n--- LINE 1 (headers) ---`);
  console.log(lines[0]);
  console.log(`\n--- LINE 2 (first data row) ---`);
  console.log(lines[1]);
  console.log(`\n--- LINE 3 (second data row) ---`);
  console.log(lines[2]);
  console.log(`\n--- FIRST 300 CHARS RAW ---`);
  console.log(JSON.stringify(raw.slice(0, 300)));
}

main().catch(err => { console.error(err); process.exit(1); });
