#!/usr/bin/env tsx
// Fetches REPLEN source orders from Linnworks (last 30 days), deduplicates by
// Order ID, and appends new rows to the "Linn Export" tab in Ogden Replen
// Tracking. Only rows with a ProcessedDate are included.
// After appending, reads formula columns H-K and appends those values to the
// "Overall" tab columns A-D.
// Run: npx tsx src/cli/linnworks-replen-tracker-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID   = '1vHiRxl5b14H2BTkStImPyqml7Co2Lzcd-9kHuYSd8LM';
const KEY_FILE         = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const LINN_EXPORT_TAB  = 'Linn Export';
const OVERALL_TAB      = 'Overall';

const HEADERS = ['nOrderId', 'ReferenceNum', 'dReceievedDate', 'Country', 'Processed', 'ProcessedDate'];

// Google Sheets date serial: days since 30 Dec 1899
const SHEETS_EPOCH = new Date(Date.UTC(1899, 11, 30)).getTime();
function toSheetDate(v: string | null | undefined): number | '' {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : Math.round((d.getTime() - SHEETS_EPOCH) / 86400000);
}

// ── Linnworks auth ──────────────────────────────────────────────────────────

interface LinnworksSession { token: string; server: string; }

async function getLinnworksSession(): Promise<LinnworksSession> {
  const appId     = process.env.LINNWORKS_APP_ID;
  const appSecret = process.env.LINNWORKS_APP_SECRET;
  const appToken  = process.env.LINNWORKS_INSTALL_TOKEN;
  if (!appId || !appSecret || !appToken) {
    throw new Error('LINNWORKS_APP_ID, LINNWORKS_APP_SECRET, and LINNWORKS_INSTALL_TOKEN must all be set');
  }
  const resp = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplication', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ ApplicationId: appId, ApplicationSecret: appSecret, Token: appToken }),
  });
  if (!resp.ok) throw new Error(`Linnworks auth failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { Token: string; Server: string };
  return { token: data.Token, server: data.Server };
}

// ── Types ───────────────────────────────────────────────────────────────────

// Linnworks field names vary slightly across API versions — handle both spellings
interface LinnworksOrder {
  pkOrderId?:      number;
  nOrderId?:       number;
  ReferenceNum?:   string;
  dReceievedDate?: string; // Linnworks typo — missing second 'e' in Received
  dReceivedDate?:  string;
  cCountry?:       string;
  Country?:        string;
  bProcessed?:     boolean;
  Processed?:      boolean;
  dProcessedOn?:   string;
  ProcessedDate?:  string;
  Source?:         string;
  SubSource?:      string;
  [key: string]:   unknown;
}

// ── Fetch processed orders ──────────────────────────────────────────────────

async function fetchReplenOrders(
  session: LinnworksSession,
  from: Date,
  to:   Date,
): Promise<LinnworksOrder[]> {
  const all: LinnworksOrder[] = [];
  let page = 1;

  while (true) {
    // REPLEN orders have SubSource = "REPLEN" (Source = "DATAIMPC").
    // Filter client-side — server-side Source filter returns 0 because Source != "REPLEN".
    const resp = await fetch(`${session.server}/api/ProcessedOrders/SearchProcessedOrders`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: {
          dateField:      'RECEIVED',
          fromDate:       from.toISOString(),
          toDate:         to.toISOString(),
          pageNumber:     page,
          resultsPerPage: 200,
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`SearchProcessedOrders page ${page} failed: ${resp.status} ${text}`);
    }

    // Response shape: { ProcessedOrders: { PageNumber, EntriesPerPage, TotalEntries, TotalPages, Data: [...] } }
    const raw = await resp.json() as {
      ProcessedOrders?: { Data?: LinnworksOrder[]; TotalEntries?: number; TotalPages?: number };
    };

    const po      = raw.ProcessedOrders;
    const entries = po?.Data ?? [];
    if (page === 1) {
      console.log(`  API: ${po?.TotalEntries ?? '?'} total orders across ${po?.TotalPages ?? '?'} page(s)`);
    }

    // Filter to SubSource = "REPLEN" (case-insensitive)
    const replenEntries = entries.filter(o =>
      String(o.SubSource ?? '').toUpperCase() === 'REPLEN',
    );

    all.push(...replenEntries);
    if (entries.length < 200) break;
    page++;
  }

  return all;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks REPLEN → Ogden Replen Tracking');
  console.log('------------------------------------------');

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session OK. Server: ${session.server}`);

  const toDate   = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  console.log(`Fetching orders from ${fromDate.toISOString().slice(0, 10)} to ${toDate.toISOString().slice(0, 10)}...`);

  const orders = await fetchReplenOrders(session, fromDate, toDate);
  console.log(`  ${orders.length} REPLEN order(s) fetched`);

  // Filter: only orders with a ProcessedDate; dedup by nOrderId
  const seenIds = new Set<number>();
  const filtered: LinnworksOrder[] = [];
  for (const o of orders) {
    const id = o.nOrderId;
    if (!id) continue;
    if (!o.dProcessedOn) continue;  // skip if no ProcessedDate
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    filtered.push(o);
  }
  console.log(`  ${filtered.length} order(s) after filter (ProcessedDate set, deduped by Order ID)`);

  // Build output rows: A-F
  // API field names confirmed from response: nOrderId, dReceivedDate, cCountry, dProcessedOn
  const outputRows = filtered.map(o => [
    o.nOrderId ?? '',
    o.ReferenceNum ?? '',
    toSheetDate(o.dReceivedDate ?? o.dReceievedDate),  // API uses dReceivedDate (no double-i typo)
    o.cCountry ?? o.Country ?? '',
    true,   // all rows from SearchProcessedOrders are processed
    toSheetDate(o.dProcessedOn),
  ]);

  // Sort by received date ascending
  outputRows.sort((a, b) => {
    const av = typeof a[2] === 'number' ? a[2] : 0;
    const bv = typeof b[2] === 'number' ? b[2] : 0;
    return av - bv;
  });

  // ── Google Sheets ──────────────────────────────────────────────────────
  console.log('\nConnecting to Google Sheets...');
  const auth   = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const ss       = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMap = new Map(ss.data.sheets?.map(s => [s.properties?.title ?? '', s.properties?.sheetId ?? 0]) ?? []);

  // ── Ensure Linn Export tab exists ──
  let linnSheetId: number;
  if (!sheetMap.has(LINN_EXPORT_TAB)) {
    console.log(`  Creating "${LINN_EXPORT_TAB}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody:   { requests: [{ addSheet: { properties: { title: LINN_EXPORT_TAB } } }] },
    });
    linnSheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${LINN_EXPORT_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody:   { values: [HEADERS] },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range:  { sheetId: linnSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell:   { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        }],
      },
    });
  } else {
    linnSheetId = sheetMap.get(LINN_EXPORT_TAB)!;
  }

  // Read existing Order IDs from column A for dedup
  const existingResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${LINN_EXPORT_TAB}!A:A`,
  });
  const existingRows = existingResp.data.values ?? [];
  const existingIds  = new Set(
    existingRows.slice(1).map(r => String(r?.[0] ?? '').trim()).filter(Boolean),
  );
  console.log(`  ${existingIds.size} existing order(s) in "${LINN_EXPORT_TAB}".`);

  // Keep only rows not already in the sheet
  const newRows = outputRows.filter(r => !existingIds.has(String(r[0])));
  if (newRows.length === 0) {
    console.log('  No new REPLEN orders to append — sheet is already up to date.');
    return;
  }
  console.log(`  ${newRows.length} new row(s) to append (${outputRows.length - newRows.length} duplicate(s) skipped).`);

  // Append A-F
  await sheets.spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           `${LINN_EXPORT_TAB}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:     { values: newRows },
  });

  // 1-indexed row numbers for newly appended data
  const firstNewRow = existingRows.length + 1;
  const lastNewRow  = firstNewRow + newRows.length - 1;

  // Apply date format: column C (dReceievedDate, index 2) and F (ProcessedDate, index 5)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId:          linnSheetId,
              startRowIndex:    existingRows.length,
              endRowIndex:      existingRows.length + newRows.length,
              startColumnIndex: 2,
              endColumnIndex:   3,
            },
            cell:   { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId:          linnSheetId,
              startRowIndex:    existingRows.length,
              endRowIndex:      existingRows.length + newRows.length,
              startColumnIndex: 5,
              endColumnIndex:   6,
            },
            cell:   { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
      ],
    },
  });

  // ── Copy H-K → Overall A-D ────────────────────────────────────────────
  console.log(`\n  Waiting 3 seconds for formula columns H-K to compute in "${LINN_EXPORT_TAB}"...`);
  await new Promise(r => setTimeout(r, 3000));

  const hkResp = await sheets.spreadsheets.values.get({
    spreadsheetId:     SPREADSHEET_ID,
    range:             `${LINN_EXPORT_TAB}!H${firstNewRow}:K${lastNewRow}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const hkData = hkResp.data.values ?? [];

  if (hkData.length === 0) {
    console.log('  Warning: H-K returned no values — formulas may not have computed yet.');
    console.log('  The H-K → Overall copy was skipped. Re-run the script to retry.');
  } else {
    // Find last row with data in Overall tab
    const overallResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${OVERALL_TAB}!A:A`,
    });
    const overallRows    = overallResp.data.values ?? [];
    const firstOveralRow = overallRows.length + 1;  // next empty row (1-indexed)

    await sheets.spreadsheets.values.update({
      spreadsheetId:   SPREADSHEET_ID,
      range:           `${OVERALL_TAB}!A${firstOveralRow}`,
      valueInputOption: 'RAW',
      requestBody:     { values: hkData },
    });
    console.log(`  H-K → Overall A-D: ${hkData.length} row(s) appended at row ${firstOveralRow} in "${OVERALL_TAB}".`);
  }

  console.log(`\nDone — ${newRows.length} row(s) added to "${LINN_EXPORT_TAB}".`);
  console.log(`\nView: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => { console.error(err); process.exit(1); });
