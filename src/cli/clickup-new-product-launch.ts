#!/usr/bin/env tsx
// Finds jobs tagged "new-product", locates the "6. Launch" section within each,
// and sets due dates + assignee on all subtasks (and their sub-subtasks) based
// on anchor dates set inside the Launch section.
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

// Testing: all tasks assigned to Jon (32614246). Swap TEST_ASSIGNEE_ID to null
// and populate ASSIGNEES below once out of testing.
const TEST_ASSIGNEE_ID: number | null = 32614246; // jon@spincare.co.uk — set to null for production

// Production assignees by subtask name (lowercase). Only used when TEST_ASSIGNEE_ID is null.
// Multiple user IDs per task are supported.
const ASSIGNEES: Record<string, number[]> = {
  'duplicate product launch sheet':                          [/* will murphy */],
  'provide launch/retail/list pricing for amazon locales':   [/* anthony taylor */],
  'provide features/benefits for the products':             [/* anthony taylor */],
  'product demo':                                           [/* anthony taylor */],
  'provide image brief notes':                              [/* anthony taylor */],
  'complete marketing handover':                            [/* anthony taylor */],
  'create maxamaze project':                                [/* laura haygarth-borland */],
  'request reach report':                                   [/* jon scoulding */],
  'review/approve reach report':                            [/* jon scoulding */],
  'save reach report to google drive':                      [/* jon scoulding */],
  'upload reach report to pcm':                             [/* jon scoulding */],
  'create/save sds (factory)':                              [/* jon scoulding */],
  'review/approve factory sds':                             [/* jon scoulding */],
  'request production samples':                             [/* paul atkinson */],
  'maxamaze project complete':                              [/* laura haygarth-borland */],
  'basic mintsoft sku setup':                               [/* jon scoulding */],
  'basic linnworks import':                                 [/* jon scoulding */],
  'create mkl':                                             [/* will murphy */],
  'create listing data':                                    [/* will murphy */],
  'research/setup ppc campaigns':                           [/* will murphy */],
  'create sp campaigns':                                    [/* will murphy */],
  'add to branded search campaign':                         [/* will murphy */],
  'create negative keyword list':                           [/* will murphy */],
  'update/add negative master keyword list':                [/* will murphy */],
  'add pts as negative product targets':                    [/* will murphy */],
  'review listing':                                         [/* anthony taylor, laura */],
  'listing amends':                                         [/* will murphy */],
  'approve listing':                                        [/* anthony taylor, laura */],
  'complete ih launch template':                            [/* laura, will murphy */],
  'import & list products on ih channels':                  [/* will murphy */],
  'create flat file template':                              [/* will murphy */],
  'sub task - add b2b pricing':                             [/* will murphy */],
  'sub task - set max order quantity to 20':                [/* will murphy */],
  'sub task upload to amazon / close listing':              [/* will murphy */],
  'sostocked sku setup':                                    [/* paul atkinson */],
  'create/save sds (fast track)':                           [/* jon scoulding */],
  'review/approve fast track sds completed.':               [/* jon scoulding */],
  'complete pcm entry':                                     [/* jon scoulding */],
  'upload sds':                                             [/* will murphy */],
  'send test shipment':                                     [/* jon scoulding */],
  'inventory - ship inventory to amazon uk':                [/* paul atkinson */],
  'inventory - ship inventory to amazon eu':                [/* paul atkinson */],
  'add images to listing':                                  [/* will murphy */],
  'launch email campaign':                                  [/* laura haygarth-borland */],
  'ebay promoted listing setup':                            [/* will murphy */],
  'ebay add multi-buy discounts':                           [/* will murphy */],
  'add shopify multi-buy discounts':                        [/* will murphy */],
  'announce launch on social media':                        [/* will murphy */],
  'amazon launch':                                          [/* will murphy */],
  'add to marketing kpi tracker':                           [/* laura haygarth-borland */],
  'enrol in vine (if using)':                               [/* will murphy */],
  'create coupon':                                          [/* will murphy */],
  'add to rank radar':                                      [/* will murphy */],
  'add cost price into sellerboard.io':                     [/* anthony taylor */],
  'enter cogs into sellerboard':                            [/* will murphy */],
  'add asin to storefront':                                 [/* will murphy */],
  'sub task - add asin to home page':                       [/* will murphy */],
  'sub task - add asin to category page':                   [/* will murphy */],
  'weekly review price':                                    [/* will murphy */],
  'add campaigns to scale insights automation':             [/* will murphy */],
  'negative keyword check':                                 [/* will murphy */],
  'check review request automation (captaina)':             [/* will murphy */],
  'analyse reviews for listing improvements (60 days)':     [/* will murphy */],
  'analyse reviews for listing improvements (90 days)':     [/* will murphy */],
  're-order eligibility (60 days)':                         [/* anthony taylor, paul atkinson, laura */],
  're-order eligibility (90 days)':                         [/* anthony taylor, paul atkinson, laura */],
};

