'use strict';

/**
 * Theme pack loader, validator, and persistence.
 *
 * Built-in packs live in themes/<id>/theme.json.
 * Imported packs live in data/themes/<id>/ (gitignored, survives deploy reset).
 * The active id is stored in data/ui-settings.json and, when BrainStore is up,
 * in the app_settings table so it follows the brain database across devices
 * that share that file.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_THEME_ID = 'matrix';
const SETTINGS_KEY = 'activeThemeId';

const MAX_JSON_BYTES = 100 * 1024;
const MAX_ZIP_BYTES = 200 * 1024;
const MAX_CSS_CHARS = 20 * 1000;
const MAX_UNZIPPED_FILE = 100 * 1024;

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const TOKEN_RE = /^--oc-[a-z0-9-]{1,40}$/;
const FONT_URL_RE = /^https:\/\/fonts\.googleapis\.com\/css2\?[A-Za-z0-9=&+.,%:@;_-]+$/;
const EFFECT_IDS = new Set(['digital-rain']);

const REQUIRED_TOKENS = [
  '--oc-bg',
  '--oc-text',
  '--oc-accent',
  '--oc-bg-card',
  '--oc-border',
  '--oc-theme-color',
];

/** Every pack should define these. Partial imports inherit the rest from Matrix. */
const THEME_TOKEN_KEYS = [
  '--oc-bg',
  '--oc-bg-elevated',
  '--oc-bg-sunken',
  '--oc-bg-header',
  '--oc-bg-sidebar',
  '--oc-bg-card',
  '--oc-bg-input',
  '--oc-bg-code',
  '--oc-bg-hover',
  '--oc-overlay',
  '--oc-text',
  '--oc-text-heading',
  '--oc-text-muted',
  '--oc-text-faint',
  '--oc-text-inverse',
  '--oc-text-on-accent',
  '--oc-text-header',
  '--oc-text-link',
  '--oc-border',
  '--oc-border-strong',
  '--oc-accent',
  '--oc-accent-hover',
  '--oc-accent-soft',
  '--oc-accent-text',
  '--oc-success',
  '--oc-success-hover',
  '--oc-success-soft',
  '--oc-success-text',
  '--oc-warning',
  '--oc-warning-hover',
  '--oc-warning-soft',
  '--oc-warning-text',
  '--oc-danger',
  '--oc-danger-hover',
  '--oc-danger-soft',
  '--oc-danger-text',
  '--oc-info',
  '--oc-info-hover',
  '--oc-info-soft',
  '--oc-info-text',
  '--oc-status-inbox',
  '--oc-status-inbox-text',
  '--oc-status-progress',
  '--oc-status-progress-text',
  '--oc-status-blocked',
  '--oc-status-blocked-text',
  '--oc-status-done',
  '--oc-status-done-text',
  '--oc-status-scheduled',
  '--oc-status-scheduled-text',
  '--oc-shadow',
  '--oc-shadow-lg',
  '--oc-glow',
  '--oc-radius',
  '--oc-font-sans',
  '--oc-font-display',
  '--oc-font-mono',
  '--oc-header-height',
  '--oc-bottom-nav-height',
  '--oc-theme-color',
  '--oc-stripe',
  '--oc-focus',
  '--oc-heat-0',
  '--oc-heat-1',
  '--oc-heat-2',
  '--oc-heat-3',
  '--oc-heat-4',
  '--oc-series-1',
  '--oc-series-2',
  '--oc-series-3',
  '--oc-series-4',
  '--oc-series-5',
  '--oc-series-6',
  '--oc-series-7',
  '--oc-series-8',
];

