#!/usr/bin/env tsx
// amazon-shipments-to-sheets.ts
// Fetches active FBA inbound shipments from Amazon SP-API (UK + DE) and
// writes them to the "Shipments" tab in the Automations spreadsheet.
// Run: npx tsx src/cli/amazon-shipments-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { SpApiClient } from '../lib/sp-api/client.js';

const SPREADSHEET_ID = '1AH5S_335Jj2BS18Am9i37hlAYo4UVaAGdUX94XpV7b4';
const TAB_NAME       = 'Shipments';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS = [
  'Shipment name', 'Shipment ID', 'Status', 'Created at', 'Last updated',
  'Ship to', 'SKUs', 'Units',
];

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', code: 'UK' },
  { id: 'A1PA6795UKMFR9', code: 'DE' },
];

// All non-terminal statuses — closed/cancelled/deleted are excluded
const ACTIVE_STATUSES = [
  'WORKING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED',
  'CHECKED_IN', 'RECEIVING', 'READY_TO_SHIP',
];

const STATUS_LABELS: Record<string, string> = {
  WORKING:       'Working',
  SHIPPED:       'Shipped',
  IN_TRANSIT:    'In transit',
  DELIVERED:     'Delivered',
  CHECKED_IN:    'Checked in',
  RECEIVING:     'Receiving',
  READY_TO_SHIP: 'Ready to ship',
  CLOSED:        'Closed',
};

// ── Types ───────────────────────────────────────────────────────────────────

interface InboundShipmentInfo {
  ShipmentId:                     string;
  ShipmentName:                   string;
  ShipmentStatus:                 string;
  DestinationFulfillmentCenterId: string;
}

interface ShipmentItem {
  SellerSKU:         string;
  QuantityShipped:   number;
  QuantityReceived?: number;
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function getShipments(
  client: SpApiClient,
  marketplaceId: string,
): Promise<InboundShipmentInfo[]> {
  const results: InboundShipmentInfo[] = [];
  let nextToken: string | undefined;

  do {
    const query: Record<string, string | string[] | undefined> = nextToken
      ? { QueryType: 'NEXT_TOKEN', NextToken: nextToken, MarketplaceId: marketplaceId }
      : { QueryType: 'SHIPMENT', ShipmentStatusList: ACTIVE_STATUSES, MarketplaceId: marketplaceId };

    const resp = await client.request<{
      payload: { ShipmentData?: InboundShipmentInfo[]; NextToken?: string };
    }>({ method: 'GET', path: '/fba/inbound/v0/shipments', query });

    results.push(...(resp.payload.ShipmentData ?? []));
    nextToken = resp.payload.NextToken;
  } while (nextToken);

  return results;
}

async function getShipmentItems(
  client: SpApiClient,
  shipmentId: string,
  marketplaceId: string,
): Promise<ShipmentItem[]> {
  const results: ShipmentItem[] = [];
  let nextToken: string | undefined;

  do {
    const query: Record<string, string | undefined> = {
      MarketplaceId: marketplaceId,
      ...(nextToken ? { NextToken: nextToken } : {}),
    };

    const resp = await client.request<{
      payload: { ItemData?: ShipmentItem[]; NextToken?: string };
    }>({ method: 'GET', path: `/fba/inbound/v0/shipments/${shipmentId}/items`, query });

    results.push(...(resp.payload.ItemData ?? []));
    nextToken = resp.payload.NextToken;
  } while (nextToken);

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Amazon Shipments → Google Sheets');
  console.log('---------------------------------');

  const clientId     = process.env.SP_API_LWA_CLIENT_ID;
  const clientSecret = process.env.SP_API_LWA_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const region       = (process.env.SP_API_REGION ?? 'eu') as 'na' | 'eu' | 'fe';
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('SP_API_LWA_CLIENT_ID, SP_API_LWA_CLIENT_SECRET, and SP_API_REFRESH_TOKEN must all be set');
  }
  const spClient = new SpApiClient({ region, clientId, clientSecret, refreshToken });

  // Fetch all active shipments across marketplaces; deduplicate by ShipmentId
  const shipmentMap = new Map<string, { info: InboundShipmentInfo; marketplaceId: string }>();
  for (const market of MARKETPLACES) {
    console.log(`\nFetching shipments for ${market.code}...`);
    const shipments = await getShipments(spClient, market.id);
    console.log(`  ${shipments.length} shipment(s)`);
    for (const s of shipments) {
      if (s.ShipmentName.toUpperCase().includes('AGL')) continue;
      shipmentMap.set(s.ShipmentId, { info: s, marketplaceId: market.id });
    }
  }
  console.log(`\nTotal unique shipments: ${shipmentMap.size}`);

  // Build output rows — fetch items per shipment for SKU count and unit totals
  const outputRows: (string | number)[][] = [];
  for (const [shipmentId, { info, marketplaceId }] of shipmentMap) {
    console.log(`  Items for ${shipmentId} (${info.ShipmentName})...`);
    const items = await getShipmentItems(spClient, shipmentId, marketplaceId);

    const skuCount      = new Set(items.map(i => i.SellerSKU)).size;
    const totalShipped  = items.reduce((n, i) => n + (i.QuantityShipped  ?? 0), 0);
    const totalReceived = items.reduce((n, i) => n + (i.QuantityReceived ?? 0), 0);

    outputRows.push([
      info.ShipmentName,
      info.ShipmentId,
      STATUS_LABELS[info.ShipmentStatus] ?? info.ShipmentStatus,
      '', // Created at   — not available from FBA Inbound v0 API
      '', // Last updated — not available from FBA Inbound v0 API
      info.DestinationFulfillmentCenterId,
      skuCount,
      `${totalReceived}/${totalShipped}`,
    ]);
  }

  // Sort by shipment name
  outputRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // ── Google Sheets ──────────────────────────────────────────────────────
  console.log('\nWriting to Google Sheets...');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTab  = spreadsheet.data.sheets?.find(s => s.properties?.title === TAB_NAME);
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

  console.log(`  Done — ${outputRows.length} shipment(s) written to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
