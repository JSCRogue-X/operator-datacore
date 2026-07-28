#!/usr/bin/env tsx
// Finds tasks tagged "new-product" and sets due dates + assignees on all
// subtasks (and their sub-subtasks) based on anchor dates.
// The tag may be on the parent job OR on "6. Launch" directly — both are handled.
//
// Three anchors mirror the spreadsheet sections:
//   Section 5 → "Place purchase order" subtask → PO section tasks
//   Section 5 → "Completion Date" subtask       → Completion section tasks
//   Section 6 → "Launch Date" subtask           → Launch section tasks
//
// Anchor dates are read from Section 5 (Production) and Section 6 (Launch).
// All due dates are set on Section 6 subtasks.
//
// Run: npx tsx src/cli/clickup-new-product-launch.ts

import 'dotenv/config';

const WORKSPACE_ID    = '20480650';
const NEW_PRODUCT_TAG = 'new-product';
const API_BASE        = 'https://api.clickup.com/api/v2';

const TEST_ASSIGNEE_ID: number | null = null;

const JON = 32614246; // jon@spincare.co.uk

// Assignees by subtask name (lowercase). Multiple user IDs per task are supported.
const ASSIGNEES: Record<string, number[]> = {
  'duplicate product launch sheet':                          [JON],
  'provide launch/retail/list pricing for amazon locales':   [JON],
  'provide features/benefits for the products':             [JON],
  'product demo':                                           [JON],
  'provide image brief notes':                              [JON],
  'complete marketing handover':                            [JON],
  'create maxamaze project':                                [JON],
  'request reach report':                                   [JON],
  'review/approve reach report':                            [JON],
  'save reach report to google drive':                      [JON],
  'upload reach report to pcm':                             [JON],
  'create/save sds (factory)':                              [JON],
  'review/approve factory sds':                             [JON],
  'request production samples':                             [JON],
  'maxamaze project complete':                              [JON],
  'basic mintsoft sku setup':                               [JON],
  'basic linnworks import':                                 [JON],
  'create mkl':                                             [JON],
  'create listing data':                                    [JON],
  'research/setup ppc campaigns':                           [JON],
  'create sp campaigns':                                    [JON],
  'add to branded search campaign':                         [JON],
  'create negative keyword list':                           [JON],
  'update/add negative master keyword list':                [JON],
  'add pts as negative product targets':                    [JON],
  'review listing':                                         [JON],
  'listing amends':                                         [JON],
  'approve listing':                                        [JON],
  'complete ih launch template':                            [JON],
  'import & list products on ih channels':                  [JON],
  'create flat file template':                              [JON],
  'sub task - add b2b pricing':                             [JON],
  'sub task - set max order quantity to 20':                [JON],
  'sub task upload to amazon / close listing':              [JON],
  'sostocked sku setup':                                    [JON],
  'create/save sds (fast track)':                           [JON],
  'review/approve fast track sds completed.':               [JON],
  'complete pcm entry':                                     [JON],
  'upload sds':                                             [JON],
  'send test shipment':                                     [JON],
  'inventory - ship inventory to amazon uk':                [JON],
  'inventory - ship inventory to amazon eu':                [JON],
  'add images to listing':                                  [JON],
  'launch email campaign':                                  [JON],
  'ebay promoted listing setup':                            [JON],
  'ebay add multi-buy discounts':                           [JON],
  'add shopify multi-buy discounts':                        [JON],
  'announce launch on social media':                        [JON],
  'amazon launch':                                          [JON],
  'add to marketing kpi tracker':                           [JON],
  'enrol in vine (if using)':                               [JON],
  'create coupon':                                          [JON],
  'add to rank radar':                                      [JON],
  'add cost price into sellerboard.io':                     [JON],
  'enter cogs into sellerboard':                            [JON],
  'add asin to storefront':                                 [JON],
  'sub task - add asin to home page':                       [JON],
  'sub task - add asin to category page':                   [JON],
  'weekly review price':                                    [JON],
  'add campaigns to scale insights automation':             [JON],
  'negative keyword check':                                 [JON],
  'check review request automation (captaina)':             [JON],
  'analyse reviews for listing improvements (60 days)':     [JON],
  'analyse reviews for listing improvements (90 days)':     [JON],
  're-order eligibility (60 days)':                         [JON],
  're-order eligibility (90 days)':                         [JON],
};

