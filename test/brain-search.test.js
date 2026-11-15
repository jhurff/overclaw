'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const BrainStore = require('../lib/BrainStore');

const ROOT = path.join(__dirname, '..');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-search-'));
  const store = new BrainStore(path.join(dir, 'brain.db'));
  return { dir, store };
}

function seed(store) {
  store.putDoc('05 - Research/Environment.md', '# Environment\n\nRuntime environment for the swarm.\n', { updatedBy: 'test' });
  store.putDoc('02 - Projects/Enterprise Architecture.md', '# Enterprise Architecture\n\nHow the pieces fit together.\n', { updatedBy: 'test' });
  store.putDoc('Environment/Overview.md', '# Overview\n\nA map of the system.\n', { updatedBy: 'test' });
  store.putDoc('00 - Home/Notes.md', '# Notes\n\n' + 'environment '.repeat(40) + '\nCheck the deploy variable.\n', { updatedBy: 'test' });
  store.putDoc('00 - Home/Danger.md', '# Danger\n\n<script>alert(1)</script> environment\n', { updatedBy: 'test' });
  store.putDoc('03 - Agents/Unrelated.md', '# Unrelated\n\nNothing about boats here.\n', { updatedBy: 'test' });
  for (let i = 0; i < 60; i++) {
    store.putDoc('Widgets/Widget ' + i + '.md', '# Widget ' + i + '\n\nA widget note.\n', { updatedBy: 'test' });
  }
}

