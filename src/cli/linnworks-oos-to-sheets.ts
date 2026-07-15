#!/usr/bin/env tsx
// linnworks-oos-to-sheets.ts
// Fetches items with 0 available stock from Linnworks and writes them to
// the "IH OOS" tab in the Linnworks Google Sheet.
// Tracks "days since OOS" by reading the previous sheet run before overwriting.
// Run: npx tsx src/cli/linnworks-oos-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ';
const TAB_NAME       = 'IH OOS';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS = ['SKU', 'Title', 'Available Stock', 'Days Since OOS', 'First Seen OOS'];

// ── Linnworks auth ─────────────────────────────────────────────────────────────

interface LinnworksSession {
  token: string;
  server: string;
}

async function getLinnworksSession(): Promise<LinnworksSession> {
  const appToken = process.env.LINNWORKS_API_TOKEN;
  if (!appToken) throw new Error('LINNWORKS_API_TOKEN not set');

  const resp = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplicationToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ applicationToken: appToken }),
  });

  if (!resp.ok) {
    throw new Error(`Linnworks auth failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { Token: string; Server: string };
  return { token: data.Token, server: data.Server };
}

// ── Linnworks stock fetch ──────────────────────────────────────────────────────

interface StockItem {
  SKU:       string;
  Title:     string;
  Available: number;
}

async function fetchOosItems(session: LinnworksSession): Promise<StockItem[]> {
  const locationId = process.env.LINNWORKS_LOCATION_KEY;
  if (!locationId) throw new Error('LINNWORKS_LOCATION_KEY not set');

  const allItems: StockItem[] = [];
  let startIndex = 0;
  const pageSize = 200;

  while (true) {
    const params = new URLSearchParams({
      startIndex:        String(startIndex),
      itemsCount:        String(pageSize),
      getDataByLocation: 'true',
      locationId,
    });

    const resp = await fetch(`${session.server}/api/Stock/GetStockItemsFull`, {
      method: 'POST',
      headers: {
        Authorization:  session.token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!resp.ok) throw new Error(`GetStockItemsFull failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json() as Array<{
      ItemNumber: string;
      ItemTitle:  string;
      Locations?: Array<{ Available: number }>;
    }>;

    if (!data.length) break;

    for (const item of data) {
      const available = item.Locations?.[0]?.Available ?? 0;
      if (available <= 0) {
        allItems.push({
          SKU:       item.ItemNumber,
          Title:     item.ItemTitle,
          Available: available,
        });
      }
    }

    if (data.length < pageSize) break;
    startIndex += pageSize;
  }

  return allItems;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks OOS → Google Sheets');
  console.log('------------------------------');

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session token obtained. Server: ${session.server}`);

  console.log('Fetching OOS stock items...');
  const oosItems = await fetchOosItems(session);
  console.log(`  Found ${oosItems.length} item(s) with 0 available stock.`);

  // ── Google Sheets ──────────────────────────────────────────────────────────
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Read existing tab to preserve first-seen-OOS dates
  const firstSeenMap = new Map<string, string>(); // SKU → date string
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A2:E`,
    });
    for (const row of existing.data.values ?? []) {
      const sku      = (row[0] ?? '').trim();
      const firstSeen = (row[4] ?? '').trim(); // column E = First Seen OOS
      if (sku && firstSeen) firstSeenMap.set(sku, firstSeen);
    }
    console.log(`  Read ${firstSeenMap.size} previously tracked SKU(s) from sheet.`);
  } catch {
    console.log('  No existing data found — starting fresh.');
  }

  // Build output rows
  const today = todayStr();
  const outputRows = oosItems.map(item => {
    const firstSeen = firstSeenMap.get(item.SKU) ?? today;
    const days      = daysSince(firstSeen);
    return [item.SKU, item.Title, String(item.Available), String(days), firstSeen];
  });

  // Sort by days since OOS descending (longest OOS first)
  outputRows.sort((a, b) => parseInt(b[3]!) - parseInt(a[3]!));

  // Get or create tab
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
  let sheetId: number;

  if (!existing) {
    console.log(`  Creating "${TAB_NAME}" tab...`);
    const addResp = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
    sheetId = addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  } else {
    sheetId = existing.properties?.sheetId ?? 0;
  }

  // Clear and write
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ updateCells: { range: { sheetId }, fields: 'userEnteredValue' } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS, ...outputRows] },
  });

  console.log(`  Done — ${outputRows.length} OOS item(s) written to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
