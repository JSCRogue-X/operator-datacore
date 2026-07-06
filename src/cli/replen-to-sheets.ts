#!/usr/bin/env tsx
// replen-to-sheets.ts
// Writes FBA Replenishment data to Google Sheets with colour-coded status rows.
// Run: npx tsx src/cli/replen-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const SPREADSHEET_ID = '1AZloy19ApMY52-QcA9ECsAExOkcYN0Il04f64fFFY7g';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
  ?? 'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'UK' },
  { id: 'A1PA6795UKMFR9', label: 'EU (DE)' },
] as const;

type Status = 'URGENT' | 'WARN' | 'OK' | 'EXCESS';

const URGENT_DOS = 30;
const WARN_DOS   = 60;

const STATUS_COLOURS: Record<Status, { red: number; green: number; blue: number }> = {
  URGENT: { red: 0.96, green: 0.40, blue: 0.40 },
  WARN:   { red: 1.00, green: 0.80, blue: 0.35 },
  OK:     { red: 0.72, green: 0.88, blue: 0.72 },
  EXCESS: { red: 0.68, green: 0.78, blue: 0.94 },
};

const HEADERS = [
  'STATUS', 'REGION', 'SKU', 'ASIN', 'PRODUCT',
  'AVAILABLE', 'INBOUND', 'DAYS OF SUPPLY',
  'SHIP-IN QTY', 'SHIP-IN DATE', 'AMAZON ACTION',
];

interface ReplRow {
  status: Status;
  location: string;
  sku: string;
  asin: string;
  name: string;
  available: number;
  inbound: number;
  daysOfSupply: number | null;
  recommendedShipIn: number;
  shipInDate: string;
  action: string;
}

function deriveStatus(daysOfSupply: number | null, excessQty: number): Status {
  if (daysOfSupply === null || daysOfSupply < URGENT_DOS) return 'URGENT';
  if (daysOfSupply < WARN_DOS)                            return 'WARN';
  if (excessQty > 0)                                      return 'EXCESS';
  return 'OK';
}

function toSheetRow(r: ReplRow): (string | number)[] {
  return [
    r.status,
    r.location,
    r.sku,
    r.asin,
    r.name,
    r.available,
    r.inbound > 0 ? r.inbound : '',
    r.daysOfSupply === null ? 'OOS' : Math.min(Math.round(r.daysOfSupply), 366),
    r.recommendedShipIn > 0 ? r.recommendedShipIn : '',
    r.shipInDate || '',
    r.action,
  ];
}

async function main() {
  console.log('FBA Replen → Google Sheets');
  console.log('--------------------------');

  const env = loadEnvForAmazon();
  const client = new SpApiClient({
    region: 'eu',
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const allRows: ReplRow[] = [];

  for (const mkt of MARKETPLACES) {
    console.log(`\nFetching ${mkt.label} inventory planning report...`);
    let report;
    try {
      report = await runReport(client, {
        reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
        marketplaceIds: [mkt.id],
      });
    } catch (err) {
      console.error(`  FATAL for ${mkt.label}: ${(err as Error).message}`);
      continue;
    }

    const rows = parseTsv(report.rawText);
    for (const r of rows) {
      const available        = parseInt(r['available'] ?? '0', 10) || 0;
      const dosRaw           = r['Total Days of Supply (including units from open shipments)'] ?? r['days-of-supply'] ?? '';
      const daysOfSupply     = dosRaw !== '' ? parseFloat(dosRaw) : null;
      const excessQty        = parseFloat(r['estimated-excess-quantity'] ?? '0') || 0;
      const inbound          = (parseInt(r['inbound-shipped'] ?? '0', 10) || 0)
                             + (parseInt(r['inbound-received'] ?? '0', 10) || 0);
      const recommendedShipIn = parseInt(r['Recommended ship-in quantity'] ?? '0', 10) || 0;
      const shipInDate        = r['Recommended ship-in date'] ?? '';
      const action            = r['recommended-action'] ?? '';

      allRows.push({
        status: deriveStatus(daysOfSupply, excessQty),
        location: mkt.label,
        sku:      r['sku'] ?? '',
        asin:     r['asin'] ?? '',
        name:     r['product-name'] ?? '',
        available,
        inbound,
        daysOfSupply,
        recommendedShipIn,
        shipInDate,
        action,
      });
    }

    console.log(`  ${mkt.label}: ${rows.length} SKUs fetched`);

    if (mkt !== MARKETPLACES[MARKETPLACES.length - 1]) {
      console.log('  Waiting 70s before next report (rate limit)...');
      await new Promise(r => setTimeout(r, 70_000));
    }
  }

  if (allRows.length === 0) {
    console.log('\nNo data returned — nothing written.');
    return;
  }

  // Sort: URGENT → WARN → OK → EXCESS, then by DoS ascending within each group
  const ORDER: Record<Status, number> = { URGENT: 0, WARN: 1, OK: 2, EXCESS: 3 };
  allRows.sort((a, b) => {
    const sd = ORDER[a.status] - ORDER[b.status];
    if (sd !== 0) return sd;
    return (a.daysOfSupply ?? -1) - (b.daysOfSupply ?? -1);
  });

  const dataRows = allRows.map(toSheetRow);

  // ── Google Sheets ──────────────────────────────────────────────────────────
  console.log('\nWriting to Google Sheet...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetProps  = spreadsheet.data.sheets?.[0]?.properties;
  const sheetId     = sheetProps?.sheetId ?? 0;
  const sheetTitle  = sheetProps?.title ?? 'Sheet1';
  console.log(`  Tab: "${sheetTitle}"`);

  // Clear existing content and resize
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount:    dataRows.length + 10,
                columnCount: HEADERS.length,
              },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        },
      ],
    },
  });

  // Write header + data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS, ...dataRows] },
  });

  // Colour each data row by status
  const colourRequests = allRows.map((row, i) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex:   i + 1,
        endRowIndex:     i + 2,
        startColumnIndex: 0,
        endColumnIndex:  HEADERS.length,
      },
      cell: { userEnteredFormat: { backgroundColor: STATUS_COLOURS[row.status] } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        // Bold + dark header row
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
            cell: {
              userEnteredFormat: {
                textFormat:      { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
              },
            },
            fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor',
          },
        },
        // Freeze header row
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        ...colourRequests,
      ],
    },
  });

  const urgent = allRows.filter(r => r.status === 'URGENT').length;
  const warn   = allRows.filter(r => r.status === 'WARN').length;
  const ok     = allRows.filter(r => r.status === 'OK').length;
  const excess = allRows.filter(r => r.status === 'EXCESS').length;

  console.log(`\nDone — ${allRows.length} rows written`);
  console.log(`Summary: ${urgent} URGENT  |  ${warn} WARN  |  ${ok} OK  |  ${excess} EXCESS`);
  console.log(`\nView: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
