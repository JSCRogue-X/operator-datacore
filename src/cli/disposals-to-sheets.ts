#!/usr/bin/env tsx
// Fetches FBA Removal Order Detail report (last 30 days) and appends
// new disposal rows to the "Disposals Data" tab of Disposals V2.3.
// Deduplicates by Order ID + SKU so re-runs never create duplicates.
// After appending, reads the computed EUR>GBP value from column J and
// writes it as a static number into column P (Cost Static).
// Run: npx tsx src/cli/disposals-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1GC9MZxpMhmhw8QGi8-dAhXsruwbBhpsQEaWR9RLdMZE';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Disposals Data';

const MARKETPLACE_IDS = [
  'A1F83G8C2ARO7P', // GB
  'A1PA6795UKMFR9', // DE
  'A13V1IB3VIYZZH', // FR
  'APJ6JRA9NG5V4',  // IT
  'A1RKKUPIHCS9HS', // ES
  'A1805IZSGTT6HS', // NL
  'A28R8C7NBKEWEA', // IE
  'AMEN7PMS3EDWL',  // BE
  'A2NODRKZP88ZB9', // SE
];

// Google Sheets date serial: days since 30 Dec 1899
const SHEETS_EPOCH = new Date(Date.UTC(1899, 11, 30)).getTime();
function toSheetDate(dateStr: string): number | string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return Math.round((d.getTime() - SHEETS_EPOCH) / 86400000);
}

const HEADERS = [
  'Request Date',
  'Order ID',
  'Order Status',
  'SKU',
  'FNSKU',
  'Requested Quantity',
  'Disposed Quantity',
  'Removal Fee',
  'Currency',
];

async function main() {
  console.log('Disposals → Google Sheets');
  console.log('-------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  console.log('Fetching Removal Order Detail report (last 30 days)...');
  const dataEndTime = new Date();
  const dataStartTime = new Date(dataEndTime.getTime() - 30 * 24 * 60 * 60 * 1000);
  const report = await runReport(spClient, {
    reportType: 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA',
    marketplaceIds: MARKETPLACE_IDS,
    dataStartTime,
    dataEndTime,
  });

  const rows = parseTsv(report.rawText);
  console.log(`  ${rows.length} removal order rows fetched`);

  const filtered = rows.filter(row =>
    (row['order-status'] ?? '').toLowerCase() === 'completed' &&
    (parseInt(row['disposed-quantity'] ?? '0', 10) || 0) > 0,
  );
  console.log(`  ${filtered.length} rows after filtering (Completed, disposed > 0)`);

  const outputRows = filtered.map(row => [
    toSheetDate(row['request-date'] ?? ''),
    row['order-id'] ?? '',
    row['order-status'] ?? '',
    row['sku'] ?? '',
    row['fnsku'] ?? '',
    parseInt(row['requested-quantity'] ?? '0', 10) || 0,
    parseInt(row['disposed-quantity'] ?? '0', 10) || 0,
    parseFloat(row['removal-fee'] ?? '0') || 0,
    row['currency'] ?? '',
  ]);

  // Sort by Request Date ascending
  outputRows.sort((a, b) => {
    const av = typeof a[0] === 'number' ? a[0] : 0;
    const bv = typeof b[0] === 'number' ? b[0] : 0;
    return av - bv;
  });

  // ── Google Sheets ──────────────────────────────────────────────────────
  console.log('\nConnecting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  let sheetId: number;

  if (!existing) {
    // First ever run — create tab and write header
    console.log(`  Creating "${TAB_NAME}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        }],
      },
    });
  } else {
    sheetId = existing.properties?.sheetId ?? 0;
  }

  // Read existing rows for deduplication (key: Order ID + SKU)
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A:I`,
  });
  const existingRows = existingData.data.values ?? [];
  const existingKeys = new Set<string>();
  for (let i = 1; i < existingRows.length; i++) {
    const r = existingRows[i];
    const orderId = String(r?.[1] ?? '').trim();
    const sku     = String(r?.[3] ?? '').trim();
    if (orderId) existingKeys.add(`${orderId}|${sku}`);
  }
  console.log(`  ${existingRows.length > 1 ? existingRows.length - 1 : 0} existing row(s) in sheet.`);

  // Filter to only rows not already present
  const newRows = outputRows.filter(row => {
    const key = `${row[1]}|${row[3]}`;
    return !existingKeys.has(key);
  });

  if (newRows.length === 0) {
    console.log('  No new disposals to append — sheet is already up to date.');
    return;
  }
  console.log(`  ${newRows.length} new row(s) to append (${outputRows.length - newRows.length} duplicate(s) skipped).`);

  // Append new rows to A:I
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: newRows },
  });

  // Row positions for the newly appended data (1-indexed for range strings)
  const firstNewRow   = existingRows.length + 1; // e.g. if 1074 rows existed, new data starts at 1075
  const lastNewRow    = firstNewRow + newRows.length - 1;

  // Apply date format to Request Date column (A) for new rows
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex:    existingRows.length,           // 0-indexed
            endRowIndex:      existingRows.length + newRows.length,
            startColumnIndex: 0,
            endColumnIndex:   1,
          },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      }],
    },
  });

  // Wait 3 seconds for Sheets to compute the column J formula (EUR>GBP) on the new rows
  console.log('  Waiting for column J formulas to compute...');
  await new Promise(r => setTimeout(r, 3000));

  // Read computed EUR>GBP values from column J for the new rows
  const jResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!J${firstNewRow}:J${lastNewRow}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const jData = jResp.data.values ?? [];

  if (jData.length > 0) {
    // Write those values as static numbers into column P (Cost Static)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!P${firstNewRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: jData },
    });
    console.log(`  Column J → P (Cost Static) copied for ${jData.length} row(s).`);
  } else {
    console.log('  Warning: column J returned no values — Cost Static not written. Formulas may not have computed yet.');
  }

  console.log(`\n  Done — ${newRows.length} new row(s) appended to "${TAB_NAME}".`);
  console.log(`\nView: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => { console.error(err); process.exit(1); });
