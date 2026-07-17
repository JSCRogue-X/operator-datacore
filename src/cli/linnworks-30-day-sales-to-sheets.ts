#!/usr/bin/env tsx
// linnworks-30-day-sales-to-sheets.ts
// Fetches the previous calendar month's eBay and Shopify orders from Linnworks
// and writes one aggregated row per Week Start / Source / SKU to the "30 Day Sales" tab.
// Run: npx tsx src/cli/linnworks-30-day-sales-to-sheets.ts

import 'dotenv/config';
import { google } from 'googleapis';
import pLimit from 'p-limit';

const SPREADSHEET_ID = '1mIk4mrFisXIpen2zZpnmxHWDRtmbjX6Ikyao_EzWZ3M';
const TAB_NAME       = 'IHS2';
const KEY_FILE       = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';

const ALLOWED_SOURCES = new Set(['EBAY', 'SHOPIFY']);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Date helpers ─────────────────────────────────────────────────────────────

function isoWeek(d: Date): number {
  const date   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function mondayOf(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day  = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date;
}

// Google Sheets date serial — days since 30 Dec 1899
function toSheetsSerial(d: Date): number {
  return Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

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
  SKU?:      string;
  Quantity?: number;
  [key: string]: unknown;
}

interface ProcessedOrder {
  pkOrderID?:     string;
  nOrderId?:      number;
  dReceivedDate?: string;
  Source?:        string;
  [key: string]:  unknown;
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

async function fetchOrderItems(session: LinnworksSession, pkOrderID: string): Promise<OrderItem[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(`${session.server}/api/Orders/GetOrderById`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pkOrderId: pkOrderID }),
    });

    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }

    if (!resp.ok) {
      console.warn(`  [warn] GetOrderById ${pkOrderID} → ${resp.status}`);
      return [];
    }

    const data  = await resp.json() as Record<string, unknown>;
    const items = data['Items'];
    return Array.isArray(items) ? items as OrderItem[] : [];
  }

  console.warn(`  [warn] GetOrderById ${pkOrderID} → gave up after 429 retries`);
  return [];
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

  console.log('Fetching order items...');
  const limit          = pLimit(2);
  const ordersWithItems = await Promise.all(
    filtered.map(order => limit(async () => {
      const pkOrderID = order.pkOrderID as string | undefined;
      const items     = pkOrderID ? await fetchOrderItems(session, pkOrderID) : [];
      return { order, items };
    })),
  );

  // Aggregate by Week Start + SKU
  interface AggRow { weekStart: Date; year: number; month: string; weekNo: number; sku: string; qty: number }
  const aggMap = new Map<string, AggRow>();

  for (const { order, items } of ordersWithItems) {
    const orderDate = new Date(String(order.dReceivedDate ?? ''));
    if (isNaN(orderDate.getTime())) continue;

    const wStart = mondayOf(orderDate);
    const wNo    = isoWeek(orderDate);
    const year   = wStart.getUTCFullYear();
    const month  = MONTHS[wStart.getUTCMonth()] ?? '';

    for (const item of items) {
      const sku = String(item.SKU ?? '').trim();
      if (!sku) continue;
      const qty = Number(item.Quantity) || 0;
      const key = `${wStart.getTime()}|${sku}`;

      const existing = aggMap.get(key);
      if (existing) {
        existing.qty += qty;
      } else {
        aggMap.set(key, { weekStart: wStart, year, month, weekNo: wNo, sku, qty });
      }
    }
  }

  const outputRows: (string | number)[][] = Array.from(aggMap.values())
    .sort((a, b) =>
      a.weekStart.getTime() - b.weekStart.getTime() ||
      a.sku.localeCompare(b.sku),
    )
    .map(r => [toSheetsSerial(r.weekStart), r.year, r.month, r.weekNo, r.sku, r.qty]);

  console.log(`  Rows to write: ${outputRows.length}`);

  // ── Google Sheets ──────────────────────────────────────────────────────
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Append to next available row — no clearing, no headers
  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${TAB_NAME}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: outputRows },
  });

  console.log(`  Done — ${outputRows.length} row(s) appended to "${TAB_NAME}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
