#!/usr/bin/env tsx
// Downloads Manage FBA Inventory report from SP-API and writes it to a Google Sheet.
// Report type: GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA (same file as Seller Central download)

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID ?? '1G2wv13Tl5p2-4IfeTaEC8jFf54_GUn80c_HkZy-an04';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'UK' },
  { id: 'A1PA6795UKMFR9', label: 'DE' },
];

async function main() {
  console.log('FBA Inventory → Google Sheets');
  console.log('------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  // 1. Download report for each marketplace and combine rows
  console.log('Step 1: Downloading Manage FBA Inventory reports from Amazon...');

  let headers: string[] = [];
  const allRows: string[][] = [];

  for (const market of MARKETPLACES) {
    console.log(`  Requesting ${market.label} report...`);
    const report = await runReport(spClient, {
      reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
      marketplaceIds: [market.id],
    });

    const lines = report.rawText.replace(/\r\n/g, '\n').trim().split('\n');
    const marketHeaders = lines[0]!.split('\t');
    const marketRows = lines.slice(1).map(l => l.split('\t'));

    // Use headers from first marketplace; insert marketplace column after snapshot-date
    if (headers.length === 0) {
      headers = [marketHeaders[0]!, 'marketplace', ...marketHeaders.slice(1)];
    }

    for (const row of marketRows) {
      allRows.push([row[0]!, market.label, ...row.slice(1)]);
    }

    console.log(`    ${marketRows.length} rows (${marketHeaders.length} columns)`);

    // Wait 70s between reports to respect rate limit
    if (market !== MARKETPLACES[MARKETPLACES.length - 1]) {
      console.log('  Waiting 70s before next report (rate limit)...');
      await new Promise(r => setTimeout(r, 70_000));
    }
  }

  console.log(`  Total: ${allRows.length} rows across UK + DE`);

  // 2. Write to Google Sheets
  console.log('Step 2: Writing to Google Sheet...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Get actual tab name
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetProps = spreadsheet.data.sheets?.[0].properties;
  const sheetId = sheetProps?.sheetId ?? 0;
  const sheetTitle = sheetProps?.title ?? 'Sheet1';
  console.log(`  Tab: "${sheetTitle}"`);

  // Clear and resize sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { rowCount: allRows.length + 100, columnCount: headers.length },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ],
    },
  });

  // Write data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers, ...allRows] },
  });

  console.log(`  Done — ${allRows.length} rows written to Google Sheet`);
  console.log('');
  console.log('View your sheet: https://docs.google.com/spreadsheets/d/1G2wv13Tl5p2-4IfeTaEC8jFf54_GUn80c_HkZy-an04/edit');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
