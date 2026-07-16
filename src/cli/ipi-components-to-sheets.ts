#!/usr/bin/env tsx
// Downloads FBA Inventory Planning data, calculates the 4 IPI component metrics
// (sell-through, in-stock rate, excess inventory %, stranded inventory %),
// and appends a row per marketplace to a Google Sheet — building a weekly history.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'UK' },
  { id: 'A1PA6795UKMFR9', label: 'DE' },
];

const HEADERS = [
  'snapshot_date',
  'marketplace',
  'sell_through_avg',
  'in_stock_rate_pct',
  'excess_inventory_pct',
  'stranded_skus',
  'stranded_pct',
  'total_active_skus',
  'total_available_units',
  'total_excess_units',
];

function toPercent(num: number, den: number): string {
  if (den === 0) return '0.00%';
  return ((num / den) * 100).toFixed(2) + '%';
}

function calcMetrics(rows: Array<Record<string, string>>, label: string) {
  // Only count SKUs with any inventory presence
  const active = rows.filter(r => parseFloat(r['available'] ?? '0') > 0);

  const total = active.length;
  const snapshotDate = rows[0]?.['snapshot-date'] ?? new Date().toISOString().slice(0, 10);

  // Sell-through: average of the sell-through column (skip blank/NaN)
  const stValues = active
    .map(r => parseFloat(r['sell-through'] ?? ''))
    .filter(v => isFinite(v) && !isNaN(v));
  const sellThroughAvg = stValues.length > 0
    ? (stValues.reduce((a, b) => a + b, 0) / stValues.length).toFixed(4)
    : '0.0000';

  // In-stock: SKUs with available > 0
  const inStockCount = active.filter(r => parseFloat(r['available'] ?? '0') > 0).length;

  // Excess inventory: estimated-excess-quantity > 0
  const excessRows = active.filter(r => parseFloat(r['estimated-excess-quantity'] ?? '0') > 0);
  const totalExcessUnits = Math.round(
    excessRows.reduce((sum, r) => sum + parseFloat(r['estimated-excess-quantity'] ?? '0'), 0),
  );

  // Stranded: alert column contains "strand" (case-insensitive)
  const strandedRows = active.filter(r => (r['alert'] ?? '').toLowerCase().includes('strand'));

  // Total available units
  const totalAvailableUnits = Math.round(
    active.reduce((sum, r) => sum + parseFloat(r['available'] ?? '0'), 0),
  );

  console.log(`    ${label}: ${total} active SKUs | in-stock ${toPercent(inStockCount, total)} | excess ${excessRows.length} SKUs | stranded ${strandedRows.length} SKUs`);

  return [
    snapshotDate,
    label,
    sellThroughAvg,
    toPercent(inStockCount, total),
    toPercent(excessRows.length, total),
    String(strandedRows.length),
    toPercent(strandedRows.length, total),
    String(total),
    String(totalAvailableUnits),
    String(totalExcessUnits),
  ];
}

async function main() {
  console.log('IPI Components → Google Sheets');
  console.log('--------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  console.log('Step 1: Downloading FBA Inventory Planning reports...');

  const newRows: string[][] = [];

  for (let i = 0; i < MARKETPLACES.length; i++) {
    const market = MARKETPLACES[i]!;
    console.log(`  Requesting ${market.label} report...`);
    const report = await runReport(spClient, {
      reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
      marketplaceIds: [market.id],
    });

    const rows = parseTsv(report.rawText);
    console.log(`    ${rows.length} SKUs`);
    newRows.push(calcMetrics(rows, market.label));

    if (i < MARKETPLACES.length - 1) {
      console.log('  Waiting 70s before next report (rate limit)...');
      await new Promise(r => setTimeout(r, 70_000));
    }
  }

  console.log('\nStep 2: Writing to Google Sheet...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Get tab name
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetTitle = spreadsheet.data.sheets?.[0]?.properties?.title ?? 'IPI Data';
  console.log(`  Tab: "${sheetTitle}"`);

  // Check if headers are already in row 1
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
  });
  const hasHeaders = (existing.data.values?.[0]?.[0] ?? '') === HEADERS[0];
  const rowsToAppend = hasHeaders ? newRows : [HEADERS, ...newRows];

  // Append — don't overwrite, build a history
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rowsToAppend },
  });

  console.log(`  Done — appended ${newRows.length} rows to "${sheetTitle}"`);
  console.log('');
  console.log('View: https://docs.google.com/spreadsheets/d/1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
