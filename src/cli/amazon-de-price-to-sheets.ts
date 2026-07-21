#!/usr/bin/env tsx
// amazon-de-price-to-sheets.ts
// Downloads the FBA Inventory Planning report for the DE marketplace and
// writes SKU, FNSKU, ASIN, Product Name, Condition, Price, and
// Marketplace Country Code to the FBA IH Linking File spreadsheet.
// Run: npx tsx src/cli/amazon-de-price-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1nx56b9f9yGbmDwnT7-yxTWEm19cYu4sOfOsYE73qyhQ';
const TAB_NAME       = '[DO NOT DELETE] Amazon DE Price';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const DE_MARKETPLACE_ID = 'A1PA6795UKMFR9';

const HEADERS = [
  'SKU', 'FNSKU', 'ASIN', 'Product Name', 'Condition', 'Price', 'Marketplace Country Code',
];

async function main() {
  console.log('Amazon DE Price → Google Sheets');
  console.log('--------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region:        env.SP_API_REGION,
    clientId:      env.SP_API_LWA_CLIENT_ID,
    clientSecret:  env.SP_API_LWA_CLIENT_SECRET,
    refreshToken:  env.SP_API_REFRESH_TOKEN,
  });

  console.log('Requesting FBA Inventory Planning report for DE...');
  const report = await runReport(spClient, {
    reportType:     'GET_FBA_INVENTORY_PLANNING_DATA',
    marketplaceIds: [DE_MARKETPLACE_ID],
  });

  const rows = parseTsv(report.rawText);
  console.log(`  ${rows.length} rows received`);

  const outputRows: (string | number)[][] = rows.map(row => {
    const price = parseFloat(row['your-price'] ?? '');
    return [
      row['sku']          ?? '',
      row['fnsku']        ?? '',
      row['asin']         ?? '',
      row['product-name'] ?? '',
      row['condition']    ?? '',
      isNaN(price) ? '' : price,
      'DE',
    ];
  });

  console.log('Writing to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTab = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  let sheetId: number;

  if (!existingTab) {
    console.log(`  Creating "${TAB_NAME}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = existingTab.properties?.sheetId ?? 0;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } }] },
  });

  // Single quotes are required in the range when the tab name contains brackets
  const rangeRef = `'${TAB_NAME}'!A1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range:            rangeRef,
    valueInputOption: 'RAW',
    requestBody:      { values: [HEADERS, ...outputRows] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell:  { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }],
    },
  });

  console.log(`  Done — ${outputRows.length} row(s) written to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
