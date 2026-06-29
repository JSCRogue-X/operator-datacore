#!/usr/bin/env tsx
// First run: pulls history month by month from January 2025 (SP-API silently
// returns 0 rows for ranges longer than ~30 days, so chunking is required).
// Weekly runs: appends the last 8 days below existing data (no overwrite).

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

function getMonthlyChunks(from: Date, to: Date): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  let current = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (current < to) {
    const start = new Date(current);
    const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
    chunks.push({ start, end: end > to ? to : end });
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  }
  return chunks;
}

async function wait70s() {
  console.log('  Waiting 70s (rate limit)...');
  await new Promise(r => setTimeout(r, 70_000));
}

function toOutputRow(row: Record<string, string>): string[] {
  return [
    row['amazon-order-id'] ?? '',
    row['purchase-date'] ?? '',
    row['sales-channel'] ?? '',
    row['sku'] ?? '',
    row['quantity'] ?? '',
  ];
}

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

  // Detect first run by checking if B2 has data
  const checkResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!B2`,
  });
  const isFirstRun = !checkResp.data.values?.[0]?.[0];

  if (isFirstRun) {
    // ── Initial backfill: fetch month by month ──────────────────────────────
    console.log(`First run — pulling history month by month from ${HISTORY_START.toISOString().slice(0, 10)}`);

    const now = new Date();
    const months = getMonthlyChunks(HISTORY_START, now);
    console.log(`  ${months.length} monthly chunks to fetch\n`);

    const allRows: string[][] = [];

    for (let i = 0; i < months.length; i++) {
      const { start, end } = months[i]!;
      const label = start.toISOString().slice(0, 7);
      console.log(`[${i + 1}/${months.length}] ${label}`);

      const report = await runReport(spClient, {
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: MARKETPLACE_IDS,
        dataStartTime: start,
        dataEndTime: end,
      });

      const rows = parseTsv(report.rawText)
        .filter(r => r['order-status'] !== 'Cancelled')
        .map(toOutputRow);

      console.log(`  ${rows.length} rows`);
      allRows.push(...rows);

      if (i < months.length - 1) await wait70s();
    }

    allRows.sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''));
    console.log(`\nTotal: ${allRows.length} rows across all months`);

    // Clear, resize, write header
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { rowCount: allRows.length + 100, columnCount: 12 },
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
      requestBody: { values: [HEADERS] },
    });

    // Write data in chunks of 10,000 rows
    console.log('\nWriting to Google Sheets...');
    const totalChunks = Math.ceil(allRows.length / CHUNK_SIZE);
    for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
      const chunk = allRows.slice(i, i + CHUNK_SIZE);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${TAB_NAME}!A${i + 2}`,
        valueInputOption: 'RAW',
        requestBody: { values: chunk },
      });
      const n = Math.floor(i / CHUNK_SIZE) + 1;
      console.log(`  Chunk ${n}/${totalChunks}: rows ${i + 1}–${Math.min(i + CHUNK_SIZE, allRows.length)}`);
    }

    // Write Dupe Check formula — ARRAYFORMULA auto-expands for future appends
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!L1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['=ARRAYFORMULA({"Dupe Check";A2:A&" "&D2:D})']] },
    });

    console.log(`\nDone — full history written (${allRows.length} rows)`);

  } else {
    // ── Weekly append: last 8 days only ────────────────────────────────────
    const startDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    console.log(`Weekly run — appending from ${startDate.toISOString().slice(0, 10)} to today`);

    const report = await runReport(spClient, {
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: MARKETPLACE_IDS,
      dataStartTime: startDate,
      dataEndTime: new Date(),
    });

    const outputRows = parseTsv(report.rawText)
      .filter(r => r['order-status'] !== 'Cancelled')
      .map(toOutputRow);

    outputRows.sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''));
    console.log(`  ${outputRows.length} rows to append`);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: outputRows },
    });

    console.log(`  Done — ${outputRows.length} rows appended`);
  }

  console.log('View: https://docs.google.com/spreadsheets/d/1UuXQykzKLoaiu67CwbEJyQmPbLgscBHdpus-eH1ekRI/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