// ── Offset tables (days from anchor) ─────────────────────────────────────────

// Offset tables: [dueOffset, assignDays]
// dueOffset  = days from anchor to due date (negative = before anchor)
// assignDays = days before due date to set as start date (0 = same day, no start date set)

// Section 1: anchored to "Place Purchase Order" date
const FROM_PO: Record<string, [number, number]> = {
  'duplicate product launch sheet':                         [1,  1],
  'provide launch/retail/list pricing for amazon locales':  [7,  2],
  'provide features/benefits for the products':            [7,  2],
  'product demo':                                          [7,  2],
  'provide image brief notes':                             [7,  2],
  'complete marketing handover':                           [7,  2],
  'create maxamaze project':                               [8,  2],
  'request reach report':                                  [14, 0],
  'review/approve reach report':                           [14, 0],
  'save reach report to google drive':                     [14, 0],
  'upload reach report to pcm':                            [14, 0],
  'create/save sds (factory)':                             [14, 0],
  'review/approve factory sds':                            [14, 0],
};

// Section 2: anchored to "Completion Date"
const FROM_COMPLETION: Record<string, [number, number]> = {
  'request production samples':    [0,   0],
  'maxamaze project complete':     [-14, 1],
  'basic mintsoft sku setup':      [-30, 2],
  'basic linnworks import':        [-30, 2],
};

// Section 3: anchored to "Launch Date"
const FROM_LAUNCH: Record<string, [number, number]> = {
  'create mkl':                                            [-90, 14],
  'create listing data':                                   [-90, 14],
  'research/setup ppc campaigns':                          [-90, 14],
  'create sp campaigns':                                   [-90, 14],  // sub-subtask
  'add to branded search campaign':                        [-90, 14],  // sub-subtask
  'create negative keyword list':                          [-90, 14],  // sub-subtask
  'update/add negative master keyword list':               [-90, 14],  // sub-subtask
  'add pts as negative product targets':                   [-90, 14],  // sub-subtask
  'review listing':                                        [-81, 14],
  'listing amends':                                        [-81,  7],
  'approve listing':                                       [-74,  7],
  'complete ih launch template':                           [-60,  7],
  'import & list products on ih channels':                 [-60,  7],
  'create flat file template':                             [-60,  7],
  'sub task - add b2b pricing':                            [-60,  7],  // sub-subtask
  'sub task - set max order quantity to 20':               [-60,  7],  // sub-subtask
  'sub task upload to amazon / close listing':             [-60,  7],  // sub-subtask
  'sostocked sku setup':                                   [-59,  2],
  'create/save sds (fast track)':                          [-59,  2],
  'review/approve fast track sds completed.':              [-59,  2],
  'complete pcm entry':                                    [-59,  2],
  'upload sds':                                            [-58,  7],
  'send test shipment':                                    [-57,  2],
  'inventory - ship inventory to amazon uk':               [-21,  2],
  'inventory - ship inventory to amazon eu':               [-21,  2],
  'add images to listing':                                 [-14,  7],
  'launch email campaign':                                 [-11,  1],
  'ebay promoted listing setup':                           [0,    7],
  'ebay add multi-buy discounts':                          [0,    7],
  'add shopify multi-buy discounts':                       [0,    7],
  'announce launch on social media':                       [0,    7],
  'amazon launch':                                         [0,    7],
  'add to marketing kpi tracker':                          [0,    0],
  'enrol in vine (if using)':                              [0,    7],
  'create coupon':                                         [0,    7],
  'add to rank radar':                                     [1,    7],
  'add cost price into sellerboard.io':                    [1,    1],
  'enter cogs into sellerboard':                           [1,    7],
  'add asin to storefront':                                [1,    7],
  'sub task - add asin to home page':                      [1,    7],  // sub-subtask
  'sub task - add asin to category page':                  [1,    7],  // sub-subtask
  'weekly review price':                                   [7,    1],
  'add campaigns to scale insights automation':            [10,   1],
  'negative keyword check':                                [10,   1],
  'check review request automation (captaina)':            [10,   1],
  'analyse reviews for listing improvements (60 days)':    [14,   1],
  'analyse reviews for listing improvements (90 days)':    [28,   1],
  're-order eligibility (60 days)':                        [60,   7],
  're-order eligibility (90 days)':                        [90,   7],
};

