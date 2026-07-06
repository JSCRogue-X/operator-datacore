#!/usr/bin/env tsx
// ============================================================================
// replen-tool.ts
// FBA Replenishment Overview — UK and EU (DE)
//
// Pulls GET_FBA_INVENTORY_PLANNING_DATA for each region and prints a table
// showing current stock, days of supply, and Amazon's recommended ship-in qty.
//
// Run: npx tsx src/cli/replen-tool.ts
// ============================================================================

import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';
import { runReport, parseTsv } from '../lib/sp-api/reports.js';

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'UK' },
  { id: 'A1PA6795UKMFR9', label: 'EU (DE)' },
] as const;

type Status = 'URGENT' | 'WARN  ' | 'OK    ' | 'EXCESS';

interface ReplRow {
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
  status: Status;
}

// ── Status thresholds ────────────────────────────────────────────────────────
const URGENT_DOS = 30;
const WARN_DOS   = 60;

function deriveStatus(daysOfSupply: number | null, excessQty: number): Status {
  if (daysOfSupply === null || daysOfSupply < URGENT_DOS) return 'URGENT';
  if (daysOfSupply < WARN_DOS)                             return 'WARN  ';
  if (excessQty > 0)                                       return 'EXCESS';
  return 'OK    ';
}

// ── Table helpers ────────────────────────────────────────────────────────────
function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s.padEnd(len);
}

const COL = { status: 6, loc: 8, sku: 32, name: 44, avail: 6, inbound: 7, dos: 5, shipIn: 8, shipDate: 11, action: 22 };
const SEP = '─'.repeat(Object.values(COL).reduce((a, b) => a + b, 0) + Object.keys(COL).length * 3 - 1);

function headerLine(): string {
  return [
    pad('STATUS',      COL.status),
    pad('REGION',      COL.loc),
    pad('SKU',         COL.sku),
    pad('PRODUCT',     COL.name),
    pad('AVAIL',       COL.avail),
    pad('INBOUND',     COL.inbound),
    pad('DoS',         COL.dos),
    pad('SHIP IN',     COL.shipIn),
    pad('SHIP DATE',   COL.shipDate),
    pad('AMAZON ACTION', COL.action),
  ].join(' │ ');
}

function dataLine(r: ReplRow): string {
  // Amazon caps DoS at 366 — show as 366+ to avoid confusion
  const dosStr      = r.daysOfSupply === null ? 'OOS?'
                    : r.daysOfSupply >= 366    ? '366+'
                    : Math.round(r.daysOfSupply).toString();
  const shipStr     = r.recommendedShipIn > 0 ? r.recommendedShipIn.toLocaleString() : '—';
  const inboundStr  = r.inbound > 0 ? r.inbound.toString() : '—';
  const dateStr     = r.shipInDate ? r.shipInDate.slice(0, COL.shipDate) : '—';
  return [
    pad(r.status,               COL.status),
    pad(r.location,             COL.loc),
    pad(r.sku,                  COL.sku),
    pad(r.name,                 COL.name),
    pad(r.available.toString(), COL.avail),
    pad(inboundStr,             COL.inbound),
    pad(dosStr,                 COL.dos),
    pad(shipStr,                COL.shipIn),
    pad(dateStr,                COL.shipDate),
    pad(r.action.slice(0, COL.action), COL.action),
  ].join(' │ ');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const env = loadEnvForAmazon();
  const client = new SpApiClient({
    region: 'eu',
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  const allRows: ReplRow[] = [];
  let headersLogged = false;

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
    if (rows.length === 0) {
      console.log(`  No rows returned for ${mkt.label}`);
      continue;
    }

    if (!headersLogged) {
      console.log(`  Report columns: ${Object.keys(rows[0]!).join(', ')}`);
      headersLogged = true;
    }

    for (const r of rows) {
      const available         = parseInt(r['available'] ?? '0', 10) || 0;

      // Use total DoS including open inbound shipments — more accurate than current-stock-only
      const dosRaw            = r['Total Days of Supply (including units from open shipments)'] ?? r['days-of-supply'] ?? '';
      const daysOfSupply      = dosRaw !== '' ? parseFloat(dosRaw) : null;

      const excessQty         = parseFloat(r['estimated-excess-quantity'] ?? '0') || 0;

      // Inbound = units en route to FBA (shipped but not yet received)
      const inboundShipped    = parseInt(r['inbound-shipped'] ?? '0', 10) || 0;
      const inboundReceived   = parseInt(r['inbound-received'] ?? '0', 10) || 0;
      const inbound           = inboundShipped + inboundReceived;

      // Column names are case-sensitive — Amazon uses title case with spaces here
      const shipInRaw         = r['Recommended ship-in quantity'] ?? '0';
      const recommendedShipIn = parseInt(shipInRaw, 10) || 0;
      const shipInDate        = r['Recommended ship-in date'] ?? '';
      const action            = r['recommended-action'] ?? '';

      allRows.push({
        location:          mkt.label,
        sku:               r['sku'] ?? '',
        asin:              r['asin'] ?? '',
        name:              (r['product-name'] ?? '').slice(0, COL.name),
        available,
        inbound,
        daysOfSupply,
        recommendedShipIn,
        shipInDate,
        action,
        status:            deriveStatus(daysOfSupply, excessQty),
      });
    }

    console.log(`  ${mkt.label}: ${rows.length} SKUs fetched.`);
  }

  if (allRows.length === 0) {
    console.log('\nNo data returned.');
    return;
  }

  // Sort: URGENT → WARN → OK → EXCESS, then by DoS ascending within each group
  const ORDER: Record<Status, number> = { 'URGENT': 0, 'WARN  ': 1, 'OK    ': 2, 'EXCESS': 3 };
  allRows.sort((a, b) => {
    const sd = ORDER[a.status] - ORDER[b.status];
    if (sd !== 0) return sd;
    return (a.daysOfSupply ?? -1) - (b.daysOfSupply ?? -1);
  });

  // ── Print ─────────────────────────────────────────────────────────────────
  console.log('\n\nSPINCARE — FBA Replenishment Overview');
  console.log(SEP);
  console.log(headerLine());
  console.log(SEP);

  let lastStatus: string = '';
  for (const r of allRows) {
    if (r.status !== lastStatus && lastStatus !== '') console.log(SEP);
    lastStatus = r.status;
    console.log(dataLine(r));
  }
  console.log(SEP);

  // ── Summary ───────────────────────────────────────────────────────────────
  const urgent = allRows.filter(r => r.status === 'URGENT').length;
  const warn   = allRows.filter(r => r.status === 'WARN  ').length;
  const excess = allRows.filter(r => r.status === 'EXCESS').length;
  const ok     = allRows.filter(r => r.status === 'OK    ').length;
  const needShipIn = allRows.filter(r => r.recommendedShipIn > 0).length;

  console.log(`\nSummary: ${urgent} URGENT  |  ${warn} WARN  |  ${ok} OK  |  ${excess} EXCESS`);
  console.log(`         ${needShipIn} SKU(s) have a recommended ship-in quantity from Amazon`);
  console.log('');
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
