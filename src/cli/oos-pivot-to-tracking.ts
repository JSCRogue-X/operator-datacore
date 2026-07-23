#!/usr/bin/env tsx
// Reads KPI values from the PIVOT tab of OOS Tracking and writes them
// to the row in the Tracking tab that matches today's date (DD/MM/YYYY).
// Run: npx tsx src/cli/oos-pivot-to-tracking.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1QriRw0CXwEeKF_qsFajLeEnCKErx0t6vKFbKM59H9iM';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const EUR_TO_GBP = 0.85;

function todayDDMMYYYY(): string {
  const d  = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function toNum(v: unknown): number {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

async function main() {
  console.log('OOS PIVOT → Tracking');
  console.log('---------------------');

  const auth   = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Step 1: Read PIVOT!A1:F11 ─────────────────────────────────────────────
  console.log('Reading PIVOT!A1:F11...');
  const pivotResp = await sheets.spreadsheets.values.get({
    spreadsheetId:     SPREADSHEET_ID,
    range:             'PIVOT!A1:F11',
    valueRenderOption: 'UNFORMATTED_VALUE',  // raw numbers, not formatted strings
  });
  const p = pivotResp.data.values ?? [];

  // Row 4 = index 3 (0-based)
  const r4 = p[3] ?? [];
  const euPotentialOOS   = r4[0] ?? 0;  // A4
  const euLast365OOS     = r4[1] ?? 0;  // B4
  const ukPotentialOOS   = r4[2] ?? 0;  // C4
  const ukLast365OOS     = r4[3] ?? 0;  // D4
  const grandTotalPotOOS = r4[4] ?? 0;  // E4
  const grandTotalL365   = r4[5] ?? 0;  // F4

  // Row 11 = index 10 (0-based)
  const r11 = p[10] ?? [];
  const euLostSales = r11[1] ?? 0;  // B11
  const ukLostSales = r11[2] ?? 0;  // C11

  console.log(`  Row 4  → A:${euPotentialOOS} B:${euLast365OOS} C:${ukPotentialOOS} D:${ukLast365OOS} E:${grandTotalPotOOS} F:${grandTotalL365}`);
  console.log(`  Row 11 → B:${euLostSales} C:${ukLostSales}`);

  // ── Step 2: Find today's row in Tracking!B ────────────────────────────────
  const todayStr = todayDDMMYYYY();
  console.log(`\nSearching Tracking!B1:B200 for today (${todayStr})...`);

  const trackResp = await sheets.spreadsheets.values.get({
    spreadsheetId:     SPREADSHEET_ID,
    range:             'Tracking!B1:B200',
    valueRenderOption: 'FORMATTED_VALUE',  // get dates as the text the cell displays
  });
  const trackCol = (trackResp.data.values ?? []).map(r => (r[0] ?? '').toString().trim());

  const rowIdx = trackCol.findIndex(v => v === todayStr);
  if (rowIdx === -1) {
    throw new Error(
      `No row found in Tracking tab for today (${todayStr}). ` +
      `Add today's date to column B in DD/MM/YYYY format and try again.`,
    );
  }
  // range starts at B1 → rowIdx 0 = sheet row 1
  const sheetRow = rowIdx + 1;
  console.log(`  Found at sheet row ${sheetRow}.`);

  // ── Step 3: Calculate Overall Lost Sales ──────────────────────────────────
  const euLS  = toNum(euLostSales);
  const ukLS  = toNum(ukLostSales);
  const overallLS = Math.round((euLS * EUR_TO_GBP + ukLS) * 100) / 100;

  console.log(`  Overall Lost Sales: (${euLS} × ${EUR_TO_GBP}) + ${ukLS} = £${overallLS}`);

  // ── Step 4: Write D:L of that row ─────────────────────────────────────────
  // D  EU Potential OOS Days (A4)
  // E  EU Last 365 OOS       (B4)
  // F  UK Potential OOS Days (C4)
  // G  UK Last 365 OOS       (D4)
  // H  Grand Total Pot OOS   (E4)
  // I  Grand Total Last 365  (F4)
  // J  EU Lost Sales         (B11)
  // K  UK Lost Sales         (C11)
  // L  Overall Lost Sales    (calculated)
  const writeRange = `Tracking!D${sheetRow}:L${sheetRow}`;
  console.log(`\nWriting to ${writeRange}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SPREADSHEET_ID,
    range:            writeRange,
    valueInputOption: 'RAW',
    requestBody:      {
      values: [[
        euPotentialOOS,
        euLast365OOS,
        ukPotentialOOS,
        ukLast365OOS,
        grandTotalPotOOS,
        grandTotalL365,
        euLostSales,
        ukLostSales,
        overallLS,
      ]],
    },
  });

  console.log(`\nDone — Tracking row ${sheetRow} (${todayStr}) updated with D:L values.`);
  console.log(`View: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => { console.error(err); process.exit(1); });
