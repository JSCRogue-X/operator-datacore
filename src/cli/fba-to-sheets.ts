#!/usr/bin/env tsx
// Downloads Manage FBA Inventory report from SP-API and writes it to a Google Sheet.
// Report type: GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA (same file as Seller Central download)

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID ?? '1G2wv13Tl5p2-4IfeTaEC8jFf54_GUn80c_HkZy-an04';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'GB' },
  { id: 'A1PA6795UKMFR9', label: 'DE' },
];

const COLUMN_ORDER = [
  'snapshot-date', 'sku', 'fnsku', 'asin', 'product-name', 'condition',
  'available', 'pending-removal-quantity', 'inv-age-0-to-90-days',
  'inv-age-91-to-180-days', 'inv-age-181-to-270-days', 'inv-age-271-to-365-days',
  'inv-age-365-plus-days', 'currency', 'units-shipped-t7', 'units-shipped-t30',
  'units-shipped-t60', 'units-shipped-t90', 'alert', 'your-price', 'sales-price',
  'lowest-price-new-plus-shipping', 'lowest-price-used', 'recommended-action',
  'healthy-inventory-level', 'recommended-sales-price', 'recommended-sale-duration-days',
  'recommended-removal-quantity', 'estimated-cost-savings-of-recommended-actions',
  'sell-through', 'item-volume', 'volume-unit-measurement', 'storage-type',
  'storage-volume', 'marketplace', 'product-group', 'sales-rank', 'days-of-supply',
  'estimated-excess-quantity', 'weeks-of-cover-t30', 'weeks-of-cover-t90',
  'featuredoffer-price', 'sales-shipped-last-7-days', 'sales-shipped-last-30-days',
  'sales-shipped-last-60-days', 'sales-shipped-last-90-days', 'inv-age-0-to-30-days',
  'inv-age-31-to-60-days', 'inv-age-61-to-90-days', 'inv-age-181-to-330-days',
  'inv-age-331-to-365-days', 'estimated-storage-cost-next-month', 'inbound-quantity',
  'inbound-working', 'inbound-shipped', 'inbound-received', 'Total Reserved Quantity',
  'unfulfillable-quantity', 'quantity-to-be-charged-ais-241-270-days',
  'estimated-ais-241-270-days', 'quantity-to-be-charged-ais-271-300-days',
  'estimated-ais-271-300-days', 'quantity-to-be-charged-ais-301-330-days',
  'estimated-ais-301-330-days', 'quantity-to-be-charged-ais-331-365-days',
  'estimated-ais-331-365-days', 'quantity-to-be-charged-ais-365-plus-days',
  'estimated-ais-365-plus-days', 'historical-days-of-supply', 'fba-minimum-inventory-level',
  'fba-inventory-level-health-status', 'Recommended ship-in quantity',
  'Recommended ship-in date', 'Last updated date for Historical Days of Supply',
  'Exempted from Low-Inventory cost coverage fee?',
  'Low-Inventory cost coverage fee applied in current week?',
  'Short term historical days of supply / UK Reserved FC Transfer',
  'Long term historical days of supply', 'Inventory age snapshot date',
  'Inventory Supply at FBA / UK Total Days of Supply', 'Reserved FC Transfer',
  'Reserved FC Processing', 'Reserved Customer Order',
  'Total Days of Supply (including units from open shipments)',
];

