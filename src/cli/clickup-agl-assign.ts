#!/usr/bin/env tsx
// clickup-agl-assign.ts
// Finds subtasks under AGL-tagged parent tasks with no assignee and assigns them
// based on per-subtask assignment windows:
//   - "1 week before" subtasks: assign when due within 7 days (or overdue)
//   - "day before" subtasks: assign when due tomorrow or overdue
//   - "manually done" subtasks (anchors + manual tasks): never auto-assign
// Schedule: Every weekday at 9am UTC via GitHub Actions.
// Run: npx tsx src/cli/clickup-agl-assign.ts

import 'dotenv/config';

const WORKSPACE_ID = '20480650';
const API_BASE    = 'https://api.clickup.com/api/v2';
const ALL_AGL_TAGS = ['cf-agl', 'gk-agl', 'kin-agl'];

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

interface CuUser {
  id: number;
  username: string;
}

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

async function getCurrentUser(): Promise<CuUser> {
  const data = await cuFetch('/user') as { user: CuUser };
  return data.user;
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

async function assignUser(taskId: string, userId: number): Promise<void> {
  await cuFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ assignees: { add: [userId], rem: [] } }),
  });
}

async function postComment(taskId: string, text: string): Promise<void> {
  await cuFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text }),
  });
}

// Uses Europe/London throughout so BST/GMT offsets don't cause missed assignments.
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

  // Default: assign when due tomorrow or already overdue
  return toDateStr(dueDateMs) <= todayPlusDaysStr(1);
}

async function main(): Promise<void> {
  console.log('ClickUp AGL - Auto Assign');
  console.log('-------------------------');

  const user = await getCurrentUser();
  console.log(`Assigning to: ${user.username} (ID: ${user.id})`);

  const parents = await getAglParentTasks();
  console.log(`Found ${parents.length} AGL parent task(s).`);

  let totalAssigned = 0;

  for (const parent of parents) {
    const subtasks = await getSubtasks(parent.id);
    const assigned: string[] = [];

    for (const sub of subtasks) {
      if (!sub.due_date) continue;
      if (sub.assignees.length > 0) continue;
      if (sub.status?.type === 'closed') continue;

      const nameLower = sub.name.trim().toLowerCase();
      if (!shouldAssignNow(nameLower, parseInt(sub.due_date, 10))) continue;

      await assignUser(sub.id, user.id);
      assigned.push(`  ${sub.name}`);
      totalAssigned++;
      console.log(`  Assigned: "${sub.name}" under "${parent.name}"`);
    }

    if (assigned.length > 0) {
      const msg = [
        `Auto-assigned ${assigned.length} subtask(s):`,
        ...assigned,
        `\nAssigned to: ${user.username}`,
        `Run at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`,
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
