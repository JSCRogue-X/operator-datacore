#!/usr/bin/env tsx
// clickup-agl-sync-delivery.ts
// Reads EstimatedArrivalDate from Amazon SP-API for each AGL shipment,
// updates the "Delivery Date" subtask in ClickUp, and re-cascades due dates
// on any incomplete subtasks. Handles cf-agl, gk-agl, and kin-agl tags.
// Schedule: Daily via GitHub Actions.
// Run: npx tsx src/cli/clickup-agl-sync-delivery.ts

import 'dotenv/config';
import { loadEnvForAmazon } from '../lib/env.js';
import { SpApiClient } from '../lib/sp-api/client.js';

const WORKSPACE_ID = '20480650';
const CU_API_BASE  = 'https://api.clickup.com/api/v2';
const ALL_AGL_TAGS = ['cf-agl', 'gk-agl', 'kin-agl'];

const MARKETPLACES = [
  { id: 'A1F83G8C2ARO7P', label: 'UK' },
  { id: 'A1PA6795UKMFR9', label: 'EU (DE)' },
];

// Days offset from Delivery Date — mirrors clickup-agl-due-dates.ts
const FROM_DELIVERY: Record<string, number> = {
  'make final payment':        -14,
  'provide final costings':    -14,
  'review import duties':        4,
  'update unit pricing (agl)':   4,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface CuTask {
  id: string;
  name: string;
  parent: string | null;
  due_date: string | null;
  status: { type: string };
  subtasks?: CuTask[];
  tags: { name: string }[];
}

interface SpShipment {
  ShipmentId: string;
  ShipmentName: string;
  ShipmentStatus: string;
  EstimatedArrivalDate?: string;
}

interface GetShipmentsResponse {
  payload: {
    ShipmentData: SpShipment[];
    NextToken?: string;
  };
}

// ── ClickUp helpers ───────────────────────────────────────────────────────────

async function cuFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN not set');
  const res = await fetch(`${CU_API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      ...((opts.headers ?? {}) as Record<string, string>),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp ${opts.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getTasksForTag(tag: string): Promise<CuTask[]> {
  const tasks: CuTask[] = [];
  let page = 0;
  while (true) {
    const data = await cuFetch(
      `/team/${WORKSPACE_ID}/task?tags[]=${tag}&include_closed=false&subtasks=false&page=${page}`,
    ) as { tasks: CuTask[] };
    if (!data.tasks?.length) break;
    tasks.push(...data.tasks.filter(t => !t.parent));
    if (data.tasks.length < 100) break;
    page++;
  }
  return tasks;
}

async function getAglParentTasks(): Promise<CuTask[]> {
  const all: CuTask[] = [];
  for (const tag of ALL_AGL_TAGS) {
    const tasks = await getTasksForTag(tag);
    all.push(...tasks);
  }
  return all;
}

async function getSubtasks(taskId: string): Promise<CuTask[]> {
  const data = await cuFetch(`/task/${taskId}?include_subtasks=true`) as { subtasks?: CuTask[] };
  return data.subtasks ?? [];
}

async function setDueDate(taskId: string, ms: number): Promise<void> {
  await cuFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ due_date: ms, due_date_time: false }),
  });
}

async function postComment(taskId: string, text: string): Promise<void> {
  await cuFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text }),
  });
}

// ── SP-API helpers ────────────────────────────────────────────────────────────

// The v0 inbound endpoint processes only one ShipmentStatusList value per request,
// so we query each active status separately and deduplicate by ShipmentId.
const ACTIVE_STATUSES = ['WORKING', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'CHECKED_IN'];

async function fetchByStatus(
  spClient: SpApiClient,
  marketplaceId: string,
  status: string,
): Promise<SpShipment[]> {
  const all: SpShipment[] = [];
  let nextToken: string | undefined;

  do {
    const query: Record<string, string | undefined> = nextToken
      ? { QueryType: 'NEXT_TOKEN', NextToken: nextToken }
      : { QueryType: 'SHIPMENT', MarketplaceId: marketplaceId, ShipmentStatusList: status };

    const resp = await spClient.request<GetShipmentsResponse>({
      method: 'GET',
      path: '/fba/inbound/v0/shipments',
      query,
    });

    all.push(...(resp.payload.payload?.ShipmentData ?? []));
    nextToken = resp.payload.payload?.NextToken;
  } while (nextToken);

  return all;
}

async function getAllShipments(spClient: SpApiClient, marketplaceId: string): Promise<SpShipment[]> {
  const seen = new Set<string>();
  const all: SpShipment[] = [];

  for (const status of ACTIVE_STATUSES) {
    try {
      const batch = await fetchByStatus(spClient, marketplaceId, status);
      for (const s of batch) {
        if (!seen.has(s.ShipmentId)) {
          seen.add(s.ShipmentId);
          all.push(s);
        }
      }
    } catch (err) {
      // A status with no shipments may 400 — skip it
      const msg = (err as Error).message;
      if (!msg.includes('400')) throw err;
    }
  }

  return all;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getTime();
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function toDateStr(ms: number): string {
  return new Date(ms).toLocaleDateString('sv', { timeZone: 'UTC' }); // YYYY-MM-DD
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('ClickUp AGL - Sync Delivery Dates from Amazon');
  console.log('----------------------------------------------');

  const env = loadEnvForAmazon();
  const spClient = new SpApiClient({
    region: 'eu',
    clientId: env.SP_API_LWA_CLIENT_ID,
    clientSecret: env.SP_API_LWA_CLIENT_SECRET,
    refreshToken: env.SP_API_REFRESH_TOKEN,
  });

  // Pre-load all shipments for UK + EU so we don't hit rate limits per task
  console.log('Loading Amazon inbound shipments...');
  const allShipments: SpShipment[] = [];
  for (const mkt of MARKETPLACES) {
    try {
      const shipments = await getAllShipments(spClient, mkt.id);
      console.log(`  ${mkt.label}: ${shipments.length} shipments`);
      allShipments.push(...shipments);
    } catch (err) {
      console.warn(`  ${mkt.label} failed: ${(err as Error).message}`);
    }
  }

  console.log('\nAmazon shipment names loaded:');
  for (const s of allShipments) {
    console.log(`  [${s.ShipmentStatus}] "${s.ShipmentName}" (ETA: ${s.EstimatedArrivalDate ?? 'none'})`);
  }

  const parents = await getAglParentTasks();
  console.log(`\nFound ${parents.length} AGL task(s) (cf-agl / gk-agl / kin-agl).`);

  for (const parent of parents) {
    console.log(`\nProcessing: ${parent.name}`);

    const subtasks = await getSubtasks(parent.id);
    if (!subtasks.length) {
      console.log('  No subtasks - skipping.');
      continue;
    }

    const byName = new Map(subtasks.map(s => [s.name.trim().toLowerCase(), s]));
    const deliverySubtask = byName.get('delivery date');

    if (!deliverySubtask) {
      console.log('  No "Delivery Date" subtask found - skipping.');
      continue;
    }

    // Match Amazon shipments by name — strip emoji/punctuation and use contains
    // so flag prefixes (🇩🇪) or minor differences don't break the match
    const norm = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, '').trim().toLowerCase();
    const taskNorm = norm(parent.name);
    const matched = allShipments.filter(s => {
      const shipNorm = norm(s.ShipmentName);
      return shipNorm.includes(taskNorm) || taskNorm.includes(shipNorm);
    });

    if (!matched.length) {
      console.log(`  No Amazon shipment found matching "${parent.name}"`);
      continue;
    }

    // Use latest ETA across all matching shipments (UK + EU) — most conservative
    const etas = matched
      .filter(s => s.EstimatedArrivalDate)
      .map(s => new Date(s.EstimatedArrivalDate!).getTime());

    if (!etas.length) {
      const statuses = [...new Set(matched.map(s => s.ShipmentStatus))].join(', ');
      console.log(`  Shipment found but no ETA yet (status: ${statuses})`);
      continue;
    }

    const newDeliveryMs = Math.max(...etas);
    const currentDeliveryMs = deliverySubtask.due_date ? parseInt(deliverySubtask.due_date, 10) : null;

    if (currentDeliveryMs && toDateStr(currentDeliveryMs) === toDateStr(newDeliveryMs)) {
      console.log(`  Delivery Date unchanged: ${fmtDate(newDeliveryMs)}`);
      continue;
    }

    const prevStr = currentDeliveryMs ? fmtDate(currentDeliveryMs) : 'not set';
    console.log(`  Delivery Date: ${prevStr} → ${fmtDate(newDeliveryMs)}`);

    // Update "Delivery Date" subtask
    await setDueDate(deliverySubtask.id, newDeliveryMs);

    // Re-cascade FROM_DELIVERY dates, skipping completed subtasks
    const lines: string[] = [
      `Delivery Date auto-updated from Amazon ETA: ${fmtDate(newDeliveryMs)} (was ${prevStr})\n`,
      'Re-cascaded due dates:',
    ];
    let updated = 0;

    for (const [nameLower, offset] of Object.entries(FROM_DELIVERY)) {
      const subtask = byName.get(nameLower);
      if (!subtask) continue;
      if (subtask.status?.type === 'closed') {
        console.log(`  SKIP (completed): "${subtask.name}"`);
        continue;
      }
      const newMs = addDays(newDeliveryMs, offset);
      await setDueDate(subtask.id, newMs);
      const sign = offset >= 0 ? `+${offset}` : `${offset}`;
      lines.push(`  ${subtask.name}: ${fmtDate(newMs)} (Delivery ${sign}d)`);
      console.log(`  SET: "${subtask.name}" → ${fmtDate(newMs)}`);
      updated++;
    }

    lines.push(`\n${updated} date(s) updated. Run at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`);
    await postComment(parent.id, lines.join('\n'));
    console.log(`  Comment posted.`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
