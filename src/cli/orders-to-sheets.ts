#!/usr/bin/env tsx
// Fetches last 14 days of orders across all 9 EU marketplaces and writes to
// the "All Orders 14 Days" tab of the IPI sheet. Overwrites each run.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'All Orders 14 Days';

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

const COUNTRY_NAMES: Record<string, string> = {
  GB: 'United Kingdom', DE: 'Germany', FR: 'France', IT: 'Italy',
  ES: 'Spain', NL: 'Netherlands', IE: 'Ireland', BE: 'Belgium', SE: 'Sweden',
};

const HEADERS = [
  'Order Date & Time',
  'Amazon Order Status',
  'Amazon Order ID',
  'ASIN',
  'Country Name',
  'Currency',
  'Fulfillment Channel',
  'Ordered quantity',
  'Price',
  'Sales channel',
];

async function main() {
  console.log('Orders → Google Sheets');
  console.log('----------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const dataStartTime = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const dataEndTime = new Date();

  console.log(`Step 1: Fetching orders from ${dataStartTime.toISOString().slice(0, 10)} to ${dataEndTime.toISOString().slice(0, 10)}...`);

  const report = await runReport(spClient, {
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
    marketplaceIds: MARKETPLACE_IDS,
    dataStartTime,
    dataEndTime,
  });

  const rows = parseTsv(report.rawText);
  console.log(`  ${rows.length} order lines fetched`);

  const outputRows = rows.filter(row => row['order-status'] !== 'Cancelled').map(row => {
    const countryCode = (row['ship-country'] ?? '').toUpperCase();
    return [
      row['purchase-date'] ?? '',
      row['order-status'] ?? '',
      row['amazon-order-id'] ?? '',
      row['asin'] ?? '',
      COUNTRY_NAMES[countryCode] ?? countryCode,
      row['currency'] ?? '',
      row['fulfillment-channel'] ?? '',
      row['quantity'] ?? '',
      row['item-price'] ?? '',
      row['sales-channel'] ?? '',
    ];
  });

  // Sort by Order Date & Time ascending (earliest first)
  outputRows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

  console.log('\nStep 2: Writing to Google Sheets...');
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

  // Write headers + data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS, ...outputRows] },
  });

  console.log(`  Done — ${outputRows.length} rows written to "${TAB_NAME}"`);
  console.log('\nView: https://docs.google.com/spreadsheets/d/1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
