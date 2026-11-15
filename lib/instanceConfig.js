'use strict';

const fs = require('fs');
const path = require('path');

const INSTANCE_PATH = path.join(__dirname, '..', 'config', 'instance.json');

function readInstanceConfig() {
  try {
    return JSON.parse(fs.readFileSync(INSTANCE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function operatorName() {
  const name = (readInstanceConfig().operatorName || '').trim();
  return name || 'Operator';
}

function operatorNames() {
  const inst = readInstanceConfig();
  const names = [];
  if (Array.isArray(inst.operatorNames)) {
    for (const n of inst.operatorNames) {
      if (n && !names.includes(n)) names.push(String(n));
    }
  }
  const primary = operatorName();
  if (primary && !names.includes(primary)) names.unshift(primary);
  if (!names.includes('Operator')) names.push('Operator');
  return names;
}

function getAgentMap() {
  const map = readInstanceConfig().agentMap;
  return map && typeof map === 'object' ? map : {};
}

function getStaticAgentsList() {
  const inst = readInstanceConfig();
  if (Array.isArray(inst.agentsList) && inst.agentsList.length) return inst.agentsList;
  const seen = new Set();
  const list = [];
  for (const v of Object.values(getAgentMap())) {
    if (v && v.key && !seen.has(v.key)) {
      seen.add(v.key);
      list.push(v);
    }
  }
  return list;
}

// Live roster from the Brain's Agent Registry ("Swarm directory" table).
// Set by index.js; when present it is the source of truth for who is assignable.
let registryRoster = null;

const INACTIVE_STATUS = /decommission|retired|inactive|removed|archived/i;

function cleanNickname(raw) {
  let s = String(raw || '').trim();
  const wl = s.match(/\[\[#?([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (wl) s = (wl[2] || wl[1]).trim();
  s = s.replace(/\*\*/g, '').replace(/[`_]/g, '').trim();
  return s;
}

/**
 * Turn Agent Registry rows into agentsList entries. Rows whose status reads
 * decommissioned/retired/inactive are left out. Flags such as canWake carry
 * over from config/instance.json when the key matches.
 */
function buildRosterFromRegistry(rows, staticList) {
  const byKey = new Map();
  for (const a of staticList || []) {
    if (a && a.key) byKey.set(String(a.key).toLowerCase(), a);
  }
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    const name = cleanNickname(r.nickname || r.agent || r.name || '');
    if (!name || /^<.*>$/.test(name)) continue;
    const status = String(r.status || '');
    if (INACTIVE_STATUS.test(status)) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const title = String(r.official_title || r.role || r.title || '').trim();
    const platform = String(r.platform || r.type || '').trim();
    const extra = [title, platform].filter(Boolean).join(' / ');
    const prev = byKey.get(key) || {};
    out.push(Object.assign({}, prev, {
      key,
      label: extra ? name + ' \u2014 ' + extra : name,
      canWake: !!prev.canWake,
      platform,
      status,
      source: 'registry',
    }));
  }
  return out;
}

function setRegistryRoster(rows) {
  const built = buildRosterFromRegistry(rows, getStaticAgentsList());
  registryRoster = built.length ? built : null;
  return registryRoster;
}

function getAgentsList() {
  return registryRoster || getStaticAgentsList();
}

const ROSTER_PALETTE = ['#22c55e', '#3b82f6', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#ef4444', '#06b6d4', '#84cc16', '#f43f5e', '#8b5cf6'];

/** Static agentColors plus a stable generated color for any agent without one. */
function getAgentColors() {
  const inst = readInstanceConfig();
  const colors = Object.assign({}, inst.agentColors || {});
  for (const a of getAgentsList()) {
    const key = String(a.key || '').toLowerCase();
    if (!key || colors[key]) continue;
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    colors[key] = ROSTER_PALETTE[h % ROSTER_PALETTE.length];
  }
  return colors;
}

function inferResolutionAgent(relPath, fm) {
  const map = getAgentMap();
  const inst = readInstanceConfig();
  const defaultKey = inst.defaultAgentMapKey || Object.keys(map)[0];
  if (relPath) {
    const parts = String(relPath).split(/[/\\]/);
    if (parts.length >= 2) {
      const combo = parts[0] + '/' + parts[1];
      if (map[combo]) return map[combo];
    }
    if (parts[0] && map[parts[0]]) return map[parts[0]];
  }
  const fa = ((fm && (fm.for_agent || fm.agent)) || '').toLowerCase();
  if (fa) {
    for (const [key, info] of Object.entries(map)) {
      const pats = (info && info.inferPatterns) || [info && info.key, key];
      if (pats.filter(Boolean).some(p => fa.includes(String(p).toLowerCase()))) {
        return info;
      }
    }
  }
  return (defaultKey && map[defaultKey]) || Object.values(map)[0] || {
    key: 'agent',
    label: 'Agent',
    canWake: false,
  };
}

function agentDisplayName(key) {
  if (!key) return 'Agent';
  const inst = readInstanceConfig();
  const table = inst.agentDisplay || {};
  if (table[key]) return table[key];
  const lower = String(key).toLowerCase();
  if (table[lower]) return table[lower];
  for (const info of Object.values(getAgentMap())) {
    if (info && String(info.key).toLowerCase() === lower) {
      return (info.label || info.key).split('—')[0].split('-')[0].trim() || info.key;
    }
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

module.exports = {
  INSTANCE_PATH,
  readInstanceConfig,
  operatorName,
  operatorNames,
  getAgentMap,
  getAgentsList,
  getStaticAgentsList,
  buildRosterFromRegistry,
  setRegistryRoster,
  getAgentColors,
  inferResolutionAgent,
  agentDisplayName,
};