// Subtasks that have their own children to process
const HAS_SUB_SUBTASKS = new Set([
  'research/setup ppc campaigns',
  'create flat file template',
  'add asin to storefront',
]);

// ── API helpers ───────────────────────────────────────────────────────────────

interface CuChecklistItem {
  id: string;
  name: string;
  assignee: { id: number } | null;
}

interface CuChecklist {
  id: string;
  items: CuChecklistItem[];
}

interface CuTask {
  id: string;
  name: string;
  parent: string | null;
  due_date: string | null;
  start_date: string | null;
  status: { type: string; status: string };
  checklists?: CuChecklist[];
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
  return new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

async function getTasksForTag(tag: string): Promise<CuTask[]> {
  const seen  = new Set<string>();
  const tasks: CuTask[] = [];
  let page = 0;
  while (true) {
    const data = await cuFetch(
      `/team/${WORKSPACE_ID}/task?tags[]=${tag}&include_closed=false&subtasks=true&page=${page}`,
    ) as { tasks: CuTask[] };
    if (!data.tasks?.length) break;
    for (const t of data.tasks) {
      if (!seen.has(t.id)) { seen.add(t.id); tasks.push(t); }
    }
    if (data.tasks.length < 100) break;
    page++;
  }
  return tasks;
}

async function getSubtasks(taskId: string): Promise<CuTask[]> {
  const data = await cuFetch(`/task/${taskId}?include_subtasks=true`) as { subtasks?: CuTask[] };
  return data.subtasks ?? [];
}

async function setDates(taskId: string, dueMs: number, startMs: number | null): Promise<void> {
  const body: Record<string, unknown> = { due_date: dueMs, due_date_time: false };
  if (startMs !== null) {
    body.start_date      = startMs;
    body.start_date_time = false;
  }
  await cuFetch(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify(body) });
}

async function setAssignees(taskId: string, userIds: number[]): Promise<void> {
  if (!userIds.length) return;
  await cuFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ assignees: { add: userIds, rem: [] } }),
  });
}

async function postComment(taskId: string, text: string): Promise<void> {
  await cuFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text }),
  });
}

async function assignChecklistItems(
  checklists: CuChecklist[],
  assignDateMs: number,
  assigneeId: number | undefined,
): Promise<void> {
  for (const cl of checklists) {
    for (const item of cl.items) {
      const body: Record<string, unknown> = { name: item.name, due_date: assignDateMs };
      if (assigneeId) body.assignee = assigneeId;
      await cuFetch(`/checklist/${cl.id}/checklist_item/${item.id}`, {
        method: 'PUT',
        body:   JSON.stringify(body),
      });
      console.log(`    CHECKLIST: "${item.name}" → ${fmtDate(assignDateMs)}`);
    }
  }
}

// ── Core processing ───────────────────────────────────────────────────────────

