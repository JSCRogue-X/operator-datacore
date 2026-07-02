#!/usr/bin/env tsx
// Pulls all Amazon orders from January 2025 to today, month by month (SP-API
// returns 0 rows for ranges longer than ~30 days), aggregates into weekly
// totals per ASIN per marketplace, and overwrites the "Claude" tab each run.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1o_vVKzMhuIRT9IRsS0eO5FR3qTEH_Rf6MDd_tQdWAm4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Claude';
const HISTORY_START = new Date('2025-01-01T00:00:00Z');

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

const HEADERS = ['Week Start', 'Year', 'Month', 'Week No.', 'Marketplace', 'ASIN', 'Total Units'];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface AggRow {
  weekStart: string;
  year: number;
  month: string;
  weekNo: number;
  marketplace: string;
  asin: string;
  totalUnits: number;
}

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

function getMondayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d;
}

function getISOWeek(monday: Date): { year: number; week: number } {
  const thu = new Date(monday);
  thu.setUTCDate(monday.getUTCDate() + 3);
  const year = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const startOfW1 = getMondayOf(jan4);
  const week = Math.round((monday.getTime() - startOfW1.getTime()) / (7 * 86400000)) + 1;
  return { year, week };
}

async function wait70s() {
  console.log('  Waiting 70s (rate limit)...');
  await new Promise(r => setTimeout(r, 70_000));
}

async function main() {
  console.log('Orders History (ASIN) → Google Sheets (aggregated weekly)');
  console.log('----------------------------------------------------------');
  console.log(`Date range: ${HISTORY_START.toISOString().slice(0, 10)} → today`);

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  // ── Step 1: fetch all months ──────────────────────────────────────────────
  const now = new Date();
  const months = getMonthlyChunks(HISTORY_START, now);
  console.log(`\n${months.length} monthly chunks to fetch`);

  const aggMap = new Map<string, AggRow>();

  for (let i = 0; i < months.length; i++) {
    const { start, end } = months[i]!;
    const label = start.toISOString().slice(0, 7);
    console.log(`\n[${i + 1}/${months.length}] ${label}`);

    const report = await runReport(spClient, {
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: MARKETPLACE_IDS,
      dataStartTime: start,
      dataEndTime: end,
    });

    const rows = parseTsv(report.rawText).filter(r =>
      r['order-status'] !== 'Cancelled' &&
      !(r['sales-channel'] ?? '').toLowerCase().startsWith('non-amazon'),
    );
    console.log(`  ${rows.length} non-cancelled, Amazon-channel order lines`);

    for (const row of rows) {
      const purchaseDate = row['purchase-date'] ?? '';
      if (!purchaseDate) continue;

      const date = new Date(purchaseDate);
      if (isNaN(date.getTime())) continue;

      const monday = getMondayOf(date);
      const weekStart = monday.toISOString().slice(0, 10);
      const { year, week } = getISOWeek(monday);
      const month = MONTH_NAMES[monday.getUTCMonth()]!;
      const marketplace = row['sales-channel'] ?? '';
      const asin = row['asin'] ?? '';
      const qty = parseInt(row['quantity'] ?? '0', 10) || 0;

      const key = `${weekStart}|${marketplace}|${asin}`;
      const existing = aggMap.get(key);
      if (existing) {
        existing.totalUnits += qty;
      } else {
        aggMap.set(key, { weekStart, year, month, weekNo: week, marketplace, asin, totalUnits: qty });
      }
    }

    if (i < months.length - 1) await wait70s();
  }

  // ── Step 2: sort and build output rows ───────────────────────────────────
  const outputRows = [...aggMap.values()]
    .sort((a, b) => {
      if (a.weekStart !== b.weekStart) return a.weekStart.localeCompare(b.weekStart);
      if (a.marketplace !== b.marketplace) return a.marketplace.localeCompare(b.marketplace);
      return a.asin.localeCompare(b.asin);
    })
    .map(r => [r.weekStart, String(r.year), r.month, String(r.weekNo), r.marketplace, r.asin, String(r.totalUnits)]);

  console.log(`\nAggregated into ${outputRows.length} rows (from ${aggMap.size} unique week/marketplace/ASIN combinations)`);

  // ── Step 3: write to Google Sheets ───────────────────────────────────────
  console.log('\nWriting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTab = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  let sheetId: number;

  if (!existingTab) {
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = existingTab.properties?.sheetId ?? 0;
  }

  // Clear, resize, write
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
  console.log(`View: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => { console.error(err); process.exit(1); });
