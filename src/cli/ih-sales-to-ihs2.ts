#!/usr/bin/env tsx
// ih-sales-to-ihs2.ts
// Reads all rows from "IH Sales" in Company Sell-through Tracker V2.1,
// aggregates by ISO week start + SKU, and writes to the "IHS2" tab.
// Run: npx tsx src/cli/ih-sales-to-ihs2.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1mIk4mrFisXIpen2zZpnmxHWDRtmbjX6Ikyao_EzWZ3M';
const SOURCE_TAB     = 'IH Sales';
const DEST_TAB       = 'IHS2';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS  = ['Week Start', 'Year', 'Month', 'Week No.', 'SKU', 'Total Units'];
const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Date helpers ─────────────────────────────────────────────────────────────

// Parse "DD/MM/YYYY HH:MM" or "DD/MM/YYYY" → UTC Date
function parseUKDate(s: string): Date {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
}

function mondayOf(d: Date): Date {
  const date = new Date(d);
  const day  = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date;
}

function isoWeek(d: Date): number {
  const date   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// Google Sheets date serial — days since 30 Dec 1899
function toSheetsSerial(d: Date): number {
  return Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('IH Sales → IHS2 aggregation');
  console.log('-----------------------------');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Read all IH Sales rows ───────────────────────────────────────────────
  console.log(`Reading "${SOURCE_TAB}"...`);
  const res  = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${SOURCE_TAB}!A:D`,   // only need nOrderId, date, SKU, qty
  });
  const rows = (res.data.values ?? []).slice(1); // skip header
  console.log(`  ${rows.length} data rows found.`);

  // ── Aggregate by Week Start + SKU ────────────────────────────────────────
  interface AggRow { weekStart: Date; year: number; month: string; weekNo: number; sku: string; qty: number }
  const aggMap = new Map<string, AggRow>();
  let skipped = 0;

  for (const row of rows) {
    const dateStr = String(row[1] ?? '').trim();
    const sku     = String(row[2] ?? '').trim();
    const qty     = Number(row[3]) || 0;

    if (!sku || !dateStr) { skipped++; continue; }

    const orderDate = parseUKDate(dateStr);
    if (isNaN(orderDate.getTime())) { skipped++; continue; }

    const wStart = mondayOf(orderDate);
    const wNo    = isoWeek(orderDate);
    const year   = wStart.getUTCFullYear();
    const month  = MONTHS[wStart.getUTCMonth()] ?? '';
    const key    = `${wStart.getTime()}|${sku}`;

    const existing = aggMap.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      aggMap.set(key, { weekStart: wStart, year, month, weekNo: wNo, sku, qty });
    }
  }

  if (skipped > 0) console.log(`  ${skipped} row(s) skipped (missing date or SKU).`);

  const outputRows: (string | number)[][] = Array.from(aggMap.values())
    .sort((a, b) =>
      a.weekStart.getTime() - b.weekStart.getTime() ||
      a.sku.localeCompare(b.sku),
    )
    .map(r => [toSheetsSerial(r.weekStart), r.year, r.month, r.weekNo, r.sku, r.qty]);

  console.log(`  ${outputRows.length} aggregated rows to write.`);

  // ── Write to IHS2 ────────────────────────────────────────────────────────
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTab = spreadsheet.data.sheets?.find(s => s.properties?.title === DEST_TAB);
  let sheetId: number;

  if (!existingTab) {
    console.log(`  Creating "${DEST_TAB}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody:   { requests: [{ addSheet: { properties: { title: DEST_TAB } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = existingTab.properties?.sheetId ?? 0;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody:   {
      requests: [
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
        {
          repeatCell: {
            range:  { sheetId, startColumnIndex: 0, endColumnIndex: 1, startRowIndex: 1 },
            cell:   { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'DD-MM-YYYY' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${DEST_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody:      { values: [HEADERS, ...outputRows] },
  });

  console.log(`  Done — ${outputRows.length} rows written to "${DEST_TAB}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
