#!/usr/bin/env tsx
// amazon-shipments-to-sheets.ts
// Fetches active FBA inbound shipments from Amazon SP-API
// Fulfillment Inbound v2024-03-20 and writes them to the "Shipments"
// tab in the Automations spreadsheet.
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

// Terminal shipment statuses — skip these rows
const EXCLUDED_STATUSES = new Set([
  'CLOSED', 'CANCELLED', 'DELETED', 'ABANDONED', 'INACTIVE',
]);

const STATUS_LABELS: Record<string, string> = {
  WORKING:       'Working',
  SHIPPED:       'Shipped',
  IN_TRANSIT:    'In transit',
  DELIVERED:     'Delivered',
  CHECKED_IN:    'Checked in',
  RECEIVING:     'Receiving',
  READY_TO_SHIP: 'Ready to ship',
  MIXED:         'Mixed',
  RECEIVED:      'Received',
  CLOSED:        'Closed',
};

// ── Types for v2024-03-20 API ────────────────────────────────────────────────

interface InboundPlan {
  inboundPlanId: string;
  name:          string;
  status:        string;
  createdAt?:    string;
  updatedAt?:    string;
}

interface V2024Shipment {
  shipmentId:   string;
  warehouseId?: string;
  status?:      string;
  name?:        string;
}

interface V2024Item {
  msku:               string;
  quantity?:          number;
  quantityReceived?:  number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── API helpers (v2024-03-20) ────────────────────────────────────────────────

async function listAllPlans(client: SpApiClient): Promise<InboundPlan[]> {
  const results: InboundPlan[] = [];
  let paginationToken: string | undefined;

  do {
    const query: Record<string, string | number | undefined> = {
      pageSize: 30,
      sortBy:    'LAST_UPDATED_TIME',
      sortOrder: 'DESC',
      ...(paginationToken ? { paginationToken } : {}),
    };

    const resp = await client.request<{
      inboundPlans?: InboundPlan[];
      pagination?:   { nextToken?: string };
    }>({ method: 'GET', path: '/inbound/fba/2024-03-20/inboundPlans', query });

    results.push(...(resp.payload.inboundPlans ?? []));
    paginationToken = resp.payload.pagination?.nextToken;
  } while (paginationToken);

  return results;
}

async function listShipments(client: SpApiClient, planId: string): Promise<V2024Shipment[]> {
  const results: V2024Shipment[] = [];
  let paginationToken: string | undefined;

  do {
    const query: Record<string, string | number | undefined> = {
      pageSize: 30,
      ...(paginationToken ? { paginationToken } : {}),
    };

    const resp = await client.request<{
      shipments?:  V2024Shipment[];
      pagination?: { nextToken?: string };
    }>({ method: 'GET', path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments`, query });

    results.push(...(resp.payload.shipments ?? []));
    paginationToken = resp.payload.pagination?.nextToken;
  } while (paginationToken);

  return results;
}

async function listShipmentItems(client: SpApiClient, planId: string, shipmentId: string): Promise<V2024Item[]> {
  const results: V2024Item[] = [];
  let paginationToken: string | undefined;

  do {
    const query: Record<string, string | number | undefined> = {
      pageSize: 30,
      ...(paginationToken ? { paginationToken } : {}),
    };

    const resp = await client.request<{
      items?:      V2024Item[];
      pagination?: { nextToken?: string };
    }>({ method: 'GET', path: `/inbound/fba/2024-03-20/inboundPlans/${planId}/shipments/${shipmentId}/items`, query });

    results.push(...(resp.payload.items ?? []));
    paginationToken = resp.payload.pagination?.nextToken;
  } while (paginationToken);

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Amazon Shipments → Google Sheets (v2024-03-20)');
  console.log('------------------------------------------------');

  const clientId     = process.env.SP_API_LWA_CLIENT_ID;
  const clientSecret = process.env.SP_API_LWA_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const region       = (process.env.SP_API_REGION ?? 'eu') as 'na' | 'eu' | 'fe';
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('SP_API_LWA_CLIENT_ID, SP_API_LWA_CLIENT_SECRET, and SP_API_REFRESH_TOKEN must all be set');
  }
  const spClient = new SpApiClient({ region, clientId, clientSecret, refreshToken });

  console.log('Fetching inbound plans...');
  const plans = await listAllPlans(spClient);
  console.log(`  ${plans.length} plan(s) found`);

  const outputRows: (string | number)[][] = [];

  for (const plan of plans) {
    if (plan.name.toUpperCase().includes('AGL')) {
      console.log(`  Skipping AGL: ${plan.name}`);
      continue;
    }

    const shipments = await listShipments(spClient, plan.inboundPlanId);
    const active    = shipments.filter(s => !EXCLUDED_STATUSES.has(s.status ?? ''));
    if (active.length === 0) continue;

    console.log(`  ${plan.name} → ${active.length} active shipment(s)`);

    for (const shipment of active) {
      const items        = await listShipmentItems(spClient, plan.inboundPlanId, shipment.shipmentId);
      const skuCount     = new Set(items.map(i => i.msku)).size;
      const totalExpect  = items.reduce((n, i) => n + (i.quantity         ?? 0), 0);
      const totalReceived = items.reduce((n, i) => n + (i.quantityReceived ?? 0), 0);

      outputRows.push([
        plan.name,
        shipment.shipmentId,
        STATUS_LABELS[shipment.status ?? ''] ?? (shipment.status ?? ''),
        formatDate(plan.createdAt),
        formatDate(plan.updatedAt),
        shipment.warehouseId ?? '',
        skuCount,
        `${totalReceived}/${totalExpect}`,
      ]);
    }
  }

  outputRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  console.log(`\nTotal rows: ${outputRows.length}`);

  // ── Google Sheets ──────────────────────────────────────────────────────
  console.log('Writing to Google Sheets...');
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
