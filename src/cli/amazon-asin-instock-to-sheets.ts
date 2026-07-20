#!/usr/bin/env tsx
// amazon-asin-instock-to-sheets.ts
// Reads the "Active Listings" tab and writes a per-ASIN in-stock summary
// (UK vs EU) to the "ASIN Ins" tab in the Automations spreadsheet.
// Run: npx tsx src/cli/amazon-asin-instock-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const SOURCE_TAB     = 'Active Listings';
const DEST_TAB       = 'ASIN Ins';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const EU_MARKETS = ['DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'IE', 'BE'] as const;
type EUMarket = typeof EU_MARKETS[number];

const HEADERS = [
  'ASIN', 'SKU',
  'UK Stock', 'UK In-Stock',
  'EU In-Stock %', 'EU Count',
  'DE Stock', 'FR Stock', 'IT Stock', 'ES Stock',
  'NL Stock', 'SE Stock', 'IE Stock', 'BE Stock',
];

// Active Listings column indices (0-based, from A:H)
const COL_SKU        = 0; // A — seller-sku
const COL_ASIN       = 1; // B — ASIN
const COL_MARKET     = 2; // C — Marketplace Country Code
const COL_AVAILABLE  = 4; // E — FBA fulfillable quantity (local)

async function main() {
  console.log('Amazon ASIN In-Stock Tracker → Google Sheets');
  console.log('---------------------------------------------');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Read Active Listings ────────────────────────────────────────────────
  console.log(`Reading "${SOURCE_TAB}"...`);
  const res  = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${SOURCE_TAB}!A:H`,
  });
  const rows = (res.data.values ?? []).slice(1); // skip header row
  console.log(`  ${rows.length} data row(s) found.`);

  // ── Aggregate by ASIN ───────────────────────────────────────────────────
  interface AsinData {
    sku:   string;
    stock: Partial<Record<string, number>>;
  }
  const asinMap = new Map<string, AsinData>();

  for (const row of rows) {
    const sku       = String(row[COL_SKU]       ?? '').trim();
    const asin      = String(row[COL_ASIN]      ?? '').trim();
    const market    = String(row[COL_MARKET]    ?? '').trim().toUpperCase();
    const available = Number(row[COL_AVAILABLE]) || 0;

    if (!asin || !market) continue;

    let entry = asinMap.get(asin);
    if (!entry) {
      entry = { sku, stock: {} };
      asinMap.set(asin, entry);
    }
    entry.stock[market] = available;
  }

  console.log(`  ${asinMap.size} unique ASIN(s).`);

  // ── Build output rows ───────────────────────────────────────────────────
  const outputRows: (string | number)[][] = Array.from(asinMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([asin, { sku, stock }]) => {
      const ukStock   = stock['GB'] ?? 0;
      const ukInStock = ukStock > 0 ? 'Yes' : 'No';

      let euCount = 0;
      for (const m of EU_MARKETS) {
        if ((stock[m] ?? 0) > 0) euCount++;
      }
      const euPct = Math.round((euCount / EU_MARKETS.length) * 100);

      return [
        asin,
        sku,
        ukStock,
        ukInStock,
        euPct,
        `${euCount} of ${EU_MARKETS.length}`,
        stock['DE'] ?? 0,
        stock['FR'] ?? 0,
        stock['IT'] ?? 0,
        stock['ES'] ?? 0,
        stock['NL'] ?? 0,
        stock['SE'] ?? 0,
        stock['IE'] ?? 0,
        stock['BE'] ?? 0,
      ];
    });

  console.log(`  ${outputRows.length} row(s) to write.`);

  // ── Write to ASIN Ins tab ───────────────────────────────────────────────
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
    requestBody:   { requests: [{ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${DEST_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody:      { values: [HEADERS, ...outputRows] },
  });

  console.log(`  Done — ${outputRows.length} ASIN(s) written to "${DEST_TAB}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
