#!/usr/bin/env tsx
// Fetches FBA Customer Returns report (last 30 days) and appends new
// rows to the "Amazon Data" tab of Amazon Returns 3.0. Deduplicates
// by License Plate Number so re-runs never create duplicates.
// Run: npx tsx src/cli/returns-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1914IxosqiCMMQO1-UsePsjaHurB_6g16AQuh-y6TZD0';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Amazon Data';

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
  'Return Date',
  'Order ID',
  'ASIN',
  'Quantity',
  'Fulfilment Centre',
  'Reason',
  'License Plate Number',
  'Customer Comments',
];

async function main() {
  console.log('FBA Customer Returns → Google Sheets');
  console.log('-------------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  console.log('Fetching FBA Customer Returns report (last 30 days)...');
  const dataEndTime = new Date();
  const dataStartTime = new Date(dataEndTime.getTime() - 30 * 24 * 60 * 60 * 1000);
  const report = await runReport(spClient, {
    reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
    marketplaceIds: MARKETPLACE_IDS,
    dataStartTime,
    dataEndTime,
  });

  const rows = parseTsv(report.rawText);
  console.log(`  ${rows.length} return rows fetched`);

  const outputRows = rows.map(row => [
    toSheetDate(row['return-date'] ?? ''),
    row['order-id'] ?? '',
    row['asin'] ?? '',
    parseInt(row['quantity'] ?? '0', 10) || 0,
    row['fulfillment-center-id'] ?? '',
    row['reason'] ?? '',
    row['license-plate-number'] ?? '',
    row['customer-comments'] ?? '',
  ]);

  // Sort by Return Date ascending
  outputRows.sort((a, b) => {
    const aVal = typeof a[0] === 'number' ? a[0] : 0;
    const bVal = typeof b[0] === 'number' ? b[0] : 0;
    return aVal - bVal;
  });

  console.log('\nWriting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  let sheetId: number;

  if (!existing) {
    // First ever run — create tab and write header row
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

  // Read existing data to build dedup set
  // Dedup key: License Plate Number (col G) if present, else "date|orderId|asin"
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A:H`,
  });
  const existingRows = existingData.data.values ?? [];
  const existingKeys = new Set<string>();
  for (let i = 1; i < existingRows.length; i++) {
    const r = existingRows[i];
    const lp = String(r?.[6] ?? '').trim();
    existingKeys.add(lp || `${r?.[0]}|${r?.[1]}|${r?.[2]}`);
  }
  console.log(`  ${existingRows.length > 1 ? existingRows.length - 1 : 0} existing row(s) in sheet.`);

  // Filter to only rows not already in the sheet
  const newRows = outputRows.filter(row => {
    const lp = String(row[6] ?? '').trim();
    const key = lp || `${row[0]}|${row[1]}|${row[2]}`;
    return !existingKeys.has(key);
  });

  if (newRows.length === 0) {
    console.log('  No new returns to append — sheet is already up to date.');
    return;
  }

  // Append new rows
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: newRows },
  });

  // Apply date format to the newly appended Return Date cells (column A)
  const firstNewRowIndex = existingRows.length; // 0-indexed; header is 0
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex:   firstNewRowIndex,
            endRowIndex:     firstNewRowIndex + newRows.length,
            startColumnIndex: 0,
            endColumnIndex:   1,
          },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      }],
    },
  });

  console.log(`  Done — ${newRows.length} new row(s) appended to "${TAB_NAME}" (${outputRows.length - newRows.length} duplicate(s) skipped).`);
  console.log(`\nView: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => { console.error(err); process.exit(1); });