/** Last-resort Matrix tokens if themes/matrix/theme.json cannot be read. */
const FALLBACK_TOKENS = {
  '--oc-bg': '#000000',
  '--oc-bg-elevated': '#031107',
  '--oc-bg-sunken': '#000000',
  '--oc-bg-header': '#000000',
  '--oc-bg-sidebar': '#010a04',
  '--oc-bg-card': '#041208',
  '--oc-bg-input': '#000000',
  '--oc-bg-code': '#001a08',
  '--oc-bg-hover': 'rgba(0, 255, 65, 0.08)',
  '--oc-overlay': 'rgba(0, 0, 0, 0.72)',
  '--oc-text': '#b6ffc9',
  '--oc-text-heading': '#00ff41',
  '--oc-text-muted': '#6ee796',
  '--oc-text-faint': '#5dcc7a',
  '--oc-text-inverse': '#001a08',
  '--oc-text-on-accent': '#001404',
  '--oc-text-header': '#00ff41',
  '--oc-text-link': '#7dffb0',
  '--oc-border': '#0d4d22',
  '--oc-border-strong': '#1a8f3a',
  '--oc-accent': '#00ff41',
  '--oc-accent-hover': '#5dff87',
  '--oc-accent-soft': 'rgba(0, 255, 65, 0.14)',
  '--oc-accent-text': '#00ff41',
  '--oc-success': '#00ff41',
  '--oc-success-hover': '#5dff87',
  '--oc-success-soft': 'rgba(0, 255, 65, 0.12)',
  '--oc-success-text': '#9dffb8',
  '--oc-warning': '#d6ff4a',
  '--oc-warning-hover': '#eaff8a',
  '--oc-warning-soft': 'rgba(214, 255, 74, 0.12)',
  '--oc-warning-text': '#e8ff9a',
  '--oc-danger': '#ff4d6a',
  '--oc-danger-hover': '#ff7a8e',
  '--oc-danger-soft': 'rgba(255, 77, 106, 0.16)',
  '--oc-danger-text': '#ffb3c0',
  '--oc-info': '#5dffa8',
  '--oc-info-hover': '#8dffc4',
  '--oc-info-soft': 'rgba(0, 255, 120, 0.12)',
  '--oc-info-text': '#b8ffd8',
  '--oc-status-inbox': '#7dffb3',
  '--oc-status-inbox-text': '#c8ffe0',
  '--oc-status-progress': '#00ff41',
  '--oc-status-progress-text': '#9dffb8',
  '--oc-status-blocked': '#ff4d6a',
  '--oc-status-blocked-text': '#ffb3c0',
  '--oc-status-done': '#3dff88',
  '--oc-status-done-text': '#b8ffd0',
  '--oc-status-scheduled': '#d6ff4a',
  '--oc-status-scheduled-text': '#e8ff9a',
  '--oc-shadow': '0 0 0 1px rgba(0, 255, 65, 0.18), 0 8px 24px rgba(0, 0, 0, 0.45)',
  '--oc-shadow-lg': '0 0 24px rgba(0, 255, 65, 0.18), 0 18px 50px rgba(0, 0, 0, 0.55)',
  '--oc-glow': '0 0 12px rgba(0, 255, 65, 0.35)',
  '--oc-radius': '2px',
  '--oc-font-sans': '"Share Tech Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--oc-font-display': '"Share Tech Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--oc-font-mono': '"Share Tech Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--oc-header-height': '60px',
  '--oc-bottom-nav-height': '64px',
  '--oc-theme-color': '#000000',
  '--oc-stripe': '#00ff41',
  '--oc-focus': '#00ff41',
  '--oc-heat-0': '#021207',
  '--oc-heat-1': '#063318',
  '--oc-heat-2': '#0b6b2e',
  '--oc-heat-3': '#12b84a',
  '--oc-heat-4': '#00ff41',
  '--oc-series-1': '#00ff41',
  '--oc-series-2': '#7dffb3',
  '--oc-series-3': '#d6ff4a',
  '--oc-series-4': '#5dffa8',
  '--oc-series-5': '#c8ff6a',
  '--oc-series-6': '#3ecf7a',
  '--oc-series-7': '#b6ff3c',
  '--oc-series-8': '#8dffc4',
};

class ThemeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ThemeError';
    this.status = status;
  }
}

