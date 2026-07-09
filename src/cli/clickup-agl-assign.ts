#!/usr/bin/env tsx
// clickup-agl-assign.ts
// Finds subtasks under AGL-tagged parent tasks that are due tomorrow or overdue and have no assignee.
// Assigns them to the authenticated user (Jon) and posts a summary comment.
// Schedule: Every weekday at 9am UTC via GitHub Actions.
// Run: npx tsx src/cli/clickup-agl-assign.ts

import 'dotenv/config';

const WORKSPACE_ID = '20480650';
const API_BASE    = 'https://api.clickup.com/api/v2';
const ALL_AGL_TAGS = ['cf-agl', 'gk-agl', 'kin-agl'];

interface CuUser {
  id: number;
  username: string;
}

interface CuTask {
  id: string;
  name: string;
  parent: string | null;
  due_date: string | null;
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
    body: JSON.stringify({ assignees: { add: [userId], rem: [] }, status: 'Assigned' }),
  });
}

async function postComment(taskId: string, text: string): Promise<void> {
  await cuFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text }),
  });
}

function isDueTomorrowOrEarlier(dueDateMs: number): boolean {
  // Returns true for overdue tasks as well as tasks due tomorrow.
  // Uses Europe/London so BST/GMT offsets don't cause missed assignments.
  const tz = 'Europe/London';
  const toDateStr = (ms: number) => new Date(ms).toLocaleDateString('sv', { timeZone: tz }); // sv = YYYY-MM-DD
  const [y, m, d] = toDateStr(Date.now()).split('-').map(Number) as [number, number, number];
  const tomorrowStr = toDateStr(new Date(Date.UTC(y, m - 1, d + 1)).getTime());
  return toDateStr(dueDateMs) <= tomorrowStr;
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
      if (!isDueTomorrowOrEarlier(parseInt(sub.due_date, 10))) continue;
      if (sub.assignees.length > 0) continue;

      await assignUser(sub.id, user.id);
      assigned.push(`  ${sub.name}`);
      totalAssigned++;
      console.log(`  Assigned: "${sub.name}" under "${parent.name}"`);
    }

    if (assigned.length > 0) {
      const msg = [
        `Auto-assigned ${assigned.length} subtask(s) due tomorrow or overdue:`,
        ...assigned,
        `\nAssigned to: ${user.username}`,
        `Run at ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`,
      ].join('\n');
      await postComment(parent.id, msg);
    }
  }

  if (totalAssigned === 0) {
    console.log('No unassigned subtasks due tomorrow or overdue.');
  } else {
    console.log(`\nDone. ${totalAssigned} subtask(s) assigned.`);
  }
}

main().catch(err => {
  console.error('\nError:', err);
  process.exit(1);
});
