'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const BrainStore = require('../lib/BrainStore');
const VaultReader = require('../lib/VaultReader');
const McpServer = require('../lib/McpServer');

const BOARD = '03 - Agents/Coordination/Task Board.md';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overclaw-'));
}

function boardMarkdown() {
  return [
    '# Task Board',
    '',
    '## 🔄 In Progress',
    '',
    '| Task ID | Title | Agent | Started | Deadline |',
    '|---|---|---|---|---|',
    '| [TASK-20261023-003](Tasks/TASK-20261023-003.md) | Publish the November release notes | north | 2026-10-23 | — |',
    '| [TASK-20261023-001](Tasks/TASK-20261023-001.md) | daily swarm security watch | west | 2026-10-23 | — |',
    '| [TASK-20261021-001](Tasks/TASK-20261021-001.md) | daily GCP spend check | west | 2026-10-21 | — |',
    '',
    '## ✅ Done',
    '',
    '| Task ID | Title | Agent | Completed | Output |',
    '|---|---|---|---|---|',
    '| — | — | — | — | — |',
    '',
  ].join('\n');
}

function taskDoc(id, extraFm, body) {
  return [
    '---',
    'task_id: ' + id,
    extraFm,
    '---',
    '',
    body || '',
    '',
  ].join('\n');
}

test('task board reads brain.db and drops standing tasks out of In Progress', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'brain.db');
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, '03 - Agents', 'Coordination'), { recursive: true });
  fs.writeFileSync(path.join(vault, '03 - Agents', 'Coordination', 'Task Board.md'), [
    '## 🔄 In Progress',
    '| Task ID | Title | Agent | Started | Deadline |',
    '|---|---|---|---|---|',
    '| TASK-20261023-003 | stale filesystem copy | north | 2026-10-01 | — |',
    '',
  ].join('\n'));

  const store = new BrainStore(dbPath);
  store.putDoc(BOARD, [
    '# Task Board',
    '',
    '## ✅ Done',
    '',
    '| Task ID | Title | Agent | Completed | Output |',
    '|---|---|---|---|---|',
    '| [TASK-20261023-003](Tasks/TASK-20261023-003.md) | Publish the November release notes | north | 2026-10-30 | shipped |',
    '',
    '## 🔄 In Progress',
    '',
    '| Task ID | Title | Agent | Started | Deadline |',
    '|---|---|---|---|---|',
    '| [TASK-20261023-001](Tasks/TASK-20261023-001.md) | daily swarm security watch | west | 2026-10-23 | — |',
    '| [TASK-20261021-001](Tasks/TASK-20261021-001.md) | daily GCP spend check | west | 2026-10-21 | — |',
    '',
  ].join('\n'), { updatedBy: 'seed' });

  const today = new Date().toISOString().slice(0, 10);
  store.putDoc('03 - Agents/Coordination/Tasks/TASK-20261023-003.md',
    taskDoc('TASK-20261023-003', 'title: "Publish the November release notes"\nstatus: done\ntype: project', 'Done.'),
    { updatedBy: 'seed' });
  store.putDoc('03 - Agents/Coordination/Tasks/TASK-20261023-001.md',
    taskDoc('TASK-20261023-001', 'title: "daily swarm security watch"\ncadence: daily',
      '## 📝 Progress Note — ' + today + '\n\nwatch clean\n'),
    { updatedBy: 'seed' });
  store.putDoc('03 - Agents/Coordination/Tasks/TASK-20261021-001.md',
    taskDoc('TASK-20261021-001', 'title: "daily GCP spend check"',
      '## 📝 Progress Note — 2020-01-01\n\nold\n'),
    { updatedBy: 'seed' });
  store.putDoc('08 - QA-and-Monitoring/Heartbeats/OpenClaw/2026-11-14-09-00-gcp-spend.md',
    '---\njob: gcp-spend\nstatus: ok\n---\n\nTASK-20261021-001\n',
    { updatedBy: 'seed' });

  const reader = new VaultReader(vault, { brainStore: store });
  const sync = await reader.sync();
  assert.equal(sync.disabled, true);
  assert.equal(sync.ok, true);

  const board = await reader.getTaskBoard();
  assert.equal(board.source, 'brain');
  assert.deepEqual(board.inProgress.map(t => t.taskId), []);
  assert.deepEqual(board.done.map(t => t.taskId), ['TASK-20261023-003']);
  assert.equal(board.done[0].type, 'project');
  assert.equal(board.done[0].typeSource, 'explicit');

  const standingIds = ['scheduled', 'active', 'inactive']
    .flatMap(k => board.standing[k].map(t => t.taskId));
  assert.ok(standingIds.includes('TASK-20261023-001'));
  assert.ok(standingIds.includes('TASK-20261021-001'));
  const security = ['scheduled', 'active', 'inactive']
    .flatMap(k => board.standing[k]).find(t => t.taskId === 'TASK-20261023-001');
  assert.equal(security.type, 'standing');
  assert.equal(security.typeSource, 'inferred:cadence');
  assert.equal(security.standingStatus, 'active');
  assert.equal(security.cadence, 'daily');
  assert.equal(board.stats.inProgress, 0);
  assert.ok(board.stats.standing >= 2);

  const versionsBefore = store.getHistory('03 - Agents/Coordination/Tasks/TASK-20261023-001.md').length;
  await reader.updateTaskFile('03 - Agents/Coordination/Tasks/TASK-20261023-001.md', {
    type: 'standing',
    standing_status: 'active',
    cadence: 'daily',
  });
  const versionsAfter = store.getHistory('03 - Agents/Coordination/Tasks/TASK-20261023-001.md');
  assert.ok(versionsAfter.length > versionsBefore);
  const disk = fs.readFileSync(path.join(vault, '03 - Agents', 'Coordination', 'Task Board.md'), 'utf8');
  assert.match(disk, /stale filesystem copy/);
  assert.doesNotMatch(disk, /security watch/);

  store.close();
});

