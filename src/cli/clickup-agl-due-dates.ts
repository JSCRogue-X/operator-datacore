#!/usr/bin/env tsx
// clickup-agl-due-dates.ts
// Sets due dates on AGL job subtasks based on anchor subtask dates.
// Supports cf-agl, gk-agl, and kin-agl tags — each with its own offset table.
// Triggered manually via GitHub Actions workflow_dispatch.
// Run: npx tsx src/cli/clickup-agl-due-dates.ts

import 'dotenv/config';

const WORKSPACE_ID = '20480650';
const API_BASE     = 'https://api.clickup.com/api/v2';

const ALL_AGL_TAGS = ['cf-agl', 'gk-agl', 'kin-agl'] as const;
type AglTag = typeof ALL_AGL_TAGS[number];

interface TagConfig {
  fromOrder:      Record<string, number>;
  fromCompletion: Record<string, number>;
  fromDelivery:   Record<string, number>;
}

// CF-AGL: pay deposit and add PO are anchored to Completion Date
const CF_CONFIG: TagConfig = {
  fromOrder: {},
  fromCompletion: {
    'pay deposit (if required)':        0,
    'add po to sostocked':              7,
    'request packing list':           -16,
    'create agl shipment':            -14,
    'add batch codes to shipment':    -14,
    'send fba box labels to ghl':     -14,
    'create commercial invoice':      -14,
    'create packing list':            -14,
    'upload ci/pl to google drive':   -14,
    'create google split file':       -14,
    'review inspection report':         3,
  },
  fromDelivery: {
    'make final payment':             -14,
    'provide final costings':         -14,
    'review import duties':             4,
    'update unit pricing (agl)':        4,
  },
};

// GK-AGL and KIN-AGL: pay deposit and add PO are anchored to Order Date instead
const GK_KIN_CONFIG: TagConfig = {
  fromOrder: {
    'pay deposit (if required)':        0,
    'add po to sostocked':              7,
  },
  fromCompletion: {
    'request packing list':           -16,
    'create agl shipment':            -14,
    'add batch codes to shipment':    -14,
    'send fba box labels to ghl':     -14,
    'create commercial invoice':      -14,
    'create packing list':            -14,
    'upload ci/pl to google drive':   -14,
    'create google split file':       -14,
    'review inspection report':         3,
  },
  fromDelivery: {
    'make final payment':             -14,
    'provide final costings':         -14,
    'review import duties':             4,
    'update unit pricing (agl)':        4,
  },
};

const TAG_CONFIGS: Record<AglTag, TagConfig> = {
  'cf-agl':  CF_CONFIG,
  'gk-agl':  GK_KIN_CONFIG,
  'kin-agl': GK_KIN_CONFIG,
};

interface CuTask {
  id: string;
  name: string;
  parent: string | null;
  due_date: string | null;
  status: { type: string };
  subtasks?: CuTask[];
  tags: { name: string }[];
}

async function cuFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN not set');
  const res = await fetch(`${API_BASE}${path}`, {
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

function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getTime();
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
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

async function processTask(parent: CuTask, tag: AglTag): Promise<void> {
  const config = TAG_CONFIGS[tag];
  console.log(`\nProcessing [${tag}]: ${parent.name} (${parent.id})`);

  const subtasks = await getSubtasks(parent.id);
  if (!subtasks.length) {
    console.log('  No subtasks — skipping.');
    return;
  }

  const byName = new Map(subtasks.map(s => [s.name.trim().toLowerCase(), s]));

  const orderMs = byName.get('order date')?.due_date
    ? parseInt(byName.get('order date')!.due_date!, 10) : null;
  const completionMs = byName.get('completion date')?.due_date
    ? parseInt(byName.get('completion date')!.due_date!, 10) : null;
  const deliveryMs = byName.get('delivery date')?.due_date
    ? parseInt(byName.get('delivery date')!.due_date!, 10) : null;

  const hasOrderConfig = Object.keys(config.fromOrder).length > 0;

  if (!completionMs && !deliveryMs && !(hasOrderConfig && orderMs)) {
    console.log('  No anchor dates set. Skipping.');
    return;
  }

  const lines: string[] = ['Due dates set by automation:\n'];
  let updated = 0;
  let missing = 0;

  const applyOffsets = async (
    anchorMs: number,
    anchorLabel: string,
    offsets: Record<string, number>,
  ) => {
    for (const [nameLower, offset] of Object.entries(offsets)) {
      const subtask = byName.get(nameLower);
      if (!subtask) {
        console.log(`  SKIP (not found): "${nameLower}"`);
        missing++;
        continue;
      }
      if (subtask.status?.type === 'closed') {
        console.log(`  SKIP (completed): "${subtask.name}"`);
        continue;
      }
      const newMs = addDays(anchorMs, offset);
      await setDueDate(subtask.id, newMs);
      const sign = offset >= 0 ? `+${offset}` : `${offset}`;
      lines.push(`  ${subtask.name}: ${fmtDate(newMs)} (${anchorLabel} ${sign}d)`);
      console.log(`  SET: "${subtask.name}" → ${fmtDate(newMs)}`);
      updated++;
    }
  };

  if (hasOrderConfig && orderMs) {
    console.log(`  Order Date: ${fmtDate(orderMs)}`);
    lines.push('From Order Date:');
    await applyOffsets(orderMs, 'Order', config.fromOrder);
  } else if (hasOrderConfig) {
    console.log('  Order Date: not set — skipping Order Date offsets.');
  }

  if (completionMs) {
    console.log(`  Completion Date: ${fmtDate(completionMs)}`);
    lines.push('\nFrom Completion Date:');
    await applyOffsets(completionMs, 'Completion', config.fromCompletion);
  }

  if (deliveryMs) {
    console.log(`  Delivery Date: ${fmtDate(deliveryMs)}`);
    lines.push('\nFrom Delivery Date:');
    await applyOffsets(deliveryMs, 'Delivery', config.fromDelivery);
  }

  if (missing) lines.push(`\n${missing} subtask(s) not found - check names match exactly in ClickUp.`);
  lines.push(`\n${updated} due dates updated. Run at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`);

  await postComment(parent.id, lines.join('\n'));
  console.log(`  Comment posted. ${updated} updated, ${missing} not found.`);
}

async function main(): Promise<void> {
  console.log('ClickUp AGL - Set Due Dates');
  console.log('---------------------------');

  const allTasks: { task: CuTask; tag: AglTag }[] = [];

  for (const tag of ALL_AGL_TAGS) {
    const tasks = await getTasksForTag(tag);
    console.log(`  ${tag}: ${tasks.length} parent task(s)`);
    for (const task of tasks) {
      allTasks.push({ task, tag });
    }
  }

  console.log(`\nTotal: ${allTasks.length} AGL parent task(s).`);

  if (!allTasks.length) {
    console.log('Nothing to process.');
    return;
  }

  for (const { task, tag } of allTasks) {
    await processTask(task, tag);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
