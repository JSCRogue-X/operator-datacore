#!/usr/bin/env tsx
// linnworks-fba-ih-linking-to-sheets.ts
// Writes FBA / IH linking data for all Ogden Fulfilment items to
// the "LinkFile New" tab in the FBA IH Linking File spreadsheet.
// Run: npx tsx src/cli/linnworks-fba-ih-linking-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1nx56b9f9yGbmDwnT7-yxTWEm19cYu4sOfOsYE73qyhQ';
const TAB_NAME       = 'LinkFile New';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS = [
  'Amazon FBA SKU', 'Barcode', 'SKU', 'ASIN', 'Title',
  'Supplier', 'IH Cost', 'FBA UK Cost', 'FBA EU Cost', 'IH Buffer',
];

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

// ── Types ───────────────────────────────────────────────────────────────────

interface ExtProp {
  ProperyName?:   string;
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
  BarcodeNumber?:          string;
  StockLevels?:            StockLevel[];
  ItemExtendedProperties?: ExtProp[];
  Suppliers?:              Array<Record<string, unknown>>;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

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
        dataRequirements:     ['StockLevels', 'ExtendedProperties', 'Supplier'],
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
  console.log('Linnworks FBA IH Linking → Google Sheets');
  console.log('-----------------------------------------');

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
      const ext    = (name: string): string => extMap.get(name) ?? '';
      const numExt = (name: string): number | '' => { const v = extMap.get(name); if (!v) return ''; const n = Number(v); return isNaN(n) ? '' : n; };
      const num    = (v: number | undefined): number | '' => (v !== undefined && v !== null) ? v : '';
      const numStr = (v: string | undefined): number | string => { if (!v) return ''; const n = Number(v); return isNaN(n) ? v : n; };

      const supplierRec = item.Suppliers?.[0];
      const pp = parseFloat(String(supplierRec?.['PurchasePrice'] ?? ''));
      const purchasePrice: number | '' = isNaN(pp) ? '' : pp;

      return [
        ext('FBA SKU'),                    // Amazon FBA SKU
        numStr(item.BarcodeNumber),        // Barcode
        item.ItemNumber,                   // SKU
        ext('ASIN'),                       // ASIN
        item.ItemTitle,                    // Title
        String(supplierRec?.['Supplier'] ?? ''),  // Supplier
        purchasePrice,                     // IH Cost (purchase price from supplier record)
        numExt('FBA_UK_Landed_Cost'),      // FBA UK Cost
        numExt('FBA_EU_Landed_Cost'),      // FBA EU Cost
        num(loc.MinimumLevel),             // IH Buffer
      ];
    });

  // ── Google Sheets ──────────────────────────────────────────────────────
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

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
    // Write header row on a brand-new sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  } else {
    sheetId = existingTab.properties?.sheetId ?? 0;
  }

  // Read existing SKU column (column C) to build row-position map
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!C:C`,
  });
  const existingSkuCol = existingData.data.values ?? [];

  // Row 1 is the header; data rows start at Sheets row 2 (array index 1)
  const skuToRow = new Map<string, number>();
  for (let i = 1; i < existingSkuCol.length; i++) {
    const sku = String(existingSkuCol[i]?.[0] ?? '');
    if (sku) skuToRow.set(sku, i + 1); // 1-based Sheets row number
  }
  console.log(`  ${skuToRow.size} existing SKU(s) found in sheet.`);

  // Classify each row: update in place or append as new
  const updateData: { range: string; values: (string | number)[][] }[] = [];
  const appendRows: (string | number)[][] = [];

  for (const row of outputRows) {
    const sku = String(row[2]); // SKU is column C (index 2)
    if (skuToRow.has(sku)) {
      const rowNum = skuToRow.get(sku)!;
      updateData.push({
        range: `${TAB_NAME}!A${rowNum}:J${rowNum}`,
        values: [row],
      });
    } else {
      appendRows.push(row);
    }
  }

  // Update existing rows (A:J only — any columns to the right are untouched)
  if (updateData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updateData },
    });
    console.log(`  Updated ${updateData.length} existing row(s).`);
  }

  // Append new SKUs at the bottom
  if (appendRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appendRows },
    });
    console.log(`  Appended ${appendRows.length} new row(s).`);
  }

  // Bold header row (idempotent)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }],
    },
  });

  console.log(`  Done — ${updateData.length} updated, ${appendRows.length} new, ${updateData.length + appendRows.length} total row(s) in "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
