#!/usr/bin/env tsx
// linnworks-replen-to-sheets.ts
// Fetches replenishment data for all items at Ogden Fulfilment
// and writes them to the "Replen" tab in Google Sheets.
// Run: npx tsx src/cli/linnworks-replen-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ';
const TAB_NAME       = 'Replen';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS = [
  'SKU', 'Item Title', 'Barcode Number', 'Category',
  'Stock available level at location', 'Purchase Price', 'Weight', 'Stock Location',
  'CaseSize', 'SC-CartonWeight', 'SC-PalletQuantity-UK', 'Stock due at location',
  'Is Archived', 'Commodity Code', 'Country Of Origin', 'CN22 Description',
  'Carton Dimensions', 'SC-CartonCBM', 'ASIN', 'FBA SKU',
  'SC-Title', 'Height', 'Dim Width', 'Depth',
  'SC-PalletQuantity-DE', 'EBAY PRICE', 'Default Packaging Group', 'Postage Type',
  'SC-SupplierCode', 'SC-UnitPriceUSD', 'SC-Supplier-PQ', 'SC-SupplierTitle',
  'Supplier Name',
  'EU_Inbound_DD_Duty_Cost', 'FBA_3_Month_Storage_Cost',
  'FBA_UK_Inbound_Cost', 'FBA_EU_Inbound_Cost',
  'FBA_UK_Landed_Cost', 'FBA_EU_Landed_Cost',
  'AGL Detailed Description of Merchandise in English', 'AGL Material',
  'Stock level at location', 'Stock minimum level at location',
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
  ProperyName?:   string; // Linnworks typo — missing 't'
  PropertyValue?: string;
}

interface StockLevel {
  Location?:     { StockLocationId: string; LocationName: string };
  Available:     number;
  StockLevel?:   number;
  Due?:          number;
  MinimumLevel?: number;
}

interface Supplier {
  [key: string]: unknown;
}

interface ChannelPrice {
  Source?:    string;
  SubSource?: string;
  [key: string]: unknown;
}

interface RawItem {
  ItemNumber:              string;
  ItemTitle:               string;
  CategoryName?:           string;
  BarcodeNumber?:          string;
  PurchasePrice?:          number;
  PackageGroupName?:       string;
  Weight?:                 number;
  Height?:                 number;
  Width?:                  number;
  Depth?:                  number;
  StockLevels?:            StockLevel[];
  ItemExtendedProperties?: ExtProp[];
  Suppliers?:              Supplier[];
  ItemChannelPrices?:      ChannelPrice[];
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
        dataRequirements:     ['StockLevels', 'ExtendedProperties', 'Supplier', 'ChannelPrice'],
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
    const name  = p.ProperyName   ?? '';
    const value = p.PropertyValue ?? '';
    if (name) extMap.set(name, value);
  }
  const ext    = (name: string): string => extMap.get(name) ?? '';
  const num    = (v: number | undefined): number | '' => (v !== undefined && v !== null) ? v : '';
  const numExt = (name: string): number | '' => { const v = extMap.get(name); if (!v) return ''; const n = Number(v); return isNaN(n) ? '' : n; };

  // Supplier data — field is 'Supplier' (confirmed from API)
  const supplier = item.Suppliers?.[0] as Record<string, unknown> | undefined;
  const supplierName = String(supplier?.['Supplier'] ?? '');

  // EBAY PRICE from channel pricing (Source = EBAY, SubSource = EBAY1_UK)
  const ebayChannel = item.ItemChannelPrices?.find(p => p.Source === 'EBAY') as Record<string, unknown> | undefined;
  const ebayPrice: string | number = ebayChannel
    ? ((ebayChannel['Price'] ?? ebayChannel['RetailPrice'] ?? ebayChannel['SalePrice'] ?? '') as string | number)
    : '';

  return [
    item.ItemNumber,                    // SKU
    item.ItemTitle,                     // Item Title
    item.BarcodeNumber      ?? '',      // Barcode Number
    item.CategoryName       ?? '',      // Category
    loc.Available,                      // Stock available level at location
    num(item.PurchasePrice),            // Purchase Price
    num(item.Weight),                   // Weight
    loc.Location?.LocationName ?? '',   // Stock Location
    numExt('CaseSize'),                 // CaseSize
    numExt('SC-CartonWeight'),          // SC-CartonWeight
    numExt('SC-PalletQuantity-UK'),     // SC-PalletQuantity-UK
    num(loc.Due),                       // Stock due at location
    '',                                 // Is Archived — not exposed in API
    ext('CommodityCode'),               // Commodity Code
    ext('CountryOfOrigin'),             // Country Of Origin
    ext('CN22Description'),             // CN22 Description
    ext('SC-CartonSize'),                // Carton Dimensions
    numExt('SC-CartonCBM'),             // SC-CartonCBM
    ext('ASIN'),                        // ASIN
    ext('FBA SKU'),                     // FBA SKU
    ext('SC-Title'),                    // SC-Title — name TBC from diagnostic
    num(item.Height),                   // Height
    num(item.Width),                    // Dim Width
    num(item.Depth),                    // Depth
    numExt('SC-PalletQuantity-DE'),     // SC-PalletQuantity-DE
    ebayPrice,                          // EBAY PRICE — from channel pricing (Source=EBAY)
    item.PackageGroupName   ?? '',      // Default Packaging Group
    ext('PostageType'),                 // Postage Type
    ext('SC-SupplierCode'),             // SC-SupplierCode
    numExt('SC-UnitPriceUSD'),          // SC-UnitPriceUSD
    numExt('SC-Supplier-PQ'),           // SC-Supplier-PQ
    ext('SC-SupplierTitle'),            // SC-SupplierTitle
    supplierName,                       // Supplier Name
    numExt('EU_Inbound_DD_Duty_Cost'),  // EU_Inbound_DD_Duty_Cost
    numExt('FBA_3_Month_Storage_Cost'), // FBA_3_Month_Storage_Cost
    numExt('FBA_UK_Inbound_Cost'),      // FBA_UK_Inbound_Cost
    numExt('FBA_EU_Inbound_Cost'),      // FBA_EU_Inbound_Cost
    numExt('FBA_UK_Landed_Cost'),       // FBA_UK_Landed_Cost
    numExt('FBA_EU_Landed_Cost'),       // FBA_EU_Landed_Cost
    ext('AGL-Detailed-Description-of-Merchandise-in-English'), // AGL description
    ext('AGL-Material'),                // AGL Material
    num(loc.StockLevel),                // Stock level at location
    num(loc.MinimumLevel),              // Stock minimum level at location
  ];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks Replen → Google Sheets');
  console.log('----------------------------------');

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session token obtained. Server: ${session.server}`);

  console.log('Fetching items at Ogden Fulfilment...');
  const itemsWithLoc = await fetchItems(session);
  console.log(`  Found ${itemsWithLoc.length} item(s).`);

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
