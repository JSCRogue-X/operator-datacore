#!/usr/bin/env tsx
// linnworks-30-day-sales-to-sheets.ts
// Fetches the previous calendar month's eBay and Shopify orders from Linnworks
// and writes one row per order item to the "30 Day Sales" tab.
// Run: npx tsx src/cli/linnworks-30-day-sales-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';

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
  nOrderId?:       number;
  dReceievedDate?: string;
  Source?:         string;
  SubSource?:      string;
  Items?:          OrderItem[];
  [key: string]:   unknown;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchOrders(session: LinnworksSession, fromDate: string, toDate: string): Promise<ProcessedOrder[]> {
  const allOrders: ProcessedOrder[] = [];
  let pageNumber = 1;
  const pageSize = 500;
  let diagLogged = false;

  while (true) {
    const resp = await fetch(`${session.server}/api/ProcessedOrders/SearchProcessedOrders`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        DateField:      'received',
        FromDate:       fromDate,
        ToDate:         toDate,
        ExactMatch:     false,
        SearchField:    '',
        SearchTerm:     '',
        PageNumber:     pageNumber,
        ResultsPerPage: pageSize,
        Filters:        null,
      }),
    });

    if (!resp.ok) throw new Error(`SearchProcessedOrders failed: ${resp.status} ${await resp.text()}`);

    const raw = await resp.json() as unknown;

    // Diagnostic — log top-level shape once to confirm API response structure
    if (!diagLogged) {
      console.log('  [diag] Response top-level keys:', Object.keys(raw as object).join(', '));
      diagLogged = true;
    }

    // API may return { ProcessedOrders: { Data: [...], TotalPages: N } } or { Data: [...] }
    const container = (raw as Record<string, unknown>)['ProcessedOrders'] ?? raw;
    const data      = ((container as Record<string, unknown>)['Data'] ?? container) as ProcessedOrder[];

    if (!Array.isArray(data) || !data.length) break;

    // Diagnostic — log first order's keys and first item's keys once
    if (pageNumber === 1 && data.length > 0) {
      const first = data[0] as ProcessedOrder;
      if (first) {
        console.log('  [diag] First order keys:', Object.keys(first as object).join(', '));
        console.log('  [diag] First order Source:', first.Source, '| nOrderId:', first.nOrderId);
        const firstItem = first.Items?.[0];
        if (firstItem) {
          console.log('  [diag] First order item keys:', Object.keys(firstItem as object).join(', '));
          console.log('  [diag] First order item:', JSON.stringify(firstItem));
        } else {
          console.log('  [diag] No items on first order (may be in different field)');
        }
      }
    }

    allOrders.push(...data);

    const totalPages = Number((container as Record<string, unknown>)['TotalPages'] ?? 1);
    if (pageNumber >= totalPages || data.length < pageSize) break;
    pageNumber++;
  }

  return allOrders;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks 30 Day Sales → Google Sheets');
  console.log('---------------------------------------');

  // Previous calendar month date range
  const now             = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrevMonth  = new Date(firstOfThisMonth.getTime() - 1);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);

  const pad  = (n: number) => String(n).padStart(2, '0');
  const fromDate = `${firstOfPrevMonth.getFullYear()}-${pad(firstOfPrevMonth.getMonth() + 1)}-01T00:00:00`;
  const toDate   = `${lastOfPrevMonth.getFullYear()}-${pad(lastOfPrevMonth.getMonth() + 1)}-${pad(lastOfPrevMonth.getDate())}T23:59:59`;

  console.log(`  Date range: ${fromDate} → ${toDate}`);

  console.log('Authenticating with Linnworks...');
  const session = await getLinnworksSession();
  console.log(`  Session token obtained. Server: ${session.server}`);

  console.log('Fetching processed orders...');
  const orders = await fetchOrders(session, fromDate, toDate);
  console.log(`  Total orders fetched: ${orders.length}`);

  const filtered = orders.filter(o => ALLOWED_SOURCES.has((o.Source ?? '').toUpperCase()));
  console.log(`  eBay + Shopify orders: ${filtered.length}`);

  // Build one row per order item
  const outputRows: string[][] = [];
  for (const order of filtered) {
    const orderId   = String(order.nOrderId ?? '');
    const received  = String(order.dReceievedDate ?? '');
    const items     = order.Items ?? [];
    if (!items.length) {
      // Include orders with no items as a single row so they're visible
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