const NUMERIC_COLS = new Set([
  'available', 'pending-removal-quantity',
  'inv-age-0-to-90-days', 'inv-age-91-to-180-days', 'inv-age-181-to-270-days',
  'inv-age-271-to-365-days', 'inv-age-365-plus-days',
  'units-shipped-t7', 'units-shipped-t30', 'units-shipped-t60', 'units-shipped-t90',
  'your-price', 'sales-price', 'lowest-price-new-plus-shipping', 'lowest-price-used',
  'healthy-inventory-level', 'recommended-sales-price', 'recommended-sale-duration-days',
  'recommended-removal-quantity', 'estimated-cost-savings-of-recommended-actions',
  'sell-through', 'item-volume', 'storage-volume', 'sales-rank', 'days-of-supply',
  'estimated-excess-quantity', 'weeks-of-cover-t30', 'weeks-of-cover-t90',
  'featuredoffer-price',
  'sales-shipped-last-7-days', 'sales-shipped-last-30-days',
  'sales-shipped-last-60-days', 'sales-shipped-last-90-days',
  'inv-age-0-to-30-days', 'inv-age-31-to-60-days', 'inv-age-61-to-90-days',
  'inv-age-181-to-330-days', 'inv-age-331-to-365-days',
  'estimated-storage-cost-next-month',
  'inbound-quantity', 'inbound-working', 'inbound-shipped', 'inbound-received',
  'Total Reserved Quantity', 'unfulfillable-quantity',
  'quantity-to-be-charged-ais-241-270-days', 'estimated-ais-241-270-days',
  'quantity-to-be-charged-ais-271-300-days', 'estimated-ais-271-300-days',
  'quantity-to-be-charged-ais-301-330-days', 'estimated-ais-301-330-days',
  'quantity-to-be-charged-ais-331-365-days', 'estimated-ais-331-365-days',
  'quantity-to-be-charged-ais-365-plus-days', 'estimated-ais-365-plus-days',
  'historical-days-of-supply', 'fba-minimum-inventory-level',
  'Recommended ship-in quantity',
  'Short term historical days of supply / UK Reserved FC Transfer',
  'Long term historical days of supply',
  'Inventory Supply at FBA / UK Total Days of Supply',
  'Reserved FC Transfer', 'Reserved FC Processing', 'Reserved Customer Order',
  'Total Days of Supply (including units from open shipments)',
]);

function parseVal(col: string, val: string): string | number {
  if (NUMERIC_COLS.has(col)) {
    const n = parseFloat(val);
    return isNaN(n) ? '' : n;
  }
  return val;
}

async function main() {
  console.log('FBA Inventory → Google Sheets');
  console.log('------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: env.SP_API_REGION,
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  // 1. Download report for each marketplace and combine rows
  console.log('Step 1: Downloading Manage FBA Inventory reports from Amazon...');

  const allRows: (string | number)[][] = [];

  for (const market of MARKETPLACES) {
    console.log(`  Requesting ${market.label} report...`);
    const report = await runReport(spClient, {
      reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
      marketplaceIds: [market.id],
    });

    const rows = parseTsv(report.rawText);
    for (const row of rows) {
      row['marketplace'] = market.label;
      allRows.push(COLUMN_ORDER.map(col => parseVal(col, row[col] ?? '')));
    }

    console.log(`    ${rows.length} rows (${Object.keys(rows[0] ?? {}).length} columns)`);

    if (market !== MARKETPLACES[MARKETPLACES.length - 1]) {
      console.log('  Waiting 70s before next report (rate limit)...');
      await new Promise(r => setTimeout(r, 70_000));
    }
  }

  console.log(`  Total: ${allRows.length} rows across UK + DE`);

  // 2. Write to Google Sheets
  console.log('Step 2: Writing to Google Sheet...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Get actual tab name
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetProps = spreadsheet.data.sheets?.[0]?.properties;
  const sheetId = sheetProps?.sheetId ?? 0;
  const sheetTitle = sheetProps?.title ?? 'Sheet1';
  console.log(`  Tab: "${sheetTitle}"`);

  // Clear and resize sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue' } },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { rowCount: allRows.length + 100, columnCount: COLUMN_ORDER.length },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ],
    },
  });

  // Write data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [COLUMN_ORDER, ...allRows] },
  });

  console.log(`  Done — ${allRows.length} rows written to Google Sheet`);
  console.log('');
  console.log('View your sheet: https://docs.google.com/spreadsheets/d/1G2wv13Tl5p2-4IfeTaEC8jFf54_GUn80c_HkZy-an04/edit');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