// ── Offset tables (days from anchor) ─────────────────────────────────────────

// Section 1: anchored to "Place Purchase Order" date (positive = after PO)
// Requires a subtask named "Place Purchase Order" to be added to the template.
const FROM_PO: Record<string, number> = {
  'duplicate product launch sheet':                         1,
  'provide launch/retail/list pricing for amazon locales':  7,
  'provide features/benefits for the products':             7,
  'product demo':                                           7,
  'provide image brief notes':                              7,
  'complete marketing handover':                            7,
  'create maxamaze project':                                8,
  'request reach report':                                  14,
  'review/approve reach report':                           14,
  'save reach report to google drive':                     14,
  'upload reach report to pcm':                            14,
  'create/save sds (factory)':                             14,
  'review/approve factory sds':                            14,
};

// Section 2: anchored to "Completion Date" (negative = before completion)
// Requires a subtask named "Completion Date" to be added to the template.
const FROM_COMPLETION: Record<string, number> = {
  'request production samples':    0,
  'maxamaze project complete':   -14,
  'basic mintsoft sku setup':    -30,
  'basic linnworks import':      -30,
};

// Section 3: anchored to "Launch Date" — this subtask already exists in the template
const FROM_LAUNCH: Record<string, number> = {
  'create mkl':                                            -90,
  'create listing data':                                   -90,
  'research/setup ppc campaigns':                          -90,
  'create sp campaigns':                                   -90,  // sub-subtask
  'add to branded search campaign':                        -90,  // sub-subtask
  'create negative keyword list':                          -90,  // sub-subtask
  'update/add negative master keyword list':               -90,  // sub-subtask
  'add pts as negative product targets':                   -90,  // sub-subtask
  'review listing':                                        -81,
  'listing amends':                                        -81,
  'approve listing':                                       -74,
  'complete ih launch template':                           -60,
  'import & list products on ih channels':                 -60,
  'create flat file template':                             -60,
  'sub task - add b2b pricing':                            -60,  // sub-subtask
  'sub task - set max order quantity to 20':               -60,  // sub-subtask
  'sub task upload to amazon / close listing':             -60,  // sub-subtask
  'sostocked sku setup':                                   -59,
  'create/save sds (fast track)':                          -59,
  'review/approve fast track sds completed.':              -59,
  'complete pcm entry':                                    -59,
  'upload sds':                                            -58,
  'send test shipment':                                    -57,
  'inventory - ship inventory to amazon uk':               -21,
  'inventory - ship inventory to amazon eu':               -21,
  'add images to listing':                                 -14,
  'launch email campaign':                                 -11,
  'ebay promoted listing setup':                             0,
  'ebay add multi-buy discounts':                            0,
  'add shopify multi-buy discounts':                         0,
  'announce launch on social media':                         0,
  'amazon launch':                                           0,
  'add to marketing kpi tracker':                            0,
  'enrol in vine (if using)':                                0,
  'create coupon':                                           0,
  'add to rank radar':                                       1,
  'add cost price into sellerboard.io':                      1,
  'enter cogs into sellerboard':                             1,
  'add asin to storefront':                                  1,
  'sub task - add asin to home page':                        1,  // sub-subtask
  'sub task - add asin to category page':                    1,  // sub-subtask
  'weekly review price':                                     7,
  'add campaigns to scale insights automation':             10,
  'negative keyword check':                                 10,
  'check review request automation (captaina)':             10,
  'analyse reviews for listing improvements (60 days)':     14,
  'analyse reviews for listing improvements (90 days)':     28,
  're-order eligibility (60 days)':                         60,
  're-order eligibility (90 days)':                         90,
};

