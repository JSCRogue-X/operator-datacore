#!/usr/bin/env tsx
// Fetches FBA Removal Order Detail report and writes disposal data to the
// "Disposals" tab of the Automations sheet. Overwrites each run.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Disposals';

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

  console.log('Fetching Removal Order Detail report...');
  const dataStartTime = new Date('2025-01-01T00:00:00Z');
  const dataEndTime = new Date();
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
  outputRows.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')));

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

  // Apply date formatting to Request Date column (A)
  if (outputRows.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: outputRows.length + 1, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        }],
      },
    });
  }

  console.log(`  Done — ${outputRows.length} rows written to "${TAB_NAME}"`);
  console.log('\nView: https://docs.google.com/spreadsheets/d/1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
