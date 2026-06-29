#!/usr/bin/env tsx
// Builds a custom Active Listings report by joining:
//   - GET_MERCHANT_LISTINGS_ALL_DATA (SKU, ASIN, Status)
//   - GET_FBA_INVENTORY_PLANNING_DATA (FBA quantities, ASIN 5)
// Writes to "Active Listings" tab of the Automations sheet. Overwrites each run.

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.IPI_SHEET_ID ?? '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Active Listings';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', code: 'GB' },
  { id: 'A1PA6795UKMFR9', code: 'DE' },
  { id: 'A13V1IB3VIYZZH', code: 'FR' },
  { id: 'APJ6JRA9NG5V4',  code: 'IT' },
  { id: 'A1RKKUPIHCS9HS', code: 'ES' },
  { id: 'A1805IZSGTT6HS', code: 'NL' },
  { id: 'A28R8C7NBKEWEA', code: 'IE' },
  { id: 'AMEN7PMS3EDWL',  code: 'BE' },
  { id: 'A2NODRKZP88ZB9', code: 'SE' },
];

const HEADERS = [
  'SKU',
  'ASIN',
  'Marketplace Country Code',
  'Status',
  'FBA fulfillable quantity (local)',
  'FBA total quantity',
  'FBA warehouse quantity',
  'ASIN 5',
];

async function wait70s() {
  console.log('  Waiting 70s (rate limit)...');
  await new Promise(r => setTimeout(r, 70_000));
}

async function main() {
  console.log('Active Listings → Google Sheets');
  console.log('--------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const allRows: string[][] = [];

  for (let i = 0; i < MARKETPLACES.length; i++) {
    const market = MARKETPLACES[i]!;
    console.log(`\n[${market.code}] Fetching listings...`);

    try {
      // All Listings report — SKU, ASIN, Status
      const listingsReport = await runReport(spClient, {
        reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
        marketplaceIds: [market.id],
      });
      const listingsRows = parseTsv(listingsReport.rawText);
      console.log(`  ${listingsRows.length} listings`);

      // Build a map of SKU → listing data
      const listingsBySku = new Map<string, Record<string, string>>();
      for (const row of listingsRows) {
        const sku = row['seller-sku'] ?? '';
        if (sku) listingsBySku.set(sku, row);
      }

      await wait70s();

      // FBA Inventory Planning report — FBA quantities + ASIN 5
      const fbaReport = await runReport(spClient, {
        reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
        marketplaceIds: [market.id],
      });
      const fbaRows = parseTsv(fbaReport.rawText);
      console.log(`  ${fbaRows.length} FBA inventory rows`);

      for (const fbaRow of fbaRows) {
        const sku = fbaRow['sku'] ?? '';
        const listing = listingsBySku.get(sku) ?? {};

        const available = parseInt(fbaRow['available'] ?? '0', 10) || 0;
        const reserved = parseInt(fbaRow['Total Reserved Quantity'] ?? '0', 10) || 0;
        const unfulfillable = parseInt(fbaRow['unfulfillable-quantity'] ?? '0', 10) || 0;
        const totalQty = available + reserved + unfulfillable;

        allRows.push([
          sku,
          listing['asin1'] ?? '',
          market.code,
          listing['status'] ?? '',
          fbaRow['available'] ?? '',
          String(totalQty),
          fbaRow['Total Reserved Quantity'] ?? '',
          fbaRow['asin'] ?? '',
        ]);
      }
    } catch (err) {
      console.warn(`  [${market.code}] Skipped — report failed: ${(err as Error).message}`);
    }

    if (i < MARKETPLACES.length - 1) await wait70s();
  }

  console.log(`\nTotal: ${allRows.length} rows across all marketplaces`);

  console.log('\nWriting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Create tab if it doesn't exist
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

  // Clear and resize
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { rowCount: allRows.length + 10, columnCount: HEADERS.length },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS, ...allRows] },
  });

  console.log(`  Done — ${allRows.length} rows written to "${TAB_NAME}"`);
  console.log('\nView: https://docs.google.com/spreadsheets/d/1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4/edit');
}

main().catch(err => { console.error(err); process.exit(1); });
