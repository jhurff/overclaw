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

function getAgentsList() {
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
  inferResolutionAgent,
  agentDisplayName,
};
