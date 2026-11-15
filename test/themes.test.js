'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const BrainStore = require('../lib/BrainStore');
const {
  ThemeStore,
  ThemeError,
  validatePack,
  sanitizeExtraCss,
  THEME_TOKEN_KEYS,
  DEFAULT_THEME_ID,
} = require('../lib/themePacks');
const registerThemeRoutes = require('../lib/themeRoutes');

const BUILTIN = path.join(__dirname, '..', 'themes');

function tempStore(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-themes-'));
  const store = new ThemeStore({
    builtinDir: extra.builtinDir || BUILTIN,
    userDir: path.join(root, 'themes'),
    settingsPath: path.join(root, 'ui-settings.json'),
    brainStore: extra.brainStore || null,
  });
  return { root, store };
}

function harborPack(id = 'harbor') {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'sample-theme.json'), 'utf8'));
  raw.id = id;
  return raw;
}

function zipStored(files) {
  const parts = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, nameBuf, data);
  }
  return Buffer.concat(parts);
}

test('built-in packs define every token and Matrix is the default', () => {
  const { store } = tempStore();
  const active = store.getActive();
  assert.equal(active.id, DEFAULT_THEME_ID);
  assert.equal(active.fallback, false);
  assert.equal(active.builtin, true);
  const ids = store.list().map(t => t.id);
  assert.deepEqual(ids.filter(id => ['matrix', 'usa', 'neutral'].includes(id)).sort(), ['matrix', 'neutral', 'usa']);
  for (const id of ['matrix', 'usa', 'neutral']) {
    const pack = store.get(id);
    const missing = THEME_TOKEN_KEYS.filter(key => !pack.tokens[key]);
    assert.deepEqual(missing, [], id + ' is missing tokens');
    assert.equal(pack.css.includes('<'), false);
    assert.match(pack.css, /:root\{/);
  }
  assert.equal(store.get('matrix').effects.includes('digital-rain'), true);
  assert.equal(store.get('usa').tokens['--oc-accent'].toLowerCase(), '#b22234');
  assert.equal(store.get('matrix').tokens['--oc-bg'].toLowerCase(), '#000000');
});

test('a missing preference file selects Matrix', () => {
  const { store } = tempStore();
  assert.equal(fs.existsSync(store.settingsPath), false);
  assert.equal(store.getActive().id, 'matrix');
});

test('an unknown saved id falls back to Matrix', () => {
  const { root, store } = tempStore();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(store.settingsPath, JSON.stringify({ activeThemeId: 'missing-pack' }));
  const active = store.getActive();
  assert.equal(active.id, 'matrix');
  assert.equal(active.fallback, true);
});

test('setActive persists and a new store reads it', () => {
  const { root, store } = tempStore();
  const saved = store.setActive('usa');
  assert.equal(saved.id, 'usa');
  const again = new ThemeStore({
    builtinDir: BUILTIN,
    userDir: path.join(root, 'themes'),
    settingsPath: path.join(root, 'ui-settings.json'),
  });
  assert.equal(again.getActive().id, 'usa');
  assert.equal(again.reset().id, 'matrix');
  assert.equal(again.getActive().id, 'matrix');
});

test('setActive rejects an unknown id', () => {
  const { store } = tempStore();
  assert.throws(() => store.setActive('not-a-theme'), ThemeError);
});

test('built-in packs cannot be removed', () => {
  const { store } = tempStore();
  assert.throws(() => store.remove('matrix'), (err) => err instanceof ThemeError && err.status === 403);
  assert.throws(() => store.remove('usa'), (err) => err.status === 403);
});

test('sample pack file validates and can be imported, then removed', () => {
  const { store } = tempStore();
  const raw = harborPack('harbor');
  const imported = store.importJson(raw);
  assert.equal(imported.id, 'harbor');
  assert.equal(imported.builtin, false);
  assert.equal(store.list().some(t => t.id === 'harbor'), true);
  assert.equal(store.get('harbor').tokens['--oc-bg'].toLowerCase(), '#06282e');
  store.setActive('harbor');
  assert.equal(store.getActive().id, 'harbor');
  const removed = store.remove('harbor');
  assert.equal(removed.removed, 'harbor');
  assert.equal(removed.active.id, 'matrix');
  assert.equal(store.list().some(t => t.id === 'harbor'), false);
});

test('import refuses to replace a built-in id', () => {
  const { store } = tempStore();
  const raw = harborPack('matrix');
  assert.throws(() => store.importJson(raw), /built-in/i);
});

test('validation rejects script, imports, and urls in CSS', () => {
  assert.throws(() => sanitizeExtraCss('body { background: url(javascript:alert(1)); }'), /disallowed/i);
  assert.throws(() => sanitizeExtraCss('@import "https://evil.example/x.css";'), /disallowed/i);
  assert.throws(() => sanitizeExtraCss('</style><script>alert(1)</script>'), /disallowed/i);
  assert.throws(() => sanitizeExtraCss('body { behavior: url(x.htc); }'), /disallowed/i);
  const raw = harborPack('harbor');
  raw.css = 'body::after { content: "<script>"; }';
  assert.throws(() => validatePack(raw), ThemeError);
  raw.css = '.ok { color: var(--oc-text); }';
  const pack = validatePack(raw);
  assert.match(pack.css, /\.ok/);
});

test('token values cannot smuggle a url or a style breakout', () => {
  const raw = harborPack('bad-token');
  raw.tokens['--oc-bg'] = 'url(https://evil.example/x)';
  assert.throws(() => validatePack(raw), /token value/i);
  raw.tokens['--oc-bg'] = '#06282e; } body{background:red';
  assert.throws(() => validatePack(raw), /token value/i);
});

test('ids reject traversal and uppercase', () => {
  const raw = harborPack('harbor');
  raw.id = '../harbor';
  assert.throws(() => validatePack(raw), /id/i);
  raw.id = 'Harbor';
  assert.throws(() => validatePack(raw), /id/i);
});

test('partial tokens inherit Matrix defaults', () => {
  const { store } = tempStore();
  const raw = {
    id: 'partial',
    name: 'Partial',
    tokens: {
      '--oc-bg': '#112233',
      '--oc-text': '#eef2f6',
      '--oc-accent': '#cc8800',
      '--oc-bg-card': '#223344',
      '--oc-border': '#334455',
      '--oc-theme-color': '#112233',
    },
  };
  store.importJson(raw);
  const pack = store.get('partial');
  assert.equal(pack.tokens['--oc-bg'], '#112233');
  assert.equal(pack.tokens['--oc-heat-4'], store.get('matrix').tokens['--oc-heat-4']);
});

test('zip import accepts theme.json plus extra.css and rejects traversal', () => {
  const { store } = tempStore();
  const raw = harborPack('fromzip');
  delete raw.css;
  const buf = zipStored({
    'fromzip/theme.json': JSON.stringify(raw),
    'fromzip/extra.css': '.oc-card { border-color: var(--oc-accent); }\n',
  });
  const imported = store.importZip(buf);
  assert.equal(imported.id, 'fromzip');
  assert.match(imported.css, /border-color: var\(--oc-accent\)/);

  const evil = zipStored({ '../theme.json': '{"id":"x"}' });
  assert.throws(() => store.importZip(evil), /not allowed|missing theme.json/i);
  const scripted = zipStored({
    'theme.json': JSON.stringify(harborPack('scripted')),
    'extra.css': 'body { background: url(https://evil.example/a.png); }',
  });
  assert.throws(() => store.importZip(scripted), /disallowed/i);
});

test('active theme is also stored in brain.db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-brain-theme-'));
  const brain = new BrainStore(path.join(root, 'brain.db'));
  const store = new ThemeStore({
    builtinDir: BUILTIN,
    userDir: path.join(root, 'themes'),
    settingsPath: path.join(root, 'ui-settings.json'),
    brainStore: brain,
  });
  store.setActive('neutral');
  assert.equal(brain.getSetting('activeThemeId'), 'neutral');
  const again = new ThemeStore({
    builtinDir: BUILTIN,
    userDir: path.join(root, 'themes'),
    settingsPath: path.join(root, 'missing-settings.json'),
    brainStore: brain,
  });
  assert.equal(again.getActive().id, 'neutral');
  brain.close();
});

