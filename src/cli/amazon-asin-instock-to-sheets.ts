#!/usr/bin/env tsx
// amazon-asin-instock-to-sheets.ts
// Reads the "Amazon Data" FBA history tab and calculates per-ASIN in-stock
// rates (% of tracked days with available stock) for UK and EU separately.
// Writes a summary + per-ASIN table to the "ASIN Ins" tab.
// Run: npx tsx src/cli/amazon-asin-instock-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

// Source: FBA history sheet (populated daily by fba-to-sheets)
const HISTORY_SHEET_ID = '1fXuMl9PkmMxxpkQwHxtVj-3OprVTc7_cNzG4O_m4fXg';
const HISTORY_TAB      = 'Amazon Data';

// Destination: Automations sheet, ASIN Ins tab
const DEST_SHEET_ID = '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const DEST_TAB      = 'ASIN Ins';

const HISTORY_DAYS = 30;
const KEY_FILE     = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

// Column positions in Amazon Data (0-based)
const HIST_SNAPSHOT = 0;  // snapshot-date (DD/MM/YYYY)
const HIST_SKU      = 1;  // sku
const HIST_ASIN     = 3;  // asin
const HIST_AVAIL    = 6;  // available (FBA fulfillable qty)
const HIST_MARKET   = 34; // marketplace (DE, GB, UK, ES, IT, FR)

// UK codes used in the history (normalised to one label)
const UK_CODES = new Set(['GB', 'UK']);
// EU market codes present in the history
const EU_CODES = new Set(['DE', 'ES', 'IT', 'FR']);
// NL/IE/BE are PAN-EU (not in FBA history) — covered by DE availability

const INSTOCK_HEADERS = ['ASIN', 'SKU', 'UK In-Stock %', 'EU In-Stock %', 'UK In-Stock', 'EU In-Stock'];

function parseUKDate(s: string): Date | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
}

