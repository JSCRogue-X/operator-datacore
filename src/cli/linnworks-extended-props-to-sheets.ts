#!/usr/bin/env tsx
// linnworks-extended-props-to-sheets.ts
// Fetches all items at Ogden Fulfilment with their extended properties and
// stock levels, writing to the "Extended Prop" tab in Google Sheets.
// Run: npx tsx src/cli/linnworks-extended-props-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ';
const TAB_NAME       = 'Extended Prop';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

// Column order as specified — SC-SupplierCode appears twice intentionally
const HEADERS = [
  'SKU', 'Item Title', 'Category', 'Barcode Number',
  'Commodity Codes', 'CN22', 'HSTariffCode', 'SC-CartonSize',
  'SC-SupplierCode', 'SC-CartonWeight', 'CountryOfOrigin', 'SC-PalletQuantity',
  'SC-StorageType', 'CaseSize', 'SC-PalletCartons', 'Is Archived',
  'Weight', 'Height', 'Dim Width', 'Depth', 'ASIN', 'CBM',
  'SC-SupplierCode',
  'Stock due at location', 'Stock level at location', 'Max Level',
  'Stock minimum level at location', 'Stock Location', 'Short Title',
  'UnitQuantity', 'Stock available level at location', 'FBA SKU',
  'SC-PalletQuantity-DE',
];

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
  ProperyName?:   string; // Linnworks typo — missing 't' in PropERTYName
  PropertyValue?: string;
}

interface StockLevel {
  Location?:     { StockLocationId: string; LocationName: string };
  Available:     number;
  StockLevel?:   number;
  Due?:          number;  // "Stock due at location"
  MinimumLevel?: number;
}

interface RawItem {
  StockItemId:             string;
  ItemNumber:              string;
  ItemTitle:               string;
  CategoryName?:           string;
  BarcodeNumber?:          string;
  Weight?:                 number;
  Height?:                 number;
  Width?:                  number;
  Depth?:                  number;
  StockLevels?:            StockLevel[];
  ItemExtendedProperties?: ExtProp[];
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchAllItems(session: LinnworksSession): Promise<{ item: RawItem; loc: StockLevel }[]> {
  const locationKey = process.env.LINNWORKS_LOCATION_KEY;
  if (!locationKey) throw new Error('LINNWORKS_LOCATION_KEY not set');

  const results: { item: RawItem; loc: StockLevel }[] = [];
  const EXCLUDED_CATEGORIES = new Set(['Stationary', 'Discontinued SPINCARE', 'Default']);
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

// ── Build row ───────────────────────────────────────────────────────────────

function buildRow(item: RawItem, loc: StockLevel): (string | number)[] {
  const extMap = new Map<string, string>();
  for (const p of item.ItemExtendedProperties ?? []) {
    const name  = p.ProperyName   ?? ''; // Linnworks typo — ProperyName not PropertyName
    const value = p.PropertyValue ?? '';
    if (name) extMap.set(name, value);
  }
  const ext = (name: string) => extMap.get(name) ?? '';
  const num = (v: number | undefined): number | '' => (v !== undefined && v !== null) ? v : '';

  return [
    item.ItemNumber,                    // SKU
    item.ItemTitle,                     // Item Title
    item.CategoryName    ?? '',         // Category
    item.BarcodeNumber   ?? '',         // Barcode Number
    ext('CommodityCode'),               // Commodity Codes
    ext('CN22Description'),             // CN22
    ext('HSTariffCode'),                // HSTariffCode
    ext('SC-CartonSize'),               // SC-CartonSize
    ext('SC-SupplierCode'),             // SC-SupplierCode
    ext('SC-CartonWeight'),             // SC-CartonWeight
    ext('CountryOfOrigin'),             // CountryOfOrigin
    ext('SC-PalletQuantity-UK'),         // SC-PalletQuantity
    ext('SC-StorageType'),              // SC-StorageType
    ext('CaseSize'),                    // CaseSize
    ext('SC-PalletCartons'),            // SC-PalletCartons
    '',                                 // Is Archived — field TBC after first run
    num(item.Weight),                   // Weight
    num(item.Height),                   // Height
    num(item.Width),                    // Dim Width
    num(item.Depth),                    // Depth
    ext('ASIN'),                        // ASIN
    ext('SC-CartonCBM'),                // CBM
    ext('SC-SupplierCode'),             // SC-SupplierCode (duplicate per spec)
    num(loc.Due),                        // Stock due at location
    num(loc.StockLevel),                // Stock level at location
    ext('Max Level'),                    // Max Level — extended property
    num(loc.MinimumLevel),              // Stock minimum level at location
    loc.Location?.LocationName ?? '',   // Stock Location
    ext('Short Title'),                 // Short Title
    ext('UnitQuantity'),                // UnitQuantity
    loc.Available,                      // Stock available level at location
    ext('FBA SKU'),                     // FBA SKU
    ext('SC-PalletQuantity-DE'),        // SC-PalletQuantity-DE
  ];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks Extended Properties → Google Sheets');
  console.log('----------------------------------------------');

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session token obtained. Server: ${session.server}`);

  console.log('Fetching all items at Ogden Fulfilment...');
  const itemsWithLoc = await fetchAllItems(session);
  console.log(`  Found ${itemsWithLoc.length} item(s) at Ogden Fulfilment.`);

  const outputRows = itemsWithLoc
    .map(({ item, loc }) => buildRow(item, loc))
    .sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')));

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
  } else {
    sheetId = existingTab.properties?.sheetId ?? 0;
  }

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

  console.log(`  Done — ${outputRows.length} row(s) written to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
