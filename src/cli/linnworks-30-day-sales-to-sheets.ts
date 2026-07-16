#!/usr/bin/env tsx
// linnworks-30-day-sales-to-sheets.ts
// Fetches the previous calendar month's eBay and Shopify orders from Linnworks
// and writes one row per order item to the "30 Day Sales" tab.
// Run: npx tsx src/cli/linnworks-30-day-sales-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import pLimit from 'p-limit';

const SPREADSHEET_ID = '1sF1lxqJMKJQpnsK3q6e7zzcDSucBDUsl0CHfwkocqcQ';
const TAB_NAME       = '30 Day Sales';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const HEADERS = ['nOrderId', 'dReceievedDate', 'OrderItemSKU', 'OrderItemQuantity'];

const ALLOWED_SOURCES = new Set(['EBAY', 'SHOPIFY']);

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

interface OrderItem {
  [key: string]: unknown;
}

interface ProcessedOrder {
  pkOrderID?:      string;
  nOrderId?:       number;
  dReceivedDate?:  string;
  Source?:         string;
  [key: string]:   unknown;
}

// ── Fetch orders ─────────────────────────────────────────────────────────────

async function fetchOrders(session: LinnworksSession, fromDate: string, toDate: string): Promise<ProcessedOrder[]> {
  const allOrders: ProcessedOrder[] = [];
  let pageNumber = 1;
  const pageSize = 500;

  while (true) {
    const resp = await fetch(`${session.server}/api/ProcessedOrders/SearchProcessedOrders`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        request: {
          DateField:      'received',
          FromDate:       fromDate,
          ToDate:         toDate,
          ExactMatch:     false,
          SearchField:    '',
          SearchTerm:     '',
          PageNumber:     pageNumber,
          ResultsPerPage: pageSize,
          Filters:        null,
        },
      }),
    });

    if (!resp.ok) throw new Error(`SearchProcessedOrders failed: ${resp.status} ${await resp.text()}`);

    const raw       = await resp.json() as Record<string, unknown>;
    const container = (raw['ProcessedOrders'] ?? raw) as Record<string, unknown>;
    const data      = (container['Data'] ?? container) as ProcessedOrder[];

    if (!Array.isArray(data) || !data.length) break;

    allOrders.push(...data);

    const totalPages = Number(container['TotalPages'] ?? 1);
    if (pageNumber >= totalPages || data.length < pageSize) break;
    pageNumber++;
  }

  return allOrders;
}

// ── Fetch items for one order ─────────────────────────────────────────────────

async function probeItemsEndpoint(session: LinnworksSession, pkOrderID: string, nOrderId: number): Promise<void> {
  const candidates: Array<{ label: string; method: string; url: string; body?: string; ct?: string }> = [
    { label: 'GET ProcessedOrders/GetProcessedOrderDetails',  method: 'GET',  url: `${session.server}/api/ProcessedOrders/GetProcessedOrderDetails?pkOrderId=${pkOrderID}` },
    { label: 'POST ProcessedOrders/GetProcessedOrderDetails', method: 'POST', url: `${session.server}/api/ProcessedOrders/GetProcessedOrderDetails`, body: JSON.stringify({ pkOrderId: pkOrderID }), ct: 'application/json' },
    { label: 'GET Orders/GetOrderItemsByNumOrderId',          method: 'GET',  url: `${session.server}/api/Orders/GetOrderItemsByNumOrderId?numOrderId=${nOrderId}` },
    { label: 'POST Orders/GetOrderById (JSON)',               method: 'POST', url: `${session.server}/api/Orders/GetOrderById`, body: JSON.stringify({ pkOrderId: pkOrderID }), ct: 'application/json' },
    { label: 'POST Orders/GetOrderItemsByOrderId (form)',     method: 'POST', url: `${session.server}/api/Orders/GetOrderItemsByOrderId`, body: `pkOrderId=${pkOrderID}`, ct: 'application/x-www-form-urlencoded' },
  ];

  for (const c of candidates) {
    const headers: Record<string, string> = { Authorization: session.token };
    if (c.ct) headers['Content-Type'] = c.ct;
    const init: RequestInit = { method: c.method, headers };
    if (c.body !== undefined) init.body = c.body;
    const r = await fetch(c.url, init);
    const text = await r.text();
    console.log(`  [probe] ${c.label} → ${r.status} | ${text.slice(0, 120)}`);
  }
}

