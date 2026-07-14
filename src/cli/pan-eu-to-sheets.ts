#!/usr/bin/env tsx
// pan-eu-to-sheets.ts
// Fetches the GET_PAN_EU_OFFER_STATUS report from Amazon SP-API and writes
// Pan-EU enrolment status per ASIN to the "Pan EU" tab in Google Sheets.
// Overwrites the tab on each run.
// Run: npx tsx src/cli/pan-eu-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { gunzipSync } from 'node:zlib';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv, parseCsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1njxkOOPCPk1RCNJ0kTGpYQ_JTgz5d4wrLU2Uj_bC4vE';
const TAB_NAME       = 'Pan EU';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS = [
  'ASIN',
  'SKU',
  'Title',
  'Pan-EU Status',
  'Enrolment Date',
  'UK Offer',
  'DE Offer',
  'FR Offer',
  'IT Offer',
  'ES Offer',
  'NL Offer',
  'SE Offer',
  'PL Offer',
  'BE Offer',
  'IE Offer',
];

const TSV_MAP: Record<string, string> = {
  'ASIN':              'ASIN',
  'SKU':               'MerchantSKU',
  'Title':             'Title',
  'Pan-EU Status':     'Pan-EU status',
  'Enrolment Date':    'Enrollment Date',
  'UK Offer':          'UK offer status',
  'DE Offer':          'DE offer status',
  'FR Offer':          'FR offer status',
  'IT Offer':          'IT offer status',
  'ES Offer':          'ES offer status',
  'NL Offer':          'NL offer status',
  'SE Offer':          'SE offer status',
  'PL Offer':          'PL offer status',
  'BE Offer':          'BE Offer Status',
  'IE Offer':          'IE Offer Status',
};

const OFFER_COLUMNS = new Set([
  'UK Offer', 'DE Offer', 'FR Offer', 'IT Offer', 'ES Offer',
  'NL Offer', 'SE Offer', 'PL Offer', 'BE Offer', 'IE Offer',
]);

const NO_LISTING_VALUES = new Set(['no listing', 'no offer required', 'hazmat', '']);

async function fetchCachedReport(client: SpApiClient, reportType: string, label: string): Promise<string> {
  const list = await client.request<{ reports: Array<{ reportDocumentId: string; processingEndTime: string }> }>({
    method: 'GET',
    path: '/reports/2021-06-30/reports',
    query: { reportTypes: reportType, processingStatuses: 'DONE', pageSize: '1' },
  });

  const latest = list.payload.reports?.[0];
  if (!latest?.reportDocumentId) throw new Error(`No completed ${label} reports found.`);
  console.log(`  Using ${label} report completed at ${latest.processingEndTime}`);

  const doc = await client.request<{ url: string; compressionAlgorithm?: string }>({
    method: 'GET',
    path: `/reports/2021-06-30/documents/${latest.reportDocumentId}`,
  });

  const fetched = await fetch(doc.payload.url);
  if (!fetched.ok) throw new Error(`${label} document fetch failed: ${fetched.status}`);
  const buf = Buffer.from(await fetched.arrayBuffer());
  return doc.payload.compressionAlgorithm === 'GZIP'
    ? gunzipSync(buf).toString('utf8')
    : buf.toString('utf8');
}

async function fetchListingsRawText(client: SpApiClient): Promise<string> {
  try {
    const result = await runReport(client, {
      reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
      marketplaceIds: ['A1F83G8C2ARO7P'],
      createRetries: 0,
    });
    return result.rawText;
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('429') && !msg.includes('QuotaExceeded') && !msg.includes('rate')) throw err;
    console.warn('  Rate limited on listings report — falling back to most recent completed...');
    return fetchCachedReport(client, 'GET_MERCHANT_LISTINGS_ALL_DATA', 'listings');
  }
}

async function getCurrentSkus(client: SpApiClient): Promise<Set<string>> {
  console.log('  Fetching current active SKUs from listings report...');
  const rawText = await fetchListingsRawText(client);
  const rows = parseTsv(rawText);
  const skus = new Set(rows.map(r => (r['seller-sku'] ?? '').trim()).filter(Boolean));
  console.log(`  Found ${skus.size} current SKUs.`);
  return skus;
}

async function fetchMostRecentReport(client: SpApiClient): Promise<string> {
  if (process.env.FORCE_CACHED === '1') {
    console.log('  FORCE_CACHED set — skipping fresh report creation.');
    return fetchCachedReport(client, 'GET_PAN_EU_OFFER_STATUS', 'Pan-EU');
  }
  try {
    console.log('  Requesting fresh Pan-EU report...');
    const result = await runReport(client, {
      reportType: 'GET_PAN_EU_OFFER_STATUS',
      marketplaceIds: ['A1PA6795UKMFR9'], // DE — Pan-EU FBA is managed from DE marketplace
      createRetries: 0,
    });
    return result.rawText;
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('429') && !msg.includes('QuotaExceeded') && !msg.includes('rate')) throw err;
    console.warn('  Rate limited — falling back to most recent completed Pan-EU report...');
    return fetchCachedReport(client, 'GET_PAN_EU_OFFER_STATUS', 'Pan-EU');
  }
}

async function main() {
  console.log('Pan-EU Status → Google Sheets');
  console.log('------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  console.log('Fetching Pan-EU report...');
  const rawText = await fetchMostRecentReport(spClient);

  const currentSkus = await getCurrentSkus(spClient);

  const allRows = parseCsv(rawText);
  console.log(`  Total rows in report: ${allRows.length}`);

  const activeRows = allRows.filter(row => currentSkus.has((row['MerchantSKU'] ?? '').trim()));
  console.log(`  Rows matching current SKUs: ${activeRows.length}`);


  const outputRows = activeRows.map(row =>
    HEADERS.map(h => {
      const raw = row[TSV_MAP[h]!] ?? '';
      if (OFFER_COLUMNS.has(h)) return NO_LISTING_VALUES.has(raw.trim().toLowerCase()) ? 'No Listing' : 'Listing';
      return raw;
    }),
  );

  console.log('\nWriting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Create tab if it doesn't exist
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  let sheetId: number;

  if (!existing) {
    console.log(`  Creating "${TAB_NAME}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = existing.properties?.sheetId ?? 0;
  }

  // Clear and resize
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { rowCount: outputRows.length + 10, columnCount: HEADERS.length },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS, ...outputRows] },
  });

  console.log(`  Done — ${outputRows.length} rows written to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
