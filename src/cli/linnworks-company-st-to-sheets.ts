#!/usr/bin/env tsx
// linnworks-company-st-to-sheets.ts
// Fetches SKU, title, stock levels and FBA SKU for all items at Ogden Fulfilment
// and writes them to the "Company ST" tab in Google Sheets.
// Run: npx tsx src/cli/linnworks-company-st-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ';
const TAB_NAME       = 'Company ST';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function isoWeek(d: Date): number {
  const date   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

const EXCLUDED_CATEGORIES = new Set(['Stationary', 'Discontinued SPINCARE', 'Default']);

// ── Linnworks auth ──────────────────────────────────────────────────────────

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
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ ApplicationId: appId, ApplicationSecret: appSecret, Token: appToken }),
  });

  if (!resp.ok) throw new Error(`Linnworks auth failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { Token: string; Server: string };
  return { token: data.Token, server: data.Server };
}

// ── Fetch ───────────────────────────────────────────────────────────────────

interface ExtProp {
  ProperyName?:   string; // Linnworks typo — missing 't'
  PropertyValue?: string;
}

interface StockLevel {
  Location?:     { StockLocationId: string; LocationName: string };
  Available:     number;
  MinimumLevel?: number;
}

interface RawItem {
  ItemNumber:              string;
  ItemTitle:               string;
  CategoryName?:           string;
  StockLevels?:            StockLevel[];
  ItemExtendedProperties?: ExtProp[];
}

async function fetchItems(session: LinnworksSession): Promise<{ item: RawItem; loc: StockLevel }[]> {
  const locationKey = process.env.LINNWORKS_LOCATION_KEY;
  if (!locationKey) throw new Error('LINNWORKS_LOCATION_KEY not set');

  const results: { item: RawItem; loc: StockLevel }[] = [];
  let resolvedLocationId = locationKey;
  let pageNumber = 1;
  const pageSize = 200;

  while (true) {
    const resp = await fetch(`${session.server}/api/Stock/GetStockItemsFull`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        keyword:              '',
        loadCompositeParents: false,
        loadVariationParents: false,
        entriesPerPage:       pageSize,
        pageNumber,
        dataRequirements:     ['StockLevels', 'ExtendedProperties'],
        searchTypes:          ['SKU', 'Title', 'Barcode'],
      }),
    });

    if (!resp.ok) throw new Error(`GetStockItemsFull failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json() as RawItem[];
    if (!Array.isArray(data) || !data.length) break;

    for (const item of data) {
      if (EXCLUDED_CATEGORIES.has(item.CategoryName ?? '')) continue;

      const loc = item.StockLevels?.find(l =>
        l.Location?.StockLocationId === resolvedLocationId ||
        l.Location?.LocationName     === locationKey,
      );
      if (!loc) continue;

      if (resolvedLocationId === locationKey && loc.Location?.StockLocationId) {
        resolvedLocationId = loc.Location.StockLocationId;
      }

      results.push({ item, loc });
    }

    if (data.length < pageSize) break;
    pageNumber++;
  }

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks Company ST → Google Sheets (append)');
  console.log('----------------------------------------------');

  const now     = new Date();
  const dd      = String(now.getDate()).padStart(2, '0');
  const mm      = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy    = now.getFullYear();
  const dateStr = `${dd}/${mm}/${yyyy}`;
  const weekNum = isoWeek(now);
  const month   = MONTHS[now.getMonth()];
  const dateAlt = `${yyyy}${mm}`;

  console.log(`  Snapshot: ${dateStr}  Week: ${weekNum}  Month: ${month}`);

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session token obtained. Server: ${session.server}`);

  console.log('Fetching items at Ogden Fulfilment...');
  const itemsWithLoc = await fetchItems(session);
  console.log(`  Found ${itemsWithLoc.length} item(s).`);

  const outputRows = itemsWithLoc
    .sort((a, b) => a.item.ItemNumber.localeCompare(b.item.ItemNumber))
    .map(({ item, loc }) => {
      const extMap = new Map<string, string>();
      for (const p of item.ItemExtendedProperties ?? []) {
        const name  = p.ProperyName   ?? '';
        const value = p.PropertyValue ?? '';
        if (name) extMap.set(name, value);
      }
      return [
        item.ItemNumber,
        item.ItemTitle,
        loc.Available,
        extMap.get('FBA SKU') ?? '',
        loc.MinimumLevel ?? '',
        dateStr,
        weekNum,
        yyyy,
        month,
        dateAlt,
      ];
    });

  // ── Google Sheets ──────────────────────────────────────────────────────
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${TAB_NAME}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: outputRows },
  });

  console.log(`  Done — ${outputRows.length} row(s) appended to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
