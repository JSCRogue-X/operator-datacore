#!/usr/bin/env tsx
// First run: pulls full history from January 2025 and writes to "Orders" tab.
// Weekly runs: appends the last 8 days below existing data (no overwrite).
// Dupe Check formula in L1 auto-expands to cover all rows.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1UuXQykzKLoaiu67CwbEJyQmPbLgscBHdpus-eH1ekRI';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Orders';
const HISTORY_START = new Date('2025-01-01T00:00:00Z');
const CHUNK_SIZE = 10_000;

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

const HEADERS = ['amazon-order-id', 'purchase-date', 'sales-channel', 'sku', 'quantity'];

async function main() {
  console.log('Orders History → Google Sheets');
  console.log('-------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Ensure the Orders tab exists
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

  // Detect first run by checking if the sheet has any data in B2
  const checkResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!B2`,
  });
  const isFirstRun = !checkResp.data.values?.[0]?.[0];

  const startDate = isFirstRun
    ? HISTORY_START
    : new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // last 8 days for weekly append

  if (isFirstRun) {
    console.log(`First run — pulling full history from ${HISTORY_START.toISOString().slice(0, 10)}`);
  } else {
    console.log(`Weekly run — appending from ${startDate.toISOString().slice(0, 10)} to today`);
  }

  console.log('\nFetching orders report...');
  const report = await runReport(spClient, {
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
    marketplaceIds: MARKETPLACE_IDS,
    dataStartTime: startDate,
    dataEndTime: new Date(),
  });

  const rows = parseTsv(report.rawText);
  console.log(`  ${rows.length} order lines fetched`);

  const outputRows = rows
    .filter(row => row['order-status'] !== 'Cancelled')
    .map(row => [
      row['amazon-order-id'] ?? '',
      row['purchase-date'] ?? '',
      row['sales-channel'] ?? '',
      row['sku'] ?? '',
      row['quantity'] ?? '',
    ]);

  outputRows.sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''));
  console.log(`  ${outputRows.length} rows after filtering Cancelled`);

  console.log('\nWriting to Google Sheets...');

  if (isFirstRun) {
    // Clear, resize, and write full history in chunks
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { rowCount: outputRows.length + 100, columnCount: 12 },
              },
              fields: 'gridProperties.rowCount,gridProperties.columnCount',
            },
          },
        ],
      },
    });

    // Write header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });

    // Write data in chunks of 10,000 rows
    const totalChunks = Math.ceil(outputRows.length / CHUNK_SIZE);
    for (let i = 0; i < outputRows.length; i += CHUNK_SIZE) {
      const chunk = outputRows.slice(i, i + CHUNK_SIZE);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${TAB_NAME}!A${i + 2}`,
        valueInputOption: 'RAW',
        requestBody: { values: chunk },
      });
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
      console.log(`  Chunk ${chunkNum}/${totalChunks}: rows ${i + 1}–${Math.min(i + CHUNK_SIZE, outputRows.length)}`);
    }

    // Write Dupe Check formula — auto-expands to cover all rows including future appends
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!L1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['=ARRAYFORMULA({"Dupe Check";A2:A&" "&D2:D})']] },
    });

    console.log(`  Dupe Check formula written to L1`);
  } else {
    // Weekly run — append rows below existing data
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: outputRows },
    });
    console.log(`  Appended ${outputRows.length} rows`);
  }

  console.log(`\nDone — ${isFirstRun ? 'full history written' : 'weekly rows appended'}`);
  console.log('View: https://docs.google.com/spreadsheets/d/1UuXQykzKLoaiu67CwbEJyQmPbLgscBHdpus-eH1ekRI/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