async function applyOffsets(
  tasks:       CuTask[],
  anchorMs:    number,
  anchorLabel: string,
  offsets:     Record<string, [number, number]>,
  lines:       string[],
): Promise<{ updated: number; missing: number }> {
  const byName = new Map(tasks.map(t => [t.name.trim().toLowerCase(), t]));
  let updated = 0;
  let missing = 0;

  for (const [nameLower, [offset, assignDays]] of Object.entries(offsets)) {
    const task = byName.get(nameLower);
    if (!task) { missing++; continue; }
    const statusType = task.status?.type ?? '';
    const statusName = (task.status?.status ?? '').toLowerCase();
    const isComplete = statusType === 'closed' || statusType === 'done'
      || statusName === 'complete' || statusName === 'completed' || statusName === 'done';
    if (isComplete) {
      console.log(`  SKIP (completed): "${task.name}"`);
      continue;
    }
    const assigneeIds = TEST_ASSIGNEE_ID !== null
      ? [TEST_ASSIGNEE_ID]
      : (ASSIGNEES[nameLower] ?? []);

    if (task.due_date) {
      // Due date already set — add start date if missing (start = due when assignDays is 0)
      if (!task.start_date) {
        const existingDueMs = parseInt(task.due_date, 10);
        const startMs       = addDays(existingDueMs, -assignDays);
        await setDates(task.id, existingDueMs, startMs);
        const fullTask = await cuFetch(`/task/${task.id}`) as CuTask;
        if (fullTask.checklists?.length) {
          await assignChecklistItems(fullTask.checklists, startMs, assigneeIds[0]);
        }
        console.log(`  ADD START: "${task.name}" → start ${fmtDate(startMs)}`);
        updated++;
        if (HAS_SUB_SUBTASKS.has(nameLower)) {
          const children = await getSubtasks(task.id);
          if (children.length) {
            const r = await applyOffsets(children, anchorMs, anchorLabel, offsets, lines);
            updated += r.updated; missing += r.missing;
          }
        }
      } else {
        console.log(`  SKIP (dates already set): "${task.name}"`);
      }
      continue;
    }

    const dueMs   = addDays(anchorMs, offset);
    const startMs = addDays(dueMs, -assignDays);  // assignDays=0 → start equals due
    const sign    = offset >= 0 ? `+${offset}` : `${offset}`;

    await setDates(task.id, dueMs, startMs);
    if (assigneeIds.length) await setAssignees(task.id, assigneeIds);
    const fullTask = await cuFetch(`/task/${task.id}`) as CuTask;
    if (fullTask.checklists?.length) {
      await assignChecklistItems(fullTask.checklists, startMs, assigneeIds[0]);
    }

    const startStr = startMs ? ` (start ${fmtDate(startMs)})` : '';
    lines.push(`  ${task.name}: due ${fmtDate(dueMs)}${startStr} (${anchorLabel} ${sign}d)`);
    console.log(`  SET: "${task.name}" → due ${fmtDate(dueMs)}${startStr}`);
    updated++;

    // Go one level deeper if this task has sub-subtasks
    if (HAS_SUB_SUBTASKS.has(nameLower)) {
      const children = await getSubtasks(task.id);
      if (children.length) {
        const result = await applyOffsets(children, anchorMs, anchorLabel, offsets, lines);
        updated += result.updated;
        missing += result.missing;
      }
    }
  }

  return { updated, missing };
}