let itemShapeLogged = false;

async function fetchOrderItems(session: LinnworksSession, pkOrderID: string): Promise<OrderItem[]> {
  const resp = await fetch(`${session.server}/api/Orders/GetOrderById`, {
    method:  'POST',
    headers: { Authorization: session.token, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pkOrderId: pkOrderID }),
  });

  if (!resp.ok) {
    console.warn(`  [warn] GetOrderById ${pkOrderID} → ${resp.status}`);
    return [];
  }

  const data = await resp.json() as Record<string, unknown>;

  if (!itemShapeLogged) {
    console.log('  [shape] Top-level keys:', Object.keys(data).join(', '));
    const itemsRaw = data['Items'] ?? data['OrderItems'] ?? data['Lines'] ?? data['OrderLines'];
    if (Array.isArray(itemsRaw) && itemsRaw.length > 0) {
      console.log('  [shape] Item[0] keys:', Object.keys(itemsRaw[0] as object).join(', '));
      console.log('  [shape] Item[0]:', JSON.stringify(itemsRaw[0]).slice(0, 300));
    } else {
      console.log('  [shape] Full response:', JSON.stringify(data).slice(0, 500));
    }
    itemShapeLogged = true;
  }

  const items = data['Items'] ?? data['OrderItems'] ?? data['Lines'] ?? data['OrderLines'] ?? [];
  return Array.isArray(items) ? items as OrderItem[] : [];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks 30 Day Sales → Google Sheets');
  console.log('---------------------------------------');

  const now              = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrevMonth  = new Date(firstOfThisMonth.getTime() - 1);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);

  const pad      = (n: number) => String(n).padStart(2, '0');
  const fromDate = `${firstOfPrevMonth.getFullYear()}-${pad(firstOfPrevMonth.getMonth() + 1)}-01T00:00:00`;
  const toDate   = `${lastOfPrevMonth.getFullYear()}-${pad(lastOfPrevMonth.getMonth() + 1)}-${pad(lastOfPrevMonth.getDate())}T23:59:59`;

  console.log(`  Date range: ${fromDate} → ${toDate}`);

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session token obtained. Server: ${session.server}`);

  console.log('Fetching processed orders...');
  const orders   = await fetchOrders(session, fromDate, toDate);
  const filtered = orders.filter(o => ALLOWED_SOURCES.has((o.Source ?? '').toUpperCase()));
  console.log(`  Total orders: ${orders.length} | eBay + Shopify: ${filtered.length}`);

  // Probe the first order to find which endpoint returns items
  if (filtered.length > 0) {
    const first = filtered[0]!;
    console.log(`\nProbing item endpoints for order ${first.nOrderId} (${first.pkOrderID})...`);
    await probeItemsEndpoint(session, first.pkOrderID as string, first.nOrderId as number);
    console.log('');
  }

  console.log('Fetching order items (concurrency 3)...');
  const limit          = pLimit(3);
  const ordersWithItems = await Promise.all(
    filtered.map(order => limit(async () => {
      const pkOrderID = order.pkOrderID as string | undefined;
      const items     = pkOrderID ? await fetchOrderItems(session, pkOrderID) : [];
      return { order, items };
    })),
  );

  const outputRows: string[][] = [];
  for (const { order, items } of ordersWithItems) {
    const orderId  = String(order.nOrderId ?? '');
    const received = String(order.dReceivedDate ?? '');
    if (!items.length) {
      outputRows.push([orderId, received, '', '']);
      continue;
    }
    for (const item of items) {
      const sku = String(item['SKU'] ?? item['sku'] ?? item['ItemSKU'] ?? item['ItemNumber'] ?? '');
      const qty = String(item['nQty'] ?? item['Qty'] ?? item['Quantity'] ?? item['qty'] ?? '');
      outputRows.push([orderId, received, sku, qty]);
    }
  }

  console.log(`  Rows to write: ${outputRows.length}`);

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
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody:      { values: [HEADERS, ...outputRows] },
  });

  console.log(`  Done — ${outputRows.length} row(s) written to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