test('filesystem fallback is used only when the database is closed', async () => {
  const dir = tmpDir();
  const vault = path.join(dir, 'vault');
  const boardDir = path.join(vault, '03 - Agents', 'Coordination');
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'Task Board.md'), boardMarkdown().replace(
    'daily swarm security watch',
    'filesystem only task'
  ));
  const reader = new VaultReader(vault);
  const status = await reader.isAvailable();
  assert.equal(status.source, 'filesystem');
  const board = await reader.getTaskBoard();
  assert.equal(board.source, 'filesystem');
  const wip = board.inProgress.map(t => t.taskId);
  assert.ok(wip.includes('TASK-20261023-003'));
  assert.ok(!wip.includes('TASK-20261021-001'));
  assert.equal(board.stats.standing, 1);
});

test('migration dry-run does not write and --apply creates a document version', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'brain.db');
  const store = new BrainStore(dbPath);
  store.putDoc('03 - Agents/Coordination/Tasks/TASK-20261023-001.md',
    '---\ntitle: "daily swarm security watch"\n---\n\n# daily swarm security watch\n',
    { updatedBy: 'seed' });
  store.close();

  const script = path.join(__dirname, '..', 'scripts', 'migrate-task-types.js');
  const dry = await runNode([script, '--db', dbPath]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, /TASK-20261023-001/);

  const afterDry = new BrainStore(dbPath);
  const still = afterDry.getDoc('03 - Agents/Coordination/Tasks/TASK-20261023-001.md').content;
  assert.doesNotMatch(still, /^type:/m);
  afterDry.close();

  const apply = await runNode([script, '--db', dbPath, '--apply']);
  assert.equal(apply.code, 0);
  assert.match(apply.stdout, /Updated 1/);

  const applied = new BrainStore(dbPath);
  const content = applied.getDoc('03 - Agents/Coordination/Tasks/TASK-20261023-001.md').content;
  assert.match(content, /type: standing/);
  assert.match(content, /standing_status: /);
  assert.match(content, /cadence: daily/);
  const history = applied.getHistory('03 - Agents/Coordination/Tasks/TASK-20261023-001.md');
  assert.ok(history.length >= 1);
  applied.close();
});