async function processJob(launchSection: CuTask, parentId: string): Promise<void> {
  console.log(`\nProcessing: ${launchSection.name} (${launchSection.id}), parent: ${parentId}`);

  // Get sibling sections to find Section 5 anchors
  const sections = await getSubtasks(parentId);

  // ── Section 5: read PO and Completion Date anchors ───────────────────────
  const section5 = sections.find(s => s.name.trim().toLowerCase().startsWith('5'));
  let poMs:         number | null = null;
  let completionMs: number | null = null;

  if (section5) {
    const s5Tasks = await getSubtasks(section5.id);
    const s5ByName = new Map(s5Tasks.map(t => [t.name.trim().toLowerCase(), t]));
    const poTask         = s5ByName.get('place purchase order');
    const completionTask = s5ByName.get('completion date');
    if (poTask?.due_date)         poMs         = parseInt(poTask.due_date, 10);
    if (completionTask?.due_date) completionMs = parseInt(completionTask.due_date, 10);
  } else {
    console.log('  ⚠  Section 5 not found — PO and Completion Date anchors unavailable.');
  }

  // ── Section 6: get subtasks and read Launch Date anchor ──────────────────
  console.log(`  Launch section: "${launchSection.name}" (${launchSection.id})`);

  const subtasks = await getSubtasks(launchSection.id);
  if (!subtasks.length) {
    console.log('  No subtasks in launch section — skipping.');
    return;
  }

  const byName = new Map(subtasks.map(s => [s.name.trim().toLowerCase(), s]));
  const launchMs = byName.get('launch date')?.due_date
    ? parseInt(byName.get('launch date')!.due_date!, 10) : null;

  if (!poMs)         console.log('  ⚠  "Place purchase order" not set in Section 5 — PO section skipped.');
  if (!completionMs) console.log('  ⚠  "Completion Date" not set in Section 5 — Completion section skipped.');
  if (!launchMs)     console.log('  ⚠  "Launch Date" not set in Section 6 — Launch section skipped.');

  if (!poMs && !completionMs && !launchMs) {
    console.log('  No anchor dates set. Skipping.');
    return;
  }

  const lines: string[] = ['Due dates set by automation:\n'];
  let totalUpdated = 0;
  let totalMissing = 0;

  if (poMs) {
    console.log(`  Place Purchase Order: ${fmtDate(poMs)}`);
    lines.push('From Place Purchase Order');
    const r = await applyOffsets(subtasks, poMs, 'PO', FROM_PO, lines);
    totalUpdated += r.updated;
    totalMissing += r.missing;
  }

  if (completionMs) {
    console.log(`  Completion Date: ${fmtDate(completionMs)}`);
    lines.push('\nFrom Completion Date');
    const r = await applyOffsets(subtasks, completionMs, 'Completion', FROM_COMPLETION, lines);
    totalUpdated += r.updated;
    totalMissing += r.missing;
  }

  if (launchMs) {
    console.log(`  Launch Date: ${fmtDate(launchMs)}`);
    lines.push('\nFrom Launch Date');
    const r = await applyOffsets(subtasks, launchMs, 'Launch', FROM_LAUNCH, lines);
    totalUpdated += r.updated;
    totalMissing += r.missing;
  }

  if (totalMissing) {
    lines.push(`\n${totalMissing} subtask(s) not found — names may differ from the offset table.`);
  }
  if (TEST_ASSIGNEE_ID !== null) {
    lines.push(`\nAssigned to: Jon Scoulding (testing mode — swap TEST_ASSIGNEE_ID to null for production).`);
  }
  lines.push(`\n${totalUpdated} task(s) updated. Run at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`);

  await postComment(parentId, lines.join('\n'));
  console.log(`  Done — ${totalUpdated} updated, ${totalMissing} not found.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('ClickUp — New Product Launch: Set Due Dates');
  console.log('--------------------------------------------');
  if (TEST_ASSIGNEE_ID !== null) {
    console.log(`Testing mode: all tasks assigned to user ID ${TEST_ASSIGNEE_ID}.`);
  }

  const jobs = await getTasksForTag(NEW_PRODUCT_TAG);
  console.log(`\n${jobs.length} job(s) tagged "${NEW_PRODUCT_TAG}".`);

  if (!jobs.length) {
    console.log('Nothing to process.');
    return;
  }

  for (const job of jobs) {
    if (job.parent) {
      // Tag is on the launch section itself — process it directly
      await processJob(job, job.parent);
    } else {
      // Tag is on a parent task — find the "6. Launch" section within it
      const sections = await getSubtasks(job.id);
      const launchSection = sections.find(s => s.name.trim().toLowerCase().startsWith('6'));
      if (!launchSection) {
        console.log(`  No "6. Launch" section found in "${job.name}" — skipping.`);
        continue;
      }
      await processJob(launchSection, job.id);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
