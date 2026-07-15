#!/usr/bin/env tsx
// linnworks-oos-to-sheets.ts
// Fetches items with 0 available stock from Linnworks (Ogden Fulfilment location)
// and writes them to the "IH OOS" tab in Google Sheets.
// Uses GetItemChangesHistory to find the actual date each item went OOS.
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
  const appId     = process.env.LINNWORKS_APP_ID;
  const appSecret = process.env.LINNWORKS_APP_SECRET;
  const appToken  = process.env.LINNWORKS_INSTALL_TOKEN;
  if (!appId || !appSecret || !appToken) {
    throw new Error('LINNWORKS_APP_ID, LINNWORKS_APP_SECRET, and LINNWORKS_INSTALL_TOKEN must all be set');
  }

  const resp = await fetch('https://api.linnworks.net/api/Auth/AuthorizeByApplication', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ApplicationId: appId, ApplicationSecret: appSecret, Token: appToken }),
  });

  if (!resp.ok) {
    throw new Error(`Linnworks auth failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { Token: string; Server: string };
  return { token: data.Token, server: data.Server };
}

// ── Linnworks stock fetch ──────────────────────────────────────────────────────

interface StockItem {
  stockItemId: string;
  SKU:         string;
  Title:       string;
  Available:   number;
}

async function fetchOosItems(session: LinnworksSession): Promise<{ items: StockItem[]; resolvedLocationId: string }> {
  const locationKey = process.env.LINNWORKS_LOCATION_KEY;
  if (!locationKey) throw new Error('LINNWORKS_LOCATION_KEY not set');

  const allItems: StockItem[] = [];
  let resolvedLocationId = locationKey; // updated to actual GUID on first match
  let pageNumber = 1;
  const pageSize = 200;

  while (true) {
    const resp = await fetch(`${session.server}/api/Stock/GetStockItemsFull`, {
      method: 'POST',
      headers: {
        Authorization:  session.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        keyword:              '',
        loadCompositeParents: false,
        loadVariationParents: false,
        entriesPerPage:       pageSize,
        pageNumber,
        dataRequirements:     ['StockLevels'],
        searchTypes:          ['SKU', 'Title', 'Barcode'],
      }),
    });

    if (!resp.ok) throw new Error(`GetStockItemsFull failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json() as Array<{
      StockItemId:  string;
      ItemNumber:   string;
      ItemTitle:    string;
      StockLevels?: Array<{
        Location?: { StockLocationId: string; LocationName: string };
        Available: number;
      }>;
    }>;

    if (!Array.isArray(data) || !data.length) break;

    for (const item of data) {
      // Match location by GUID (StockLocationId) OR by name (LocationName).
      const loc = item.StockLevels?.find(l =>
        l.Location?.StockLocationId === locationKey ||
        l.Location?.LocationName     === locationKey,
      );
      if (!loc) continue;

      // Capture the actual GUID from the first matched location entry.
      // LINNWORKS_LOCATION_KEY may be a name ("Ogden Fulfilment"); the history API needs the GUID.
      if (resolvedLocationId === locationKey && loc.Location?.StockLocationId) {
        resolvedLocationId = loc.Location.StockLocationId;
      }

      if (loc.Available > 0) continue;

      allItems.push({
        stockItemId: item.StockItemId,
        SKU:         item.ItemNumber,
        Title:       item.ItemTitle,
        Available:   loc.Available,
      });
    }

    if (data.length < pageSize) break;
    pageNumber++;
  }

  return { items: allItems, resolvedLocationId };
}

// ── Linnworks stock history ────────────────────────────────────────────────────

// Fetches the date when a stock item first went OOS in its current OOS streak.
// Returns null if history is unavailable or can't be parsed.
async function findFirstOosDate(
  session:     LinnworksSession,
  stockItemId: string,
  locationId:  string,
): Promise<string | null> {
  try {
    const url = new URL(`${session.server}/api/Stock/GetItemChangesHistory`);
    url.searchParams.set('stockItemId', stockItemId);
    url.searchParams.set('locationId',  locationId);
    url.searchParams.set('entriesPerPage', '200');
    url.searchParams.set('pageNumber',     '1');

    const resp = await fetch(url.toString(), {
      headers: { Authorization: session.token },
    });
    if (!resp.ok) {
      console.log(`  History API ${resp.status} for ${stockItemId.slice(0, 8)}...`);
      return null;
    }

    const raw = await resp.json() as unknown;

    // Linnworks may wrap the array in { Data: [...] } or return a plain array
    const entries: Record<string, unknown>[] =
      Array.isArray(raw) ? raw
      : Array.isArray((raw as Record<string, unknown>)['Data']) ? (raw as Record<string, unknown>)['Data'] as Record<string, unknown>[]
      : [];

    if (!entries.length) return null;

    // Walk newest-first through history entries.
    // Track the last-seen 0-stock date; stop when we find a positive-stock entry.
    // That boundary marks the start of the current OOS streak.
    let lastZeroDate: string | null = null;

    for (const entry of entries) {
      const rawDate = entry['Date'] as string | undefined;
      if (!rawDate) continue;

      // Linnworks history uses "Level" for the stock level after the change
      const level = entry['Level'] as number | undefined;
      if (level === undefined || typeof level !== 'number') continue;

      if (level > 0) break; // Found positive stock — OOS streak started at lastZeroDate
      lastZeroDate = rawDate;
    }

    if (!lastZeroDate) return null;

    // Format the ISO date string to UK format (e.g. "12 Jul 2026")
    const d = new Date(lastZeroDate);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch {
    return null;
  }
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

  console.log('Fetching OOS stock items (Ogden Fulfilment only)...');
  const { items: oosItems, resolvedLocationId } = await fetchOosItems(session);
  console.log(`  Found ${oosItems.length} item(s) with 0 available stock at Ogden Fulfilment.`);
  console.log(`  Resolved location GUID: ${resolvedLocationId}`);

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
      const sku       = (row[0] ?? '').trim();
      const firstSeen = (row[4] ?? '').trim();
      if (sku && firstSeen) firstSeenMap.set(sku, firstSeen);
    }
    console.log(`  Read ${firstSeenMap.size} previously tracked SKU(s) from sheet.`);
  } catch {
    console.log('  No existing data found — starting fresh.');
  }

  // For new OOS items (not already in sheet), look up actual OOS date from Linnworks history
  const today = todayStr();
  const outputRows: string[][] = [];
  let historyLookups = 0;

  let historyResolved = 0;

  for (const item of oosItems) {
    let firstSeen = firstSeenMap.get(item.SKU);

    if (!firstSeen) {
      // New OOS item — look up actual OOS date from Linnworks history using the resolved location GUID
      const historyDate = await findFirstOosDate(session, item.stockItemId, resolvedLocationId);
      firstSeen = historyDate ?? today;
      historyLookups++;
      if (historyDate) historyResolved++;
    }

    const days = daysSince(firstSeen);
    outputRows.push([item.SKU, item.Title, String(item.Available), String(days), firstSeen]);
  }

  if (historyLookups > 0) {
    console.log(`  History lookups: ${historyLookups} new item(s), ${historyResolved} with a real OOS date, ${historyLookups - historyResolved} defaulted to today.`);
  }

  // Sort by days since OOS descending (longest OOS first)
  outputRows.sort((a, b) => parseInt(b[3]!) - parseInt(a[3]!));

  // Get or create tab
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
