#!/usr/bin/env tsx
// Fetches FBA Storage Fee Charges report and writes product measurement data
// to the "Measurements" tab of the Automations sheet.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Measurements';

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

const HEADERS = [
  'ASIN',
  'Product Name',
  'Fulfillment Center',
  'Country Code',
  'Longest Side',
  'Median Side',
  'Shortest Side',
  'Measurement Units',
  'Weight',
  'Weight Units',
  'Item Volume',
  'Volume Units',
  'Product Size Tier',
  'Clean Title',
];

// Map display headers to TSV column names from the report
const TSV_COLUMNS = [
  'asin',
  'product-name',
  'fulfillment-center',
  'country-code',
  'longest-side',
  'median-side',
  'shortest-side',
  'measurement-units',
  'weight',
  'weight-units',
  'item-volume',
  'volume-units',
  'product-size-tier',
  'clean-title',
];

// Columns that should be written as numbers
const NUMERIC_COLS = new Set(['longest-side', 'median-side', 'shortest-side', 'weight', 'item-volume']);

function parseVal(col: string, val: string): string | number {
  if (NUMERIC_COLS.has(col)) return parseFloat(val) || 0;
  return val;
}

async function main() {
  console.log('Measurements → Google Sheets');
  console.log('-----------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const dataEndTime = new Date();
  const dataStartTime = new Date(dataEndTime.getTime() - 60 * 24 * 60 * 60 * 1000);

  console.log(`Date range: ${dataStartTime.toISOString().slice(0, 10)} → ${dataEndTime.toISOString().slice(0, 10)}`);
  console.log('Fetching FBA Storage Fee Charges report...');

  const report = await runReport(spClient, {
    reportType: 'GET_FBA_STORAGE_FEE_CHARGES_DATA',
    marketplaceIds: MARKETPLACE_IDS,
    dataStartTime,
    dataEndTime,
  });

  const rows = parseTsv(report.rawText);
  console.log(`  ${rows.length} rows fetched`);

  if (rows.length > 0) {
    console.log(`  Columns in report: ${Object.keys(rows[0]!).join(', ')}`);
  }

  const outputRows = rows.map(row =>
    TSV_COLUMNS.map(col => parseVal(col, row[col] ?? '')),
  );

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
    console.log(`  Creating "${TAB_NAME}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = existing.properties?.sheetId ?? 0;
  }

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

  console.log(`  Done — ${outputRows.length} rows written to "${TAB_NAME}"`);
}

main().catch(err => { console.error(err); process.exit(1); });