test('HTTP routes switch, reset, reject a bad import, and refuse to delete Matrix', async () => {
  const { store } = tempStore();
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  registerThemeRoutes(app, store);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const active = await fetch(base + '/api/themes/active').then(r => r.json());
    assert.equal(active.id, 'matrix');
    const switched = await fetch(base + '/api/themes/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'usa' }),
    }).then(r => r.json());
    assert.equal(switched.id, 'usa');
    const reset = await fetch(base + '/api/themes/reset', { method: 'POST' }).then(r => r.json());
    assert.equal(reset.id, 'matrix');
    const bad = await fetch(base + '/api/themes/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: { id: 'nope', name: 'Nope', tokens: {}, css: '<script>alert(1)</script>' } }),
    });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.match(body.error, /token|css|disallowed|required/i);
    const del = await fetch(base + '/api/themes/matrix', { method: 'DELETE' });
    assert.equal(del.status, 403);
    const manifest = await fetch(base + '/manifest.webmanifest').then(r => r.json());
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.theme_color.toLowerCase(), '#000000');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('user pack paths stay inside themes/ (CodeQL js/path-injection)', () => {
  const { root, store } = tempStore();
  const userRoot = path.resolve(root, 'themes');
  assert.equal(store._userPackDir('harbor'), path.join(userRoot, 'harbor'));
  for (const bad of ['../harbor', '..', '.', 'a/b', 'a\\b', '/etc', 'Harbor', '', '__proto__', 'x'.repeat(41), null, 42]) {
    assert.throws(() => store._userPackDir(bad), ThemeError, String(bad));
  }
  const dir = store._userPackDir('harbor');
  assert.equal(store._userPackFile(dir, 'theme.json'), path.join(dir, 'theme.json'));
  for (const bad of ['../theme.json', '../../ui-settings.json', 'sub/theme.json', '/etc/passwd']) {
    assert.throws(() => store._userPackFile(dir, bad), ThemeError, bad);
  }
  // A forged pack that skipped validation still cannot write outside themes/.
  assert.throws(() => store._writeUserPack({ id: '../escape', name: 'x', tokens: {}, fonts: {}, effects: [] }), ThemeError);
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  assert.throws(() => store.remove('../themes'), ThemeError);
  assert.equal(fs.existsSync(root), true);
  // Normal import still lands in themes/<id>/.
  store.importJson(harborPack('harbor'));
  assert.equal(fs.existsSync(path.join(userRoot, 'harbor', 'theme.json')), true);
  store.remove('harbor');
  assert.equal(fs.existsSync(path.join(userRoot, 'harbor')), false);
});
