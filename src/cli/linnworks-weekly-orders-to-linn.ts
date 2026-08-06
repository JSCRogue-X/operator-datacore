#!/usr/bin/env tsx
// Fetches last week's (Monday-Sunday) Spin Care / EBAY1 orders from Linnworks —
// both dispatched and still-open — and appends new rows to the "Linn" tab
// (columns A-G) in the Company Sell-through / Overall tracking sheet.
// Still-open orders get a placeholder ProcessedDate (received + 24h) so the
// sheet's own SLA formulas don't flag them as overdue while they wait for
// the next dispatch run. Correcting that placeholder once the order is
// actually dispatched is a follow-up step, not handled by this version.
// Run: npx tsx src/cli/linnworks-weekly-orders-to-linn.ts

import 'dotenv/config';
import { google } from 'googleapis';
import pLimit from 'p-limit';

const SPREADSHEET_ID = '1LSCRaHwsLBUFAg7DuRAaa8L5wDOfB7upQZ4Hb7-sayo';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ??
  'C:\\Users\\Spincare-JSC\\Documents\\Claude Folder\\spincare-sheets-key.json';
const TAB_NAME = 'Linn';

const ALLOWED_SUBSOURCES = new Set(['SPIN CARE', 'EBAY1']);

// Google Sheets date serial: days (with fractional time-of-day) since 30 Dec 1899
const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
function toSheetDateTime(d: Date): number {
  return (d.getTime() - SHEETS_EPOCH) / 86400000;
}

function mondayOfUTC(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day  = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date;
}

// ── Linnworks auth ──────────────────────────────────────────────────────────

interface LinnworksSession { token: string; server: string; }

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

async function getOgdenLocationId(session: LinnworksSession): Promise<string> {
  const resp = await fetch(`${session.server}/api/Inventory/GetStockLocations`, {
    method:  'GET',
    headers: { Authorization: session.token },
  });
  if (!resp.ok) throw new Error(`GetStockLocations failed: ${resp.status} ${await resp.text()}`);
  const raw  = await resp.json() as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>)['Data']) as Record<string, unknown>[] ?? [];
  const ogden = list.find(l => String(l['LocationName'] ?? l['Name'] ?? '').toLowerCase().includes('ogden'));
  if (!ogden) throw new Error('Could not find an "Ogden" fulfilment location');
  return String(ogden['StockLocationId'] ?? ogden['Id'] ?? '');
}

// ── Normalized order shape ──────────────────────────────────────────────────

interface NormalizedOrder {
  nOrderId:         number;
  channelReference: string;
  receivedDate:     Date;
  country:          string;
  source:           string;
  subSource:        string;
  processed:        boolean;
  processedDate:    Date | null;
}

// ── Fetch dispatched orders (ProcessedOrders/SearchProcessedOrders) ─────────

async function fetchDispatchedOrders(session: LinnworksSession, from: Date, to: Date): Promise<NormalizedOrder[]> {
  const out: NormalizedOrder[] = [];
  let page = 1;

  while (true) {
    const resp = await fetch(`${session.server}/api/ProcessedOrders/SearchProcessedOrders`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: {
          dateField:      'RECEIVED',
          fromDate:       from.toISOString(),
          toDate:         to.toISOString(),
          pageNumber:     page,
          resultsPerPage: 200,
        },
      }),
    });
    if (!resp.ok) throw new Error(`SearchProcessedOrders page ${page} failed: ${resp.status} ${await resp.text()}`);

    const raw  = await resp.json() as { ProcessedOrders?: { Data?: Record<string, unknown>[]; TotalPages?: number } };
    const data = raw.ProcessedOrders?.Data ?? [];

    for (const o of data) {
      const nOrderId = Number(o['nOrderId']);
      if (!nOrderId) continue;
      out.push({
        nOrderId,
        channelReference: String(o['SecondaryReference'] ?? ''),
        receivedDate:     new Date(String(o['dReceivedDate'] ?? '')),
        country:          String(o['cCountry'] ?? ''),
        source:           String(o['Source'] ?? ''),
        subSource:        String(o['SubSource'] ?? ''),
        processed:        true,
        processedDate:    o['dProcessedOn'] ? new Date(String(o['dProcessedOn'])) : null,
      });
    }

    const totalPages = raw.ProcessedOrders?.TotalPages ?? 1;
    if (page >= totalPages || data.length === 0) break;
    page++;
  }

  return out;
}

// ── Fetch still-open orders (GetAllOpenOrders + GetOrderById) ──────────────

