#!/usr/bin/env tsx
// Fetches FBA Inventory report for GB and DE and writes SKU/FNSKU/ASIN
// linking data to the "Linking" tab of the Automations sheet.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Linking';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'GB' },
  { id: 'A1PA6795UKMFR9', label: 'DE' },
];

const HEADERS = ['SKU', 'FNSKU', 'ASIN', 'Product Name', 'Condition', 'Price', 'Marketplace Country Code'];

async function main() {
  console.log('Linking → Google Sheets');
  console.log('-----------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const outputRows: (string | number)[][] = [];

  for (let i = 0; i < MARKETPLACES.length; i++) {
    const market = MARKETPLACES[i]!;
    console.log(`Fetching FBA Inventory report for ${market.label}...`);

    const report = await runReport(spClient, {
      reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
      marketplaceIds: [market.id],
    });

    const rows = parseTsv(report.rawText);
    console.log(`  ${rows.length} rows`);

    for (const row of rows) {
      outputRows.push([
        row['sku'] ?? '',
        row['fnsku'] ?? '',
        row['asin'] ?? '',
        row['product-name'] ?? '',
        row['condition'] ?? '',
        parseFloat(row['your-price'] ?? '') || '',
        market.label,
      ]);
    }

    if (i < MARKETPLACES.length - 1) {
      console.log('  Waiting 70s before next marketplace (rate limit)...');
      await new Promise(r => setTimeout(r, 70_000));
    }
  }

  console.log(`\nTotal rows: ${outputRows.length}`);
  console.log('Writing to Google Sheets...');

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
