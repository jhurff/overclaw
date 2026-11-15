'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const BrainStore = require('../lib/BrainStore');

const ROOT = path.join(__dirname, '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome']
  .find(p => fs.existsSync(p));
const USER = 'mobile-audit';
const PASS = 'mobile-audit-pass';
const DOC = 'Phone Check.md';
const NESTED = '03 - Agents/Phone Check.md';
const WIDTHS = [375, 390, 430];
const PAGES = [
  '/swarm',
  '/task-board',
  '/tasks/standing',
  '/brain',
  '/activity',
  '/settings/themes',
  '/agents',
  '/tools',
  '/nodes',
  '/scheduled-tasks',
  '/config',
  '/logs',
  '/debug',
  '/docs',
  '/version',
  '/security',
  '/gap-atlas',
  '/vault/graph',
  '/sessions',
  '/brain/login',
  '/resolve?alert=notes/example.md',
];

const DOC_BODY = [
  '# Phone check',
  '',
  'This paragraph should wrap on a narrow phone so the rendered view stays readable.',
  '',
  '```js',
  'const veryLongLine = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789";',
  '```',
  '',
  '| Column one | Column two | Column three | Column four |',
  '| --- | --- | --- | --- |',
  '| alpha | beta | gamma | delta |',
  '',
].join('\n');

function seedBrain(dbPath) {
  const store = new BrainStore(dbPath);
  store.putDoc(DOC, DOC_BODY, { updatedBy: 'test' });
  store.putDoc(DOC, DOC_BODY + '\nA second save so history has a version.\n', { updatedBy: 'test' });
  store.putDoc(NESTED, '# Nested\n\nFolder file.\n', { updatedBy: 'test' });
  const starter = path.join(ROOT, 'starter-brain');
  const docs = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.md')) {
        const rel = path.relative(starter, full).split(path.sep).join('/');
        docs.push({ path: rel, content: fs.readFileSync(full, 'utf8'), updatedBy: 'starter' });
      }
    }
  };
  if (fs.existsSync(starter)) walk(starter);
  if (docs.length) store.bulkImport(docs);
  store.close();
}

function startServer(dbPath, port) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      BRAIN_DB_PATH: dbPath,
      VAULT_PATH: path.join(path.dirname(dbPath), 'vault'),
      OVERCLAW_ADMIN_USER: USER,
      OVERCLAW_ADMIN_PASS: PASS,
      OPENCLAW_API_TOKEN: '',
      OPENCLAW_GATEWAY_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (buf) => { log += buf.toString(); });
  child.stderr.on('data', (buf) => { log += buf.toString(); });
  child.log = () => log.slice(-2000);
  return child;
}

function overflowScript() {
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  const nodes = document.body.querySelectorAll('*');
  for (const el of nodes) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const tooWide = rect.width > vw + 2;
    const sticksOut = rect.right > vw + 2 && rect.left >= -1;
    if (!tooWide && !sticksOut) continue;
    let clipped = false;
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const ps = getComputedStyle(parent);
      const ox = ps.overflowX;
      if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') && parent.clientWidth <= vw + 1) {
        clipped = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (clipped) continue;
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    offenders.push({
      tag: el.tagName,
      id: el.id || '',
      cls: String(cls).slice(0, 80),
      w: Math.round(rect.width),
      right: Math.round(rect.right),
    });
    if (offenders.length >= 8) break;
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, offenders };
}