async function fetchOpenOrders(session: LinnworksSession, ogdenLocationId: string): Promise<NormalizedOrder[]> {
  const listResp = await fetch(`${session.server}/api/Orders/GetAllOpenOrders`, {
    method:  'POST',
    headers: { Authorization: session.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters:          { TextFields: [], BooleanFields: [], NumericFields: [], DateFields: [], ListFields: [] },
      sorting:          [{ FieldCode: 'GENERAL_INFO_DATE', Direction: 'Descending', Order: 0 }],
      fulfilmentCenter: ogdenLocationId,
      additionalFilter: null,
      exactMatch:       false,
    }),
  });
  if (!listResp.ok) throw new Error(`GetAllOpenOrders failed: ${listResp.status} ${await listResp.text()}`);
  const ids = await listResp.json() as string[];

  const limit  = pLimit(2);
  const orders = await Promise.all(ids.map(id => limit(async () => {
    const r = await fetch(`${session.server}/api/Orders/GetOrderById`, {
      method:  'POST',
      headers: { Authorization: session.token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pkOrderId: id }),
    });
    if (!r.ok) {
      console.warn(`  [warn] GetOrderById ${id} -> ${r.status}`);
      return null;
    }
    return await r.json() as Record<string, unknown>;
  })));

  const out: NormalizedOrder[] = [];
  for (const o of orders) {
    if (!o) continue;
    const general  = o['GeneralInfo'] as Record<string, unknown> | undefined;
    const customer = o['CustomerInfo'] as Record<string, unknown> | undefined;
    const address  = customer?.['Address'] as Record<string, unknown> | undefined;
    const nOrderId = Number(o['NumOrderId']);
    if (!nOrderId || !general) continue;

    out.push({
      nOrderId,
      channelReference: String(general['SecondaryReference'] ?? ''),
      receivedDate:     new Date(String(general['ReceivedDate'] ?? '')),
      country:          String(address?.['Country'] ?? ''),
      source:           String(general['Source'] ?? ''),
      subSource:        String(general['SubSource'] ?? ''),
      processed:        Boolean(o['Processed']),
      processedDate:    null,
    });
  }

  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Linnworks Weekly Orders → Linn tab');
  console.log('-------------------------------------');

  const now        = new Date();
  const thisMonday = mondayOfUTC(now);
  const weekStart  = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd    = new Date(thisMonday.getTime() - 1);
  console.log(`Target week: ${weekStart.toISOString()} → ${weekEnd.toISOString()}`);

  const session = await getLinnworksSession();
  console.log(`Session OK. Server: ${session.server}`);

  console.log('Resolving Ogden Fulfilment location...');
  const ogdenLocationId = await getOgdenLocationId(session);
  console.log(`  ${ogdenLocationId}`);

  console.log('Fetching dispatched orders received in target week...');
  const dispatched = await fetchDispatchedOrders(session, weekStart, weekEnd);
  console.log(`  ${dispatched.length} dispatched order(s).`);

  console.log('Fetching still-open orders...');
  const allOpen    = await fetchOpenOrders(session, ogdenLocationId);
  const openInWeek = allOpen.filter(o => o.receivedDate >= weekStart && o.receivedDate <= weekEnd);
  console.log(`  ${allOpen.length} open order(s) total account-wide, ${openInWeek.length} received in target week.`);

  // Combine, preferring the dispatched (fully real) record if an order somehow appears in both
  const byId = new Map<number, NormalizedOrder>();
  for (const o of openInWeek) byId.set(o.nOrderId, o);
  for (const o of dispatched) byId.set(o.nOrderId, o);
  let combined = Array.from(byId.values());
  console.log(`  ${combined.length} order(s) after combining and de-duplicating by Order ID.`);

  // Only Spin Care / EBAY1
  combined = combined.filter(o => ALLOWED_SUBSOURCES.has(o.subSource.toUpperCase()));
  console.log(`  ${combined.length} order(s) after SubSource filter (Spin Care / EBAY1 only).`);

  // Data-quality guard: drop any order flagged Processed with no real ProcessedDate
  combined = combined.filter(o => !o.processed || o.processedDate !== null);

  // Placeholder ProcessedDate for anything still open: received + 24 hours
  for (const o of combined) {
    if (!o.processedDate) {
      o.processedDate = new Date(o.receivedDate.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // Oldest to newest
  combined.sort((a, b) => a.receivedDate.getTime() - b.receivedDate.getTime());

  // ── Google Sheets ──────────────────────────────────────────────────────
  console.log('\nConnecting to Google Sheets...');
  const auth   = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const ss      = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetId = ss.data.sheets?.find(s => s.properties?.title === TAB_NAME)?.properties?.sheetId ?? 0;

  const existingResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${TAB_NAME}!A:A` });
  const existingRows = existingResp.data.values ?? [];
  const existingIds  = new Set(existingRows.slice(1).map(r => String(r?.[0] ?? '').trim()).filter(Boolean));
  console.log(`  ${existingIds.size} existing order(s) already in "${TAB_NAME}".`);

  const newRows = combined.filter(o => !existingIds.has(String(o.nOrderId)));
  console.log(`  ${newRows.length} new row(s) to append (${combined.length - newRows.length} already present, skipped).`);

  if (newRows.length === 0) {
    console.log('  Nothing new to add.');
    return;
  }

  const outputRows = newRows.map(o => [
    o.nOrderId,
    o.channelReference,
    toSheetDateTime(o.receivedDate),
    o.country,
    toSheetDateTime(o.processedDate!),
    o.source,
    o.subSource,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: outputRows },
  });

  const firstNewRow = existingRows.length + 1;
  const lastNewRow  = firstNewRow + outputRows.length - 1;

  // Match the existing date-time display style in columns C (received) and E (processed)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [2, 4].map(colIndex => ({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex:    firstNewRow - 1,
            endRowIndex:      lastNewRow,
            startColumnIndex: colIndex,
            endColumnIndex:   colIndex + 1,
          },
          cell:   { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'd/mm/yyyy hh:mm' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      })),
    },
  });

  console.log(`\nDone — ${outputRows.length} row(s) appended to "${TAB_NAME}".`);
  console.log(`View: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
}

main().catch(err => { console.error(err); process.exit(1); });
