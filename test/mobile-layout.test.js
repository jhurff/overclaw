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

test('phone widths do not overflow and Brain stacks', { timeout: 300000, skip: !CHROME && 'Chrome is not installed' }, async () => {
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
    await settle(page);
    const editorShare = await contentShare(page, '#docArea');
    assert.ok(editorShare.ratio >= 0.8, 'editor content ' + editorShare.ratio);
    assert.ok(editorShare.chrome <= 100, 'editor chrome ' + editorShare.chrome);
    assert.equal(editorShare.header, 'none');
    assert.equal(editorShare.nav, 'none');
    await page.click('#docMore');
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
      bar: document.getElementById('docToolbar').getBoundingClientRect().height,
    }));
    assert.equal(opened.open, true);
    assert.equal(opened.editing, true);
    assert.match(opened.path, /path=/);
    assert.ok(opened.back >= 44, 'Back is ' + opened.back);
    assert.ok(opened.font >= 16, 'editor font ' + opened.font);
    assert.equal(opened.nav, 'none');
    assert.ok(opened.bar <= 56, 'top bar ' + opened.bar);
    assert.deepEqual(opened.buttons.map(b => b.text), ['Preview', 'Save', 'History', 'Delete', 'Focus']);
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
    await page.click('#docMore');
    await page.click('#modeBtn');
    await page.waitForSelector('#bb-preview:not([hidden])');
    await settle(page);
    const previewShare = await contentShare(page, '#docArea');
    assert.ok(previewShare.ratio >= 0.8, 'doc view content ' + previewShare.ratio);
    const preview = await page.evaluate(() => {
      const box = document.getElementById('bb-preview');
      const pre = box.querySelector('pre');
      const table = box.querySelector('table');
      const scroll = table && table.parentElement;
      const cell = table && table.querySelector('th, td');
      return {
        editing: document.body.classList.contains('bb-editing'),
        label: document.getElementById('modeBtn').textContent.trim(),
        pre: pre ? getComputedStyle(pre).overflowX : '',
        preWhite: pre ? getComputedStyle(pre).whiteSpace : '',
        tableScroll: !!(scroll && scroll.classList.contains('bb-table-scroll')),
        tableOverflow: scroll ? getComputedStyle(scroll).overflowX : '',
        cellMin: cell ? parseFloat(getComputedStyle(cell).minWidth) : 0,
        cellBreak: cell ? getComputedStyle(cell).wordBreak : '',
        wider: !!(scroll && scroll.scrollWidth > scroll.clientWidth + 1),
        wraps: getComputedStyle(box).overflowWrap,
      };
    });
    assert.equal(preview.editing, false);
    assert.equal(preview.label, 'Edit');
    assert.ok(preview.pre === 'auto' || preview.pre === 'scroll', preview.pre);
    assert.equal(preview.tableScroll, true);
    assert.ok(preview.tableOverflow === 'auto' || preview.tableOverflow === 'scroll', preview.tableOverflow);
    assert.ok(preview.cellMin >= 128, 'column min ' + preview.cellMin);
    assert.equal(preview.cellBreak, 'normal');
    assert.equal(preview.wider, true);
    assert.ok(preview.wraps === 'anywhere' || preview.wraps === 'break-word');

    await page.goto(base + '/brain/history?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bh-ver');
    await settle(page);
    assert.equal(await page.evaluate(() => document.body.classList.contains('bh-ver-open')), false);
    const listShare = await contentShare(page, '#verList');
    assert.ok(listShare.ratio >= 0.8, 'history list content ' + listShare.ratio);
    assert.equal(listShare.header, 'none');
    assert.equal(listShare.nav, 'none');
    assert.ok(listShare.chrome <= 100, 'history chrome ' + listShare.chrome);
    await page.click('.bh-ver');
    await page.waitForFunction(() => document.body.classList.contains('bh-ver-open'));
    await page.waitForSelector('#histMore', { visible: true });
    await settle(page);
    const verShare = await contentShare(page, '#panelContent');
    assert.ok(verShare.ratio >= 0.8, 'history version content ' + verShare.ratio);
    assert.ok(verShare.chrome <= 100, 'version chrome ' + verShare.chrome);
    await page.click('#histMore');
    await page.click('#tabPreview');
    await page.waitForSelector('#panelContent table');
    const histTable = await page.evaluate(() => {
      const table = document.querySelector('#panelContent table');
      const scroll = table.parentElement;
      const cell = table.querySelector('th, td');
      return {
        scroll: !!(scroll && scroll.classList.contains('bh-table-scroll')),
        overflow: scroll ? getComputedStyle(scroll).overflowX : '',
        cellMin: cell ? parseFloat(getComputedStyle(cell).minWidth) : 0,
        wider: !!(scroll && scroll.scrollWidth > scroll.clientWidth + 1),
      };
    });
    assert.equal(histTable.scroll, true);
    assert.ok(histTable.overflow === 'auto' || histTable.overflow === 'scroll');
    assert.ok(histTable.cellMin >= 128, 'history column ' + histTable.cellMin);
    assert.equal(histTable.wider, true);
    const hist = await page.evaluate(overflowScript);
    assert.deepEqual(hist.offenders, [], JSON.stringify(hist.offenders));
    await page.click('#verBack');
    await page.waitForFunction(() => !document.body.classList.contains('bh-ver-open'));

    const shotDir = '/opt/cursor/artifacts/brain-focus';
    fs.mkdirSync(shotDir, { recursive: true });
    for (const theme of ['matrix', 'usa', 'neutral']) {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await switchTheme(page, theme);
      await page.goto(base + '/brain?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#bb-md-input');
      await settle(page);
      const themeEditor = await contentShare(page, '#docArea');
      assert.ok(themeEditor.ratio >= 0.8, theme + ' editor ' + themeEditor.ratio);
      assert.equal(themeEditor.header, 'none');
      await page.screenshot({ path: path.join(shotDir, theme + '-editor.png') });
      await page.click('#docMore');
      await page.click('#modeBtn');
      await page.waitForSelector('#bb-preview:not([hidden])');
      await settle(page);
      const themeDoc = await contentShare(page, '#docArea');
      assert.ok(themeDoc.ratio >= 0.8, theme + ' doc ' + themeDoc.ratio);
      await page.screenshot({ path: path.join(shotDir, theme + '-doc.png') });
      await page.click('#docMore');
      await page.click('#modeBtn');
      await page.waitForSelector('#bb-md-input');
      await page.setViewport({ width: 390, height: 500, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.focus('#bb-md-input');
      await page.keyboard.type('Line above the keyboard. ');
      await settle(page);
      const keyboard = await page.evaluate(() => {
        const save = document.getElementById('docSavebar');
        const input = document.getElementById('bb-md-input');
        const saveRect = save.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const vh = window.innerHeight;
        const visible = Math.min(inputRect.bottom, vh) - Math.max(inputRect.top, 0);
        return {
          vh,
          saveTop: saveRect.top,
          saveBottom: saveRect.bottom,
          saveDisplay: getComputedStyle(save).display,
          visible,
          vv: window.visualViewport ? window.visualViewport.height : vh,
        };
      });
      assert.equal(keyboard.saveDisplay, 'flex');
      assert.ok(keyboard.saveBottom <= keyboard.vh + 2, 'save below viewport ' + keyboard.saveBottom);
      assert.ok(keyboard.saveTop >= keyboard.vh - 80, 'save not pinned ' + keyboard.saveTop);
      assert.ok(keyboard.visible >= 300, 'editor visible ' + keyboard.visible);
      await page.screenshot({ path: path.join(shotDir, theme + '-editor-keyboard.png') });
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.goto(base + '/brain/history?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.bh-ver');
      await page.click('.bh-ver');
      await page.waitForFunction(() => document.body.classList.contains('bh-ver-open'));
      await page.waitForSelector('#histMore', { visible: true });
      await page.click('#histMore');
      await page.click('#tabPreview');
      await page.waitForSelector('#panelContent table');
      await settle(page);
      const themeHist = await contentShare(page, '#panelContent');
      assert.ok(themeHist.ratio >= 0.8, theme + ' history ' + themeHist.ratio);
      assert.equal(themeHist.header, 'none');
      await page.screenshot({ path: path.join(shotDir, theme + '-history.png') });
    }

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

    await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false });
    await switchTheme(page, 'matrix');
    await page.goto(base + '/brain?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#saveBtn', { visible: true });
    const desktop = await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector('.oc-header')).display,
      more: getComputedStyle(document.getElementById('docMore')).display,
      tree: getComputedStyle(document.querySelector('.bb-tree')).display,
      main: getComputedStyle(document.querySelector('.bb-main')).display,
      open: document.body.classList.contains('bb-doc-open'),
      savebar: getComputedStyle(document.getElementById('docSavebar')).display,
      labels: Array.from(document.querySelectorAll('.bb-actions .bb-btn'))
        .filter(el => getComputedStyle(el).display !== 'none')
        .map(el => el.textContent.trim()),
    }));
    assert.notEqual(desktop.header, 'none');
    assert.equal(desktop.more, 'none');
    assert.equal(desktop.open, false);
    assert.notEqual(desktop.tree, 'none');
    assert.notEqual(desktop.main, 'none');
    assert.equal(desktop.savebar, 'none');
    assert.ok(desktop.labels.includes('Save'));
    assert.ok(desktop.labels.includes('History'));
    assert.ok(desktop.labels.includes('Delete'));
    assert.equal(desktop.labels.includes('Focus'), false);
    await page.goto(base + '/brain/history?path=' + encodeURIComponent(DOC), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bh-ver');
    const desktopHist = await page.evaluate(() => ({
      more: getComputedStyle(document.getElementById('histListMore')).display,
      header: getComputedStyle(document.querySelector('.oc-header')).display,
      tabs: getComputedStyle(document.getElementById('tabDiff')).display,
    }));
    assert.equal(desktopHist.more, 'none');
    assert.notEqual(desktopHist.header, 'none');
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

async function contentShare(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const header = document.querySelector('.oc-header');
    const nav = document.querySelector('.oc-bottom-nav');
    const shown = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return node.getBoundingClientRect().height > 1;
    };
    const bars = [document.getElementById('docToolbar'), document.getElementById('docSavebar'), document.querySelector('.bh-topbar'), document.querySelector('.bh-ptoolbar')];
    let chrome = 0;
    for (const bar of bars) {
      if (shown(bar)) chrome += bar.getBoundingClientRect().height;
    }
    return {
      ratio: rect.height / vh,
      height: Math.round(rect.height),
      vh,
      chrome: Math.round(chrome),
      header: header ? getComputedStyle(header).display : '',
      nav: nav ? getComputedStyle(nav).display : '',
    };
  }, selector);
}

async function switchTheme(page, id) {
  await page.evaluate(async (themeId) => {
    const r = await fetch('/api/themes/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: themeId }),
    });
    if (!r.ok) throw new Error('theme switch failed');
  }, id);
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await new Promise(resolve => setTimeout(resolve, 150));
}