// Subtasks that have their own children to process
const HAS_SUB_SUBTASKS = new Set([
  'research/setup ppc campaigns',
  'create flat file template',
  'add asin to storefront',
]);

// ── API helpers ───────────────────────────────────────────────────────────────

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
  return new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
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

async function setAssignees(taskId: string, userIds: number[]): Promise<void> {
  if (!userIds.length) return;
  await cuFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ assignees: userIds }),
  });
}

async function postComment(taskId: string, text: string): Promise<void> {
  await cuFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text }),
  });
}

// ── Core processing ───────────────────────────────────────────────────────────

async function applyOffsets(
  tasks:       CuTask[],
  anchorMs:    number,
  anchorLabel: string,
  offsets:     Record<string, number>,
  lines:       string[],
): Promise<{ updated: number; missing: number }> {
  const byName = new Map(tasks.map(t => [t.name.trim().toLowerCase(), t]));
  let updated = 0;
  let missing = 0;

  for (const [nameLower, offset] of Object.entries(offsets)) {
    const task = byName.get(nameLower);
    if (!task) { missing++; continue; }
    if (task.status?.type === 'closed') {
      console.log(`  SKIP (completed): "${task.name}"`);
      continue;
    }

    const newMs      = addDays(anchorMs, offset);
    const sign       = offset >= 0 ? `+${offset}` : `${offset}`;
    const assigneeIds = TEST_ASSIGNEE_ID !== null
      ? [TEST_ASSIGNEE_ID]
      : (ASSIGNEES[nameLower] ?? []);

    await setDueDate(task.id, newMs);
    if (assigneeIds.length) await setAssignees(task.id, assigneeIds);

    lines.push(`  ${task.name}: ${fmtDate(newMs)} (${anchorLabel} ${sign}d)`);
    console.log(`  SET: "${task.name}" → ${fmtDate(newMs)}`);
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

async function processNewProductJob(parent: CuTask): Promise<void> {
  console.log(`\nProcessing: ${parent.name} (${parent.id})`);

  // Get all top-level sections of this job
  const sections = await getSubtasks(parent.id);
  const bySection = new Map(sections.map(s => [s.name.trim().toLowerCase(), s]));

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

  // ── Section 6: read Launch Date anchor and get tasks to process ───────────
  const launchSection = sections.find(s => s.name.trim().toLowerCase().startsWith('6'));
  if (!launchSection) {
    console.log('  No "6. Launch" section found — skipping.');
    return;
  }
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
    lines.push('── From Place Purchase Order ──');
    const r = await applyOffsets(subtasks, poMs, 'PO', FROM_PO, lines);
    totalUpdated += r.updated;
    totalMissing += r.missing;
  }

  if (completionMs) {
    console.log(`  Completion Date: ${fmtDate(completionMs)}`);
    lines.push('\n── From Completion Date ──');
    const r = await applyOffsets(subtasks, completionMs, 'Completion', FROM_COMPLETION, lines);
    totalUpdated += r.updated;
    totalMissing += r.missing;
  }

  if (launchMs) {
    console.log(`  Launch Date: ${fmtDate(launchMs)}`);
    lines.push('\n── From Launch Date ──');
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

  await postComment(parent.id, lines.join('\n'));
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
    await processNewProductJob(job);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