function isSafeCssValue(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 400) return false;
  if (/url\s*\(|expression\s*\(|javascript\s*:|@import|<|>|[{};\\]|\/\*|\*\/|!important|<%|%>/i.test(v)) {
    return false;
  }
  return /^[#a-zA-Z0-9(),.%\s'"+/-]+$/.test(v);
}

function sanitizeExtraCss(css) {
  if (css == null || css === '') return '';
  if (typeof css !== 'string') throw new ThemeError('Extra CSS must be a string');
  if (css.length > MAX_CSS_CHARS) throw new ThemeError('Extra CSS is too large');
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (s.includes('/*') || s.includes('*/')) throw new ThemeError('Extra CSS has a broken comment');
  const banned = [
    /<|>/,
    /javascript\s*:/i,
    /expression\s*\(/i,
    /@import/i,
    /@charset/i,
    /@namespace/i,
    /@font-face/i,
    /behavior\s*:/i,
    /-moz-binding/i,
    /url\s*\(/i,
    /image-set\s*\(/i,
    /element\s*\(/i,
    /\\[0-9a-fA-F]/,
    /<%|%>/,
    /<\/?\s*style/i,
  ];
  for (const re of banned) {
    if (re.test(s)) throw new ThemeError('Extra CSS contains a disallowed pattern. CSS only, no imports, URLs, or scripts.');
  }
  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) throw new ThemeError('Extra CSS has unbalanced braces');
    }
  }
  if (depth !== 0) throw new ThemeError('Extra CSS has unbalanced braces');
  return s.trim();
}

function sanitizeFontFamily(value) {
  if (value == null || value === '') return '';
  if (!isSafeCssValue(value)) throw new ThemeError('Font family contains a disallowed character');
  return value.trim();
}

function sanitizeFontStylesheet(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new ThemeError('Font stylesheet must be a string');
  const v = value.trim();
  if (!FONT_URL_RE.test(v)) {
    throw new ThemeError('Font stylesheet must be an https://fonts.googleapis.com/css2 link');
  }
  return v;
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new ThemeError('Theme id must be 1 to 40 lowercase letters, numbers, or hyphens');
  }
  return id;
}

/**
 * Validate a pack object. Does not check builtin collisions.
 * Returns a normalized pack (no builtin flag; caller sets that).
 */
function validatePack(raw, { extraCss = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ThemeError('Theme pack must be a JSON object');
  }
  const id = assertId(raw.id);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 80) {
    throw new ThemeError('Theme name is required and must be 80 characters or fewer');
  }
  const description = raw.description == null ? '' : String(raw.description);
  if (description.length > 400) throw new ThemeError('Description is too long');
  if (/<|>|javascript\s*:/i.test(description) || /<|>/.test(raw.name)) {
    throw new ThemeError('Name and description must be plain text');
  }

  const tokensIn = raw.tokens;
  if (!tokensIn || typeof tokensIn !== 'object' || Array.isArray(tokensIn)) {
    throw new ThemeError('Theme tokens must be an object of CSS custom properties');
  }
  const tokens = {};
  for (const [key, value] of Object.entries(tokensIn)) {
    if (!TOKEN_RE.test(key)) throw new ThemeError('Token name is not allowed: ' + key);
    if (!isSafeCssValue(value)) throw new ThemeError('Token value is not allowed: ' + key);
    tokens[key] = String(value).trim();
  }
  for (const key of REQUIRED_TOKENS) {
    if (!tokens[key]) throw new ThemeError('Missing required token ' + key);
  }

  const fontsIn = raw.fonts && typeof raw.fonts === 'object' ? raw.fonts : {};
  const fonts = {
    sans: sanitizeFontFamily(fontsIn.sans || tokens['--oc-font-sans'] || ''),
    display: sanitizeFontFamily(fontsIn.display || tokens['--oc-font-display'] || ''),
    mono: sanitizeFontFamily(fontsIn.mono || tokens['--oc-font-mono'] || ''),
    stylesheet: sanitizeFontStylesheet(fontsIn.stylesheet || ''),
  };
  if (fonts.sans) tokens['--oc-font-sans'] = fonts.sans;
  if (fonts.display) tokens['--oc-font-display'] = fonts.display;
  if (fonts.mono) tokens['--oc-font-mono'] = fonts.mono;

  let effects = [];
  if (raw.effects != null) {
    if (!Array.isArray(raw.effects)) throw new ThemeError('effects must be an array');
    for (const effect of raw.effects) {
      if (!EFFECT_IDS.has(effect)) throw new ThemeError('Unknown effect: ' + String(effect).slice(0, 40));
      if (!effects.includes(effect)) effects.push(effect);
    }
  }

  const cssField = raw.css != null ? raw.css : raw.extraCss;
  const css = sanitizeExtraCss(extraCss || cssField || '');

  return {
    id,
    name: raw.name.trim(),
    description: description.trim(),
    tokens,
    fonts,
    effects,
    css,
  };
}

function renderCss(tokens, extraCss) {
  const body = Object.entries(tokens)
    .map(([key, value]) => key + ':' + value + ';')
    .join('');
  const legacy = [
    '--oc-primary-purple:var(--oc-accent)',
    '--oc-primary-hover:var(--oc-accent-hover)',
    '--oc-background-light:var(--oc-bg)',
    '--oc-background-dark:var(--oc-bg)',
    '--oc-text-dark:var(--oc-text)',
    '--oc-text-light:var(--oc-text-header)',
    '--oc-border-color:var(--oc-border)',
    '--oc-header-bg:var(--oc-bg-header)',
    '--oc-header-text:var(--oc-text-header)',
    '--oc-sidebar-bg:var(--oc-bg-sidebar)',
    '--oc-sidebar-bg-dark:var(--oc-bg-sidebar)',
    '--oc-card-bg:var(--oc-bg-card)',
    '--oc-card-bg-dark:var(--oc-bg-card)',
    '--oc-code-block-bg:var(--oc-bg-code)',
    '--oc-code-block-text:var(--oc-text)',
    '--surface-2:var(--oc-bg-card)',
    '--surface-3:var(--oc-bg-input)',
    '--bg-deep:var(--oc-bg)',
    '--border:var(--oc-border)',
  ].join(';');
  return ':root{' + body + legacy + '}' + (extraCss ? '\n' + extraCss : '');
}

function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_ZIP_BYTES) throw new ThemeError('Zip is too large');
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new ThemeError('Zip is missing a local file header');
  }
  const files = {};
  let offset = 0;
  let total = 0;
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    if (flags & 0x1) throw new ThemeError('Encrypted zip entries are not allowed');
    if (flags & 0x8) throw new ThemeError('Zip data descriptors are not supported. Zip the pack with sizes in the local header.');
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + nameLen).toString('utf8').replace(/\\/g, '/');
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > buffer.length) throw new ThemeError('Zip entry is truncated');
    let data = buffer.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      /* stored */
    } else if (method === 8) {
      try { data = zlib.inflateRawSync(data); }
      catch { throw new ThemeError('Zip entry could not be inflated'); }
    } else {
      throw new ThemeError('Unsupported zip compression');
    }
    if (uncompSize && data.length !== uncompSize && method === 0) {
      throw new ThemeError('Zip entry size does not match');
    }
    if (data.length > MAX_UNZIPPED_FILE) throw new ThemeError('Zip entry is too large');
    total += data.length;
    if (total > MAX_UNZIPPED_FILE * 2) throw new ThemeError('Zip uncompressed size is too large');
    if (name && !name.endsWith('/')) files[name] = data;
    offset = dataStart + compSize;
  }
  return files;
}