test('phone widths do not overflow and Brain stacks', { timeout: 180000, skip: !CHROME && 'Chrome is not installed' }, async () => {
  const puppeteer = require('puppeteer-core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mobile-'));
  const dbPath = path.join(dir, 'brain.db');
  const settingsPath = path.join(ROOT, 'data', 'ui-settings.json');
  const settingsBackup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
  seedBrain(dbPath);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = startServer(dbPath, port);
  const base = 'http://127.0.0.1:' + port;
  let browser;
  try {
    await waitForServer(base, child);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(base + '/brain/login', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    const problems = [];
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
      for (const route of PAGES) {
        const res = await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        if (!res || res.status() >= 500) {
          problems.push(width + ' ' + route + ' status ' + (res && res.status()));
          continue;
        }
        await settle(page);
        const report = await page.evaluate(overflowScript);
        if (report.offenders.length) problems.push(width + ' ' + route + ' ' + JSON.stringify(report.offenders));
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(base + '/brain', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bb-file');
    const treeFirst = await page.evaluate(() => ({
      open: document.body.classList.contains('bb-doc-open'),
      tree: getComputedStyle(document.querySelector('.bb-tree')).display,
      main: getComputedStyle(document.querySelector('.bb-main')).display,
    }));
    assert.equal(treeFirst.open, false);
    assert.notEqual(treeFirst.tree, 'none');
    assert.equal(treeFirst.main, 'none');

    const file = await page.evaluateHandle((doc) => {
      return Array.from(document.querySelectorAll('.bb-file')).find(n => n.dataset.path === doc);
    }, DOC);
    await file.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await file.click();
    await page.waitForSelector('#bb-md-input');
    const opened = await page.evaluate(() => ({
      open: document.body.classList.contains('bb-doc-open'),
      editing: document.body.classList.contains('bb-editing'),
      path: location.pathname + location.search,
      back: document.getElementById('docBack').getBoundingClientRect().height,
      font: parseFloat(getComputedStyle(document.getElementById('bb-md-input')).fontSize),
      buttons: Array.from(document.querySelectorAll('.bb-actions .bb-btn')).map(el => ({
        text: el.textContent.trim(),
        h: el.getBoundingClientRect().height,
        overflow: el.scrollWidth > el.clientWidth + 1,
      })),
      nav: getComputedStyle(document.querySelector('.oc-bottom-nav')).display,
    }));
    assert.equal(opened.open, true);
    assert.equal(opened.editing, true);
    assert.match(opened.path, /path=/);
    assert.ok(opened.back >= 44, 'Back is ' + opened.back);
    assert.ok(opened.font >= 16, 'editor font ' + opened.font);
    assert.equal(opened.nav, 'none');
    assert.deepEqual(opened.buttons.map(b => b.text), ['Preview', 'Save', 'History', 'Delete']);
    for (const button of opened.buttons) {
      assert.ok(button.h >= 44, button.text + ' height ' + button.h);
      assert.equal(button.overflow, false, button.text + ' is truncated');
    }
    const historyLen = await page.evaluate(() => history.length);
    await page.goBack();
    await page.waitForFunction(() => !document.body.classList.contains('bb-doc-open'));
    assert.ok((await page.evaluate(() => history.length)) >= historyLen - 1);

    await page.goto(base + '/brain?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bb-md-input');
    assert.equal(await page.evaluate(() => document.body.classList.contains('bb-doc-open')), true);
    await page.click('#modeBtn');
    await page.waitForSelector('#bb-preview:not([hidden])');
    const preview = await page.evaluate(() => {
      const box = document.getElementById('bb-preview');
      const pre = box.querySelector('pre');
      const table = box.querySelector('table');
      const scroll = table && table.parentElement;
      return {
        editing: document.body.classList.contains('bb-editing'),
        label: document.getElementById('modeBtn').textContent.trim(),
        pre: pre ? getComputedStyle(pre).overflowX : '',
        tableScroll: !!(scroll && scroll.classList.contains('bb-table-scroll')),
        wraps: getComputedStyle(box).overflowWrap,
      };
    });
    assert.equal(preview.editing, false);
    assert.equal(preview.label, 'Markdown');
    assert.ok(preview.pre === 'auto' || preview.pre === 'scroll', preview.pre);
    assert.equal(preview.tableScroll, true);
    assert.ok(preview.wraps === 'anywhere' || preview.wraps === 'break-word');

    await page.goto(base + '/brain/history?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bh-ver');
    assert.equal(await page.evaluate(() => document.body.classList.contains('bh-ver-open')), false);
    await page.click('.bh-ver');
    await page.waitForFunction(() => document.body.classList.contains('bh-ver-open'));
    const hist = await page.evaluate(overflowScript);
    assert.deepEqual(hist.offenders, [], JSON.stringify(hist.offenders));
    await page.click('#verBack');
    await page.waitForFunction(() => !document.body.classList.contains('bh-ver-open'));

    for (const theme of ['usa', 'neutral', 'matrix']) {
      await page.evaluate(async (id) => {
        const r = await fetch('/api/themes/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!r.ok) throw new Error('theme switch failed');
      }, theme);
      for (const route of ['/swarm', '/task-board', '/tasks/standing', '/brain', '/activity', '/settings/themes']) {
        await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        await settle(page);
        const report = await page.evaluate(overflowScript);
        assert.deepEqual(report.offenders, [], theme + ' ' + route + ' ' + JSON.stringify(report.offenders));
      }
    }
  } catch (err) {
    err.message += '\nserver log:\n' + child.log();
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    if (settingsBackup) fs.writeFileSync(settingsPath, settingsBackup);
    else if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForServer(base, child) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (child.exitCode != null) throw new Error('server exited\n' + child.log());
    try {
      const r = await fetch(base + '/status');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('server did not start\n' + child.log());
}

async function waitForLogin(page) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const ok = await page.evaluate(async (body) => {
      const r = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.ok;
    }, { username: USER, password: PASS });
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('login was not accepted');
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await new Promise(resolve => setTimeout(resolve, 150));
}