test('prefix search ranks names above content and escapes queries', () => {
  const { dir, store } = tempStore();
  try {
    seed(store);
    const page = store.search('Envi', { limit: 20, detail: true });
    const paths = page.results.map(row => row.path);
    assert.ok(paths.includes('05 - Research/Environment.md'));
    assert.equal(paths.includes('02 - Projects/Enterprise Architecture.md'), false);
    assert.ok(paths.includes('Environment/Overview.md'));
    assert.ok(paths.includes('00 - Home/Notes.md'));
    assert.equal(paths.includes('03 - Agents/Unrelated.md'), false);
    const both = store.search('En', { limit: 20, detail: true }).results.map(row => row.path);
    assert.ok(both.includes('05 - Research/Environment.md'));
    assert.ok(both.includes('02 - Projects/Enterprise Architecture.md'));
    const enterprise = store.search('Ente', { detail: true });
    assert.ok(enterprise.results.some(row => row.path.includes('Enterprise Architecture')));
    assert.equal(enterprise.results.some(row => row.path.endsWith('Environment.md')), false);

    const titleAt = paths.indexOf('05 - Research/Environment.md');
    const pathAt = paths.indexOf('Environment/Overview.md');
    const contentAt = paths.indexOf('00 - Home/Notes.md');
    assert.ok(titleAt < pathAt, paths.join(' | '));
    assert.ok(pathAt < contentAt, paths.join(' | '));
    assert.equal(page.results.find(row => row.path.endsWith('Environment.md')).match, 'title');
    assert.equal(page.results.find(row => row.path === 'Environment/Overview.md').match, 'path');
    assert.equal(page.results.find(row => row.path.endsWith('Notes.md')).match, 'content');

    const env = page.results.find(row => row.path.endsWith('Environment.md'));
    assert.equal(env.title, 'Environment');
    assert.equal(env.folder, '05 - Research');
    assert.match(env.snippet, /<mark>envi/i);
    assert.equal(env.snippet.includes('<script>'), false);

    const danger = page.results.find(row => row.path.endsWith('Danger.md'));
    assert.ok(danger);
    assert.match(danger.snippet, /&lt;script&gt;/);
    assert.equal(danger.snippet.includes('<script>'), false);
    assert.match(danger.snippet, /<mark>/);

    const upper = store.search('ENVI', { detail: true });
    assert.ok(upper.results.some(row => row.path.endsWith('Environment.md')));

    const content = store.search('variable', { detail: true });
    assert.deepEqual(content.results.map(row => row.path), ['00 - Home/Notes.md']);
    assert.equal(content.results[0].match, 'content');
    assert.match(content.results[0].snippet, /<mark>variable/i);

    const scoped = store.search('Ente', { dir: '02 - Projects', detail: true });
    assert.deepEqual(scoped.results.map(row => row.path), ['02 - Projects/Enterprise Architecture.md']);

    const nasty = ['Envi" OR (SELECT', 'Envi*', 'foo:bar', '***', '"', '(', ')', 'AND OR NOT NEAR', "it's", 'path:secret'];
    for (const q of nasty) {
      const result = store.search(q, { detail: true });
      assert.ok(Array.isArray(result.results), q);
    }
    const still = store.search('Envi"*(', { detail: true });
    assert.ok(still.results.some(row => row.path.endsWith('Environment.md')));
    assert.equal(store.search('***', { detail: true }).results.length, 0);
    assert.deepEqual(store.search('   ', { detail: true }).results, []);
    assert.ok(Array.isArray(store.search('Envi')));

    const first = store.search('Widget', { limit: 50, offset: 0, detail: true });
    assert.equal(first.total, 60);
    assert.equal(first.results.length, 50);
    assert.equal(first.limit, 50);
    const second = store.search('Widget', { limit: 80, offset: 50, detail: true });
    assert.equal(second.limit, 50);
    assert.equal(second.results.length, 10);
    assert.equal(second.offset, 50);
    const seen = new Set([...first.results, ...second.results].map(row => row.path));
    assert.equal(seen.size, 60);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search endpoint requires brain auth and survives special characters', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-search-http-'));
  const dbPath = path.join(dir, 'brain.db');
  const store = new BrainStore(dbPath);
  seed(store);
  store.close();
  const port = 22000 + Math.floor(Math.random() * 20000);
  const key = 'search-test-key';
  const user = 'search-user';
  const pass = 'search-pass';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      BRAIN_DB_PATH: dbPath,
      VAULT_PATH: path.join(dir, 'vault'),
      OVERCLAW_ADMIN_USER: user,
      OVERCLAW_ADMIN_PASS: pass,
      MCP_API_KEY: key,
      OPENCLAW_API_TOKEN: '',
      OPENCLAW_GATEWAY_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', buf => { log += buf.toString(); });
  child.stderr.on('data', buf => { log += buf.toString(); });
  const base = 'http://127.0.0.1:' + port;
  try {
    await waitFor(base, child, () => log);
    const open = await fetch(base + '/api/brain/search?q=Envi');
    assert.equal(open.status, 401);
    const wrong = await fetch(base + '/api/brain/search?q=Envi', { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const headers = { Authorization: 'Bearer ' + key, 'X-Agent-Name': 'search-test' };
    const authed = await fetch(base + '/api/brain/search?q=Envi&limit=20', { headers });
    assert.equal(authed.status, 200);
    const body = await authed.json();
    assert.ok(body.results.some(row => row.path.endsWith('Environment.md')));
    const ente = await (await fetch(base + '/api/brain/search?q=Ente', { headers })).json();
    assert.ok(ente.results.some(row => row.path.includes('Enterprise Architecture')));
    const titleIdx = body.results.findIndex(row => row.match === 'title');
    const contentIdx = body.results.findIndex(row => row.path.endsWith('Notes.md'));
    assert.ok(titleIdx !== -1 && titleIdx < contentIdx);

    const content = await (await fetch(base + '/api/brain/search?q=variable', { headers })).json();
    assert.equal(content.results.length, 1);
    assert.equal(content.results[0].match, 'content');
    assert.match(content.results[0].snippet, /<mark>variable/i);

    const special = await fetch(base + '/api/brain/search?q=' + encodeURIComponent('Envi"*('), { headers });
    assert.equal(special.status, 200);
    const specialBody = await special.json();
    assert.ok(specialBody.results.some(row => row.path.endsWith('Environment.md')));
    const operators = await fetch(base + '/api/brain/search?q=' + encodeURIComponent('Envi" OR (SELECT *'), { headers });
    assert.equal(operators.status, 200);
    assert.ok(Array.isArray((await operators.json()).results));

    for (const q of ['***', '"', 'foo:bar*', 'AND OR NOT']) {
      const res = await fetch(base + '/api/brain/search?q=' + encodeURIComponent(q), { headers });
      assert.equal(res.status, 200, q);
      const payload = await res.json();
      assert.ok(Array.isArray(payload.results), q);
    }

    const blank = await fetch(base + '/api/brain/search?q=%20%20', { headers });
    assert.equal(blank.status, 400);

    const page = await (await fetch(base + '/api/brain/search?q=Widget&limit=500&offset=50', { headers })).json();
    assert.equal(page.limit, 50);
    assert.equal(page.offset, 50);
    assert.equal(page.total, 60);
    assert.equal(page.results.length, 10);

    let cookie = '';
    const start = Date.now();
    while (!cookie && Date.now() - start < 10000) {
      const login = await fetch(base + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (login.ok) cookie = login.headers.get('set-cookie') || '';
      else await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(cookie.includes('brain_session'), 'login cookie missing\n' + log.slice(-500));
    const session = await fetch(base + '/api/brain/search?q=Envi', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.ok(sessionBody.results.some(row => row.path.endsWith('Environment.md')));
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(base, child, log) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (child.exitCode != null) throw new Error('server exited\n' + log().slice(-1500));
    try {
      const res = await fetch(base + '/status');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('server did not start\n' + log().slice(-1500));
}