function pickZipEntries(files) {
  const allowed = new Map();
  for (const name of Object.keys(files)) {
    if (name.includes('..') || name.startsWith('/') || name.includes('\0')) {
      throw new ThemeError('Zip entry path is not allowed');
    }
    const base = path.posix.basename(name);
    if (base !== 'theme.json' && base !== 'extra.css') {
      throw new ThemeError('Zip may only contain theme.json and extra.css');
    }
    if (allowed.has(base)) throw new ThemeError('Zip has more than one ' + base);
    allowed.set(base, files[name]);
  }
  if (!allowed.has('theme.json')) throw new ThemeError('Zip is missing theme.json');
  return {
    jsonText: allowed.get('theme.json').toString('utf8'),
    extraCss: allowed.has('extra.css') ? allowed.get('extra.css').toString('utf8') : '',
  };
}

class ThemeStore {
  constructor({ builtinDir, userDir, settingsPath, brainStore = null } = {}) {
    if (!builtinDir) throw new Error('builtinDir is required');
    if (!userDir) throw new Error('userDir is required');
    if (!settingsPath) throw new Error('settingsPath is required');
    this.builtinDir = builtinDir;
    this.userDir = userDir;
    this.settingsPath = settingsPath;
    this.brainStore = brainStore;
  }

