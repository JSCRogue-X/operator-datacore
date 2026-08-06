#!/usr/bin/env tsx
// Diagnostic only — no writes anywhere. Fetches a handful of real orders from
// ProcessedOrders/SearchProcessedOrders and prints the raw JSON so we can
// confirm exact field names (in particular, the channel/external reference
// field) before building the real Linn tab automation.
// Run: npx tsx src/cli/debug-linnworks-orders-raw.ts

import 'dotenv/config';

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

async function main() {
  console.log('Linnworks raw order field check (diagnostic — no writes)');
  console.log('----------------------------------------------------------');

  const session = await getLinnworksSession();
  console.log(`Session OK. Server: ${session.server}`);

  const toDate   = new Date();
  const fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  console.log(`Fetching orders from ${fromDate.toISOString()} to ${toDate.toISOString()}...`);

  const resp = await fetch(`${session.server}/api/ProcessedOrders/SearchProcessedOrders`, {
    method:  'POST',
    headers: { Authorization: session.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request: {
        dateField:      'RECEIVED',
        fromDate:       fromDate.toISOString(),
        toDate:         toDate.toISOString(),
        pageNumber:     1,
        resultsPerPage: 20,
      },
    }),
  });

  if (!resp.ok) throw new Error(`SearchProcessedOrders failed: ${resp.status} ${await resp.text()}`);

  const raw = await resp.json() as Record<string, unknown>;
  const po  = raw['ProcessedOrders'] as Record<string, unknown> | undefined;
  const data = (po?.['Data'] ?? []) as Record<string, unknown>[];

  console.log(`\nTotalEntries: ${po?.['TotalEntries']}`);
  console.log(`Orders returned this page: ${data.length}`);

  if (data.length === 0) {
    console.log('No orders in this window — nothing to inspect.');
    return;
  }

  const firstOrder = data[0]!;

  console.log('\n=== Full raw JSON of first order ===');
  console.log(JSON.stringify(firstOrder, null, 2));

  console.log('\n=== Every top-level key containing "Ref" or "Channel" (any order in this page) ===');
  const seenKeys = new Set<string>();
  for (const order of data) {
    for (const key of Object.keys(order)) {
      if (/ref|channel/i.test(key)) seenKeys.add(key);
    }
  }
  for (const key of seenKeys) {
    console.log(`  ${key}: ${JSON.stringify(firstOrder[key])}`);
  }

  console.log('\n=== All top-level field names on first order ===');
  console.log(Object.keys(firstOrder).join(', '));

  // ── Open (not yet dispatched) orders ────────────────────────────────────
  console.log('\n\nOpen orders check (OpenOrders/GetOpenOrders)');
  console.log('----------------------------------------------------------');

  // Resolve the Ogden Fulfilment location GUID (same pattern as linnworks_oos.py —
  // GetOpenOrders needs a real location GUID, not the all-zero "default" one).
  const locResp = await fetch(`${session.server}/api/Inventory/GetStockLocations`, {
    method:  'GET',
    headers: { Authorization: session.token },
  });
  if (!locResp.ok) {
    console.log(`GetStockLocations failed: ${locResp.status} ${await locResp.text()}`);
    return;
  }
  const locRaw  = await locResp.json() as unknown;
  const locList = (Array.isArray(locRaw) ? locRaw : (locRaw as Record<string, unknown>)['Data']) as Record<string, unknown>[] ?? [];
  const ogden   = locList.find(l => String(l['LocationName'] ?? l['Name'] ?? '').toLowerCase().includes('ogden'));

  if (!ogden) {
    console.log('Could not find an "Ogden" location. All locations returned:');
    console.log(JSON.stringify(locList, null, 2));
    return;
  }
  const ogdenLocationId = String(ogden['StockLocationId'] ?? ogden['Id'] ?? '');
  console.log(`Resolved Ogden Fulfilment location GUID: ${ogdenLocationId}`);

  const openResp = await fetch(`${session.server}/api/OpenOrders/GetOpenOrders`, {
    method:  'POST',
    headers: { Authorization: session.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ViewId:         0,
      LocationId:     ogdenLocationId,
      EntriesPerPage: 20,
      PageNumber:     1,
      OrderIds:       [],
    }),
  });

  if (!openResp.ok) {
    console.log(`GetOpenOrders failed: ${openResp.status} ${await openResp.text()}`);
    return;
  }

  const openRaw  = await openResp.json() as Record<string, unknown>;
  const openData = (openRaw['Data'] ?? []) as Record<string, unknown>[];

  console.log(`TotalEntries: ${openRaw['TotalEntries']}`);
  console.log(`Open orders returned this page: ${openData.length}`);

  if (openData.length === 0) {
    console.log('No open orders right now — nothing to inspect.');
    return;
  }

  console.log('\n=== Full raw JSON of first open order ===');
  console.log(JSON.stringify(openData[0], null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
