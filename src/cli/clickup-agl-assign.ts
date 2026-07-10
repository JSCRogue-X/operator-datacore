#!/usr/bin/env tsx
// clickup-agl-assign.ts
// Finds subtasks under AGL-tagged parent tasks with no assignee and assigns the
// configured person(s) based on the subtask name and assignment window:
//   - "1 week before" subtasks: assign when due within 7 days (or overdue)
//   - "day before" subtasks: assign when due tomorrow or overdue
//   - "manually done" subtasks (anchors + manual tasks): never auto-assign
// Schedule: Every weekday at 9am UTC via GitHub Actions.
// Run: npx tsx src/cli/clickup-agl-assign.ts

import 'dotenv/config';

const WORKSPACE_ID = '20480650';
const API_BASE     = 'https://api.clickup.com/api/v2';
const ALL_AGL_TAGS = ['cf-agl', 'gk-agl', 'kin-agl'];

// Subtask name (lowercase) → ClickUp user ID(s) to assign
const ASSIGNEES: Record<string, number[]> = {
  'pay deposit (if required)':        [32614247],           // HilaryTaylor
  'add po to sostocked':              [32614246],           // Jon Scoulding
  'request packing list':             [32614246],           // Jon Scoulding
  'create agl shipment':              [32614246],           // Jon Scoulding
  'add batch codes to shipment':      [32614246],           // Jon Scoulding
  'send fba box labels to ghl':       [32614246],           // Jon Scoulding
  'create commercial invoice':        [32614246],           // Jon Scoulding
  'create packing list':              [32614246],           // Jon Scoulding
  'upload ci/pl to google drive':     [32614246],           // Jon Scoulding
  'create google split file':         [32614246],           // Jon Scoulding
  'review inspection report':         [87803456, 32614246], // Paul Atkinson + Jon Scoulding
  'make final payment':               [32614247],           // HilaryTaylor
  'provide final costings':           [32614247],           // HilaryTaylor
  'review import duties':             [32547067],           // Anthony Taylor
  'update unit pricing (agl)':        [32547067],           // Anthony Taylor
  'save customs clearance docs':      [87803456],           // Paul Atkinson
};

// Display names for comment readability
const USER_NAMES: Record<number, string> = {
  32614246: 'Jon Scoulding',
  32614247: 'HilaryTaylor',
  87803456: 'Paul Atkinson',
  32547067: 'Anthony Taylor',
};

// Anchor subtasks and manually-managed tasks — never auto-assign
const NEVER_ASSIGN = new Set([
  'order date',
  'completion date',
  'delivery date',
  'move invoice into xero',
  'switch on ppc for any out of stock lines',
]);

// Assign 7 days before the task date (payment / financial tasks)
const ASSIGN_ONE_WEEK_BEFORE = new Set([
  'pay deposit (if required)',
  'make final payment',
  'provide final costings',
  'review import duties',
  'update unit pricing (agl)',
]);

// All other subtasks: assign the day before (tomorrow or overdue)

interface CuTask {
  id: string;
  name: string;
  parent: string | null;
  due_date: string | null;
  status: { type: string };
  assignees: { id: number }[];
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

async function assignUsers(taskId: string, userIds: number[]): Promise<void> {
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

const toDateStr = (ms: number) =>
  new Date(ms).toLocaleDateString('sv', { timeZone: 'Europe/London' }); // sv = YYYY-MM-DD

function todayPlusDaysStr(days: number): string {
  const [y, m, d] = toDateStr(Date.now()).split('-').map(Number) as [number, number, number];
  return toDateStr(new Date(Date.UTC(y, m - 1, d + days)).getTime());
}

function shouldAssignNow(subtaskNameLower: string, dueDateMs: number): boolean {
  if (NEVER_ASSIGN.has(subtaskNameLower)) return false;

  if (ASSIGN_ONE_WEEK_BEFORE.has(subtaskNameLower)) {
    return toDateStr(dueDateMs) <= todayPlusDaysStr(7);
  }

  return toDateStr(dueDateMs) <= todayPlusDaysStr(1);
}

async function main(): Promise<void> {
  console.log('ClickUp AGL - Auto Assign');
  console.log('-------------------------');

  const parents = await getAglParentTasks();
  console.log(`Found ${parents.length} AGL parent task(s).`);

  let totalAssigned = 0;

  for (const parent of parents) {
    const subtasks = await getSubtasks(parent.id);
    const assignedLines: string[] = [];

    for (const sub of subtasks) {
      if (!sub.due_date) continue;
      if (sub.assignees.length > 0) continue;
      if (sub.status?.type === 'closed') continue;

      const nameLower = sub.name.trim().toLowerCase();
      if (!shouldAssignNow(nameLower, parseInt(sub.due_date, 10))) continue;

      const userIds = ASSIGNEES[nameLower];
      if (!userIds) {
        console.log(`  SKIP (no assignee configured): "${sub.name}"`);
        continue;
      }

      await assignUsers(sub.id, userIds);
      const names = userIds.map(id => USER_NAMES[id] ?? String(id)).join(' + ');
      assignedLines.push(`  ${sub.name} → ${names}`);
      totalAssigned++;
      console.log(`  Assigned: "${sub.name}" → ${names} (under "${parent.name}")`);
    }

    if (assignedLines.length > 0) {
      const msg = [
        `Auto-assigned ${assignedLines.length} subtask(s):`,
        ...assignedLines,
        `\nRun at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`,
      ].join('\n');
      await postComment(parent.id, msg);
    }
  }

  if (totalAssigned === 0) {
    console.log('No unassigned subtasks ready for assignment.');
  } else {
    console.log(`\nDone. ${totalAssigned} subtask(s) assigned.`);
  }
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