  _ensureUserDir() {
    fs.mkdirSync(this.userDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
  }

  _readJsonFile(file) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_JSON_BYTES) throw new ThemeError('Theme JSON is too large');
    const text = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(text); }
    catch { throw new ThemeError('Theme JSON is not valid'); }
  }

  _loadDir(dir, builtin) {
    const packs = [];
    if (!fs.existsSync(dir)) return packs;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return packs; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(dir, entry.name, 'theme.json');
      if (!fs.existsSync(manifest)) continue;
      try {
        const raw = this._readJsonFile(manifest);
        if (raw.id && raw.id !== entry.name) {
          throw new ThemeError('Pack id does not match its folder name');
        }
        raw.id = raw.id || entry.name;
        let extra = '';
        const extraFile = path.join(dir, entry.name, 'extra.css');
        if (fs.existsSync(extraFile)) extra = fs.readFileSync(extraFile, 'utf8');
        const pack = validatePack(raw, { extraCss: extra });
        pack.builtin = builtin;
        packs.push(pack);
      } catch (err) {
        console.warn('Theme pack skipped (' + entry.name + '): ' + (err.message || 'invalid'));
      }
    }
    return packs;
  }

  _matrixTokens() {
    try {
      const file = path.join(this.builtinDir, DEFAULT_THEME_ID, 'theme.json');
      const raw = this._readJsonFile(file);
      const pack = validatePack(raw);
      return pack.tokens;
    } catch {
      return { ...FALLBACK_TOKENS };
    }
  }

  _complete(pack) {
    const tokens = { ...this._matrixTokens(), ...pack.tokens };
    return { ...pack, tokens };
  }

  list() {
    const builtins = this._loadDir(this.builtinDir, true);
    const users = this._loadDir(this.userDir, false).filter(p => !builtins.some(b => b.id === p.id));
    const activeId = this._readActiveId();
    return [...builtins, ...users]
      .map(pack => this._public(this._complete(pack), activeId))
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }

  get(id) {
    assertId(id);
    const found = this.list().find(p => p.id === id);
    if (!found) throw new ThemeError('Theme not found', 404);
    return found;
  }

  getActive() {
    const wanted = this._readActiveId();
    const packs = this.list();
    const found = packs.find(p => p.id === wanted);
    if (found) return { ...found, fallback: false };
    const matrix = packs.find(p => p.id === DEFAULT_THEME_ID);
    if (matrix) return { ...matrix, fallback: wanted !== DEFAULT_THEME_ID };
    return this._public(this._complete({
      id: DEFAULT_THEME_ID,
      name: 'Matrix',
      description: 'Phosphor green on black.',
      tokens: { ...FALLBACK_TOKENS },
      fonts: { sans: FALLBACK_TOKENS['--oc-font-sans'], display: FALLBACK_TOKENS['--oc-font-display'], mono: FALLBACK_TOKENS['--oc-font-mono'], stylesheet: '' },
      effects: ['digital-rain'],
      css: '',
      builtin: true,
    }), DEFAULT_THEME_ID);
  }

  setActive(id) {
    assertId(id);
    this.get(id);
    this._writeActiveId(id);
    return this.getActive();
  }

  reset() {
    this._writeActiveId(DEFAULT_THEME_ID);
    return this.getActive();
  }

  importJson(raw, extraCss) {
    const pack = validatePack(raw, { extraCss });
    this._assertCanInstall(pack.id);
    this._writeUserPack(pack);
    return this.get(pack.id);
  }

  importZip(buffer) {
    const { jsonText, extraCss } = pickZipEntries(readZip(buffer));
    if (Buffer.byteLength(jsonText) > MAX_JSON_BYTES) throw new ThemeError('theme.json is too large');
    let raw;
    try { raw = JSON.parse(jsonText); }
    catch { throw new ThemeError('theme.json is not valid JSON'); }
    return this.importJson(raw, extraCss);
  }

  remove(id) {
    assertId(id);
    const pack = this.get(id);
    if (pack.builtin) throw new ThemeError('Built-in themes cannot be removed', 403);
    const dir = path.join(this.userDir, id);
    const resolved = path.resolve(dir);
    const root = path.resolve(this.userDir);
    if (!resolved.startsWith(root + path.sep)) throw new ThemeError('Theme path is not allowed');
    fs.rmSync(resolved, { recursive: true, force: true });
    if (this._readActiveId() === id) this._writeActiveId(DEFAULT_THEME_ID);
    return { removed: id, active: this.getActive() };
  }

  _assertCanInstall(id) {
    const builtinHit = this._loadDir(this.builtinDir, true).some(p => p.id === id);
    if (builtinHit) throw new ThemeError('A built-in theme already uses that id');
  }

  _writeUserPack(pack) {
    this._ensureUserDir();
    const dir = path.join(this.userDir, pack.id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      fonts: pack.fonts,
      effects: pack.effects,
      tokens: pack.tokens,
    };
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(manifest, null, 2));
    const extraPath = path.join(dir, 'extra.css');
    if (pack.css) fs.writeFileSync(extraPath, pack.css);
    else if (fs.existsSync(extraPath)) fs.unlinkSync(extraPath);
  }

  _readActiveId() {
    try {
      if (this.brainStore && typeof this.brainStore.getSetting === 'function') {
        const fromBrain = this.brainStore.getSetting(SETTINGS_KEY);
        if (fromBrain && ID_RE.test(fromBrain)) return fromBrain;
      }
    } catch { /* fall through to the JSON file */ }
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      if (raw && typeof raw.activeThemeId === 'string' && ID_RE.test(raw.activeThemeId)) {
        return raw.activeThemeId;
      }
    } catch { /* no saved preference */ }
    return DEFAULT_THEME_ID;
  }

  _writeActiveId(id) {
    this._ensureUserDir();
    const payload = JSON.stringify({ activeThemeId: id }, null, 2);
    const tmp = this.settingsPath + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.settingsPath);
    try {
      if (this.brainStore && typeof this.brainStore.setSetting === 'function') {
        this.brainStore.setSetting(SETTINGS_KEY, id);
      }
    } catch (err) {
      console.warn('Theme preference was saved to the settings file. Brain setting was skipped: ' + err.message);
    }
  }

  _public(pack, activeId) {
    const css = renderCss(pack.tokens, pack.css);
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      builtin: !!pack.builtin,
      active: pack.id === activeId,
      effects: pack.effects || [],
      fonts: {
        sans: pack.fonts.sans || '',
        display: pack.fonts.display || '',
        mono: pack.fonts.mono || '',
        stylesheet: pack.fonts.stylesheet || '',
      },
      themeColor: pack.tokens['--oc-theme-color'] || '#000000',
      tokens: pack.tokens,
      css,
    };
  }
}

module.exports = {
  ThemeStore,
  ThemeError,
  validatePack,
  sanitizeExtraCss,
  isSafeCssValue,
  renderCss,
  readZip,
  DEFAULT_THEME_ID,
  THEME_TOKEN_KEYS,
  REQUIRED_TOKENS,
  FALLBACK_TOKENS,
  SETTINGS_KEY,
};