async function main() {
  console.log('Amazon ASIN In-Stock Tracker → Google Sheets');
  console.log('---------------------------------------------');

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - HISTORY_DAYS);

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── 1. Read FBA history ───────────────────────────────────────────────
  console.log(`Reading "${HISTORY_TAB}" from FBA history sheet...`);
  const histRes = await sheets.spreadsheets.values.get({
    spreadsheetId: HISTORY_SHEET_ID,
    range:         `${HISTORY_TAB}!A:AI`, // columns 0–34 covers all we need
  });
  const histRows = (histRes.data.values ?? []).slice(1);
  console.log(`  ${histRows.length} total row(s).`);

  // ── 2. Build per-ASIN history within the window ───────────────────────
  // asin → date → { uk: number, eu: Map<string,number> }
  interface DayData { uk: number; eu: Map<string, number> }
  const asinHistory = new Map<string, Map<string, DayData>>();
  const asinSku     = new Map<string, string>();

  let inWindow = 0;
  for (const row of histRows) {
    const dateStr  = String(row[HIST_SNAPSHOT] ?? '').trim();
    const asin     = String(row[HIST_ASIN]     ?? '').trim();
    const sku      = String(row[HIST_SKU]      ?? '').trim();
    const market   = String(row[HIST_MARKET]   ?? '').trim().toUpperCase();
    const avail    = Number(row[HIST_AVAIL])   || 0;

    if (!dateStr || !asin || !market) continue;

    const d = parseUKDate(dateStr);
    if (!d || d < cutoff) continue;
    inWindow++;

    if (!asinSku.has(asin)) asinSku.set(asin, sku);

    let byDate = asinHistory.get(asin);
    if (!byDate) { byDate = new Map(); asinHistory.set(asin, byDate); }

    let day = byDate.get(dateStr);
    if (!day) { day = { uk: 0, eu: new Map() }; byDate.set(dateStr, day); }

    if (UK_CODES.has(market)) {
      day.uk = Math.max(day.uk, avail);
    } else if (EU_CODES.has(market)) {
      day.eu.set(market, avail);
    }
  }

  console.log(`  ${inWindow} row(s) within last ${HISTORY_DAYS} days.`);
  console.log(`  ${asinHistory.size} unique ASIN(s) with history.`);

  // ── 3. Calculate in-stock rates ───────────────────────────────────────
  interface ResultRow {
    asin:    string;
    sku:     string;
    ukPct:   number;
    euPct:   number;
    ukToday: boolean;
    euToday: boolean;
  }

  // Find the most recent date in the window to use as "current" status
  const allDates = new Set<string>();
  for (const byDate of asinHistory.values()) {
    for (const dt of byDate.keys()) allDates.add(dt);
  }
  const latestDate = [...allDates]
    .map(s => ({ s, d: parseUKDate(s)! }))
    .filter(x => x.d)
    .sort((a, b) => b.d.getTime() - a.d.getTime())[0]?.s ?? '';

  console.log(`  Most recent snapshot date: ${latestDate}`);

  const results: ResultRow[] = [];

  for (const [asin, byDate] of asinHistory) {
    const sku       = asinSku.get(asin) ?? '';
    const totalDays = byDate.size;
    let ukDays = 0;
    let euDays = 0;

    for (const day of byDate.values()) {
      if (day.uk > 0) ukDays++;

      // EU in-stock: any EU market (DE also covers NL/IE/BE via PAN-EU)
      let euInStock = false;
      for (const qty of day.eu.values()) {
        if (qty > 0) { euInStock = true; break; }
      }
      if (euInStock) euDays++;
    }

    const ukPct = totalDays > 0 ? Math.round((ukDays / totalDays) * 100) : 0;
    const euPct = totalDays > 0 ? Math.round((euDays / totalDays) * 100) : 0;

    // Current status from the latest snapshot date
    const latestDay = byDate.get(latestDate);
    const ukToday   = (latestDay?.uk ?? 0) > 0;
    let euToday = false;
    if (latestDay) {
      for (const qty of latestDay.eu.values()) {
        if (qty > 0) { euToday = true; break; }
      }
    }

    results.push({ asin, sku, ukPct, euPct, ukToday, euToday });
  }

  results.sort((a, b) => a.asin.localeCompare(b.asin));

  // ── 4. Build summary and output rows ──────────────────────────────────
  const total          = results.length;
  const ukInStockCount = results.filter(r => r.ukToday).length;
  const euInStockCount = results.filter(r => r.euToday).length;
  const ukSummaryRate  = total > 0 ? Math.round((ukInStockCount / total) * 100) : 0;
  const euSummaryRate  = total > 0 ? Math.round((euInStockCount / total) * 100) : 0;

  const summaryRows: (string | number)[][] = [
    ['',               'UK',           'EU'],
    ['In-Stock Rate',  ukSummaryRate,  euSummaryRate],
    ['ASINs in-stock', ukInStockCount, euInStockCount],
    ['Total ASINs',    total,          total],
    [`In-Stock % = % of days in stock over last ${HISTORY_DAYS} days`],
    [],
  ];

  const outputRows: (string | number)[][] = results.map(r => [
    r.asin,
    r.sku,
    r.ukPct,
    r.euPct,
    r.ukToday ? 'Yes' : 'No',
    r.euToday ? 'Yes' : 'No',
  ]);

  console.log(`  UK: ${ukSummaryRate}% (${ukInStockCount}/${total} ASINs)  EU: ${euSummaryRate}% (${euInStockCount}/${total} ASINs)`);
  console.log(`  ${outputRows.length} ASIN row(s) to write.`);

  // ── 5. Write to ASIN Ins tab ───────────────────────────────────────────
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: DEST_SHEET_ID });
  const destTab     = spreadsheet.data.sheets?.find(s => s.properties?.title === DEST_TAB);
  let sheetId: number;

  if (!destTab) {
    console.log(`  Creating "${DEST_TAB}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: DEST_SHEET_ID,
      requestBody:   { requests: [{ addSheet: { properties: { title: DEST_TAB } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = destTab.properties?.sheetId ?? 0;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: DEST_SHEET_ID,
    requestBody:   { requests: [{ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId:    DEST_SHEET_ID,
    range:            `${DEST_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody:      { values: [...summaryRows, INSTOCK_HEADERS, ...outputRows] },
  });

  console.log(`  Done — "${DEST_TAB}" written.`);
}

main().catch(err => { console.error(err); process.exit(1); });