test('MCP claim leaves a standing task off In Progress and returns the new fields', async () => {
  const dir = tmpDir();
  const store = new BrainStore(path.join(dir, 'brain.db'));
  store.putDoc(BOARD, [
    '## 📥 Inbox',
    '| Task ID | Title | Assigned To | Priority | Deadline | Created |',
    '|---|---|---|---|---|---|',
    '| TASK-20261023-001 | daily swarm security watch | west | medium | — | 2026-10-23 |',
    '',
    '## 🔄 In Progress',
    '| Task ID | Title | Agent | Started | Deadline |',
    '|---|---|---|---|---|',
    '',
  ].join('\n'), { updatedBy: 'seed' });
  store.putDoc('03 - Agents/Coordination/Tasks/TASK-20261023-001.md',
    '---\ntitle: "daily swarm security watch"\ntype: standing\ncadence: daily\n---\n\n# watch\n',
    { updatedBy: 'seed' });
  const mcp = new McpServer({ vaultReader: null, vaultPath: dir, brainStore: store });
  const claimed = await mcp._claimTask({
    taskId: 'TASK-20261023-001',
    agent: 'west',
    type: 'standing',
    standing_status: 'active',
    cadence: 'daily',
  });
  assert.equal(claimed.status, 'standing');
  assert.equal(claimed.standing_status, 'active');
  const board = store.getDoc(BOARD).content;
  assert.doesNotMatch(board, /In Progress[\s\S]*TASK-20261023-001/);
  const task = await mcp._getTask({ taskId: 'TASK-20261023-001' });
  assert.equal(task.type, 'standing');
  assert.equal(task.typeSource, 'explicit');
  store.close();
});

test('app starts and /status responds', async () => {
  const dir = tmpDir();
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      BRAIN_DB_PATH: path.join(dir, 'brain.db'),
      VAULT_PATH: path.join(dir, 'vault'),
      OVERCLAW_ADMIN_USER: '',
      OVERCLAW_ADMIN_PASS: '',
      OPENCLAW_API_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  try {
    const started = await waitFor(() => logs.includes('OverClaw running'), 15000);
    assert.equal(started, true, logs);
    const res = await fetch('http://127.0.0.1:' + port + '/status');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    const page = await fetch('http://127.0.0.1:' + port + '/task-board');
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Project Tasks/);
    assert.match(html, /id="kanban-board"/);
    assert.match(html, /BOARD_KIND\s*=\s*"project"/);
    assert.match(html, /href="\/tasks\/standing"/);
    assert.doesNotMatch(html, /id="standing-board"/);
    assert.doesNotMatch(html, />Task Board</);

    const standingPage = await fetch('http://127.0.0.1:' + port + '/tasks/standing');
    const standingHtml = await standingPage.text();
    assert.equal(standingPage.status, 200);
    assert.match(standingHtml, /Standing Tasks/);
    assert.match(standingHtml, /id="standing-board"/);
    assert.match(standingHtml, /Scheduled/);
    assert.match(standingHtml, /Inactive/);
    assert.match(standingHtml, /BOARD_KIND\s*=\s*"standing"/);
    assert.doesNotMatch(standingHtml, /id="kanban-board"/);
    assert.doesNotMatch(standingHtml, />Task Board</);

    const kanban = await fetch('http://127.0.0.1:' + port + '/kanban', { redirect: 'manual' });
    assert.equal(kanban.status, 301);
    assert.match(kanban.headers.get('location') || '', /\/task-board$/);
    const projectsKanban = await fetch('http://127.0.0.1:' + port + '/projects/kanban', { redirect: 'manual' });
    assert.equal(projectsKanban.status, 301);
    assert.match(projectsKanban.headers.get('location') || '', /\/task-board$/);
  } finally {
    child.kill('SIGTERM');
  }
});

function runNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..') });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function waitFor(pred, ms) {
  const start = Date.now();
  return new Promise(resolve => {
    const t = setInterval(() => {
      if (pred()) { clearInterval(t); resolve(true); }
      else if (Date.now() - start > ms) { clearInterval(t); resolve(false); }
    }, 50);
  });
}
