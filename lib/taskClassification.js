'use strict';

/**
 * Standing vs project task classification.
 *
 * Explicit `type` frontmatter wins. Otherwise a task is inferred as standing
 * from brain signals (cadence fields, a heartbeat tie, a regular progress-note
 * pattern, or an operational title). Project is the default.
 *
 * Inferred standing_status is never "scheduled" — that value is explicit only.
 * Active means a progress note or matching heartbeat landed inside ~2× cadence
 * (48h when cadence is unknown; 72h for weekdays so a Friday run still covers Monday).
 */

const NAMED_CADENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
const TASK_TYPES = ['project', 'standing'];
const STANDING_STATUSES = ['scheduled', 'active', 'inactive'];
const WORKFLOW_SECTIONS = ['inbox', 'inProgress', 'parked', 'blocked', 'done'];

const TITLE_RE = /\b(daily|weekly|monthly)\b[\s\S]{0,80}\b(check|watch|scan|sweep|monitor)\b|\b(check|watch|scan|sweep|monitor)\b[\s\S]{0,80}\b(daily|weekly|monthly)\b/i;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseFrontmatter(content) {
  if (!content || !String(content).startsWith('---')) return {};
  const end = String(content).indexOf('\n---', 3);
  if (end === -1) return {};
  const block = String(content).slice(4, end);
  const meta = {};
  for (const line of block.split('\n')) {
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) meta[key] = val;
  }
  return meta;
}

function splitDocument(content) {
  const text = content || '';
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text };
  return { meta: parseFrontmatter(text), body: text.slice(end + 4) };
}

function normalizeType(value) {
  const s = String(value || '').trim().toLowerCase();
  return TASK_TYPES.includes(s) ? s : null;
}

function normalizeStandingStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  return STANDING_STATUSES.includes(s) ? s : null;
}

function isCron(value) {
  const parts = String(value || '').trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  return parts.every(p => /^[\d*/,\-]+$/.test(p) || /^[A-Za-z]{3}(-[A-Za-z]{3})?$/.test(p) || /^\d+-\d+$/.test(p) || p === '?');
}

function normalizeCadence(value) {
  if (value == null) return null;
  const c = String(value).trim();
  if (!c) return null;
  const lower = c.toLowerCase();
  if (NAMED_CADENCES.includes(lower)) return lower;
  return c;
}

function assertCadence(value) {
  if (value == null || String(value).trim() === '') return null;
  const c = String(value).trim();
  if (/[\r\n]/.test(c) || c.length > 80) {
    throw new Error('cadence must be daily, weekdays, weekly, monthly, or a cron expression');
  }
  const lower = c.toLowerCase();
  if (NAMED_CADENCES.includes(lower)) return lower;
  if (isCron(c)) return c;
  throw new Error('cadence must be daily, weekdays, weekly, monthly, or a cron expression');
}

function assertTaskFields({ type, standing_status, cadence } = {}) {
  if (type != null && String(type).trim() !== '' && !normalizeType(type)) {
    throw new Error('type must be "standing" or "project"');
  }
  if (standing_status != null && String(standing_status).trim() !== '' && !normalizeStandingStatus(standing_status)) {
    throw new Error('standing_status must be "scheduled", "active", or "inactive"');
  }
  if (cadence != null && String(cadence).trim() !== '') assertCadence(cadence);
}

function hasCadenceField(fm) {
  return ['cadence', 'schedule', 'cron'].some(k => fm && String(fm[k] || '').trim());
}

function cadenceFromFields(fm) {
  if (!fm) return null;
  for (const key of ['cadence', 'schedule', 'cron']) {
    const n = normalizeCadence(fm[key]);
    if (n) return n;
  }
  return null;
}

function cadenceFromTitle(title) {
  const m = String(title || '').toLowerCase().match(/\b(daily|weekdays|weekly|monthly)\b/);
  return m ? m[1] : null;
}

/** Rough period for a cadence string. Null when it cannot be estimated. */
function cadencePeriodMs(cadence) {
  const c = String(cadence || '').trim().toLowerCase();
  if (c === 'daily' || c === 'weekdays') return 24 * 60 * 60 * 1000;
  if (c === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (c === 'monthly') return 30 * 24 * 60 * 60 * 1000;
  if (!isCron(cadence)) return null;
  const parts = String(cadence).trim().split(/\s+/);
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  const [min, hour, dom, mon, dow] = fields;
  if ((dom === '*' || dom === '?') && (mon === '*' || mon === '?') && (dow === '*' || dow === '?')) {
    if (hour === '*' && (min === '*' || min === '0')) return 60 * 1000;
    if (hour === '*') return 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
  }
  if (dow && dow !== '*' && dow !== '?' && (dom === '*' || dom === '?')) return 7 * 24 * 60 * 60 * 1000;
  if (dom && dom !== '*' && dom !== '?' && (mon === '*' || mon === '?')) return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** How long after the last run a standing task stays Active. */
function activeWindowMs(cadence) {
  const c = String(cadence || '').trim().toLowerCase();
  if (c === 'weekdays') return 72 * 60 * 60 * 1000;
  const period = cadencePeriodMs(cadence);
  if (!period) return 48 * 60 * 60 * 1000;
  return period * 2;
}

function isoDateFromPretty(line) {
  const m = String(line).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!day || !year) return null;
  const dt = new Date(Date.UTC(year, month, day));
  if (dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Dates that look like progress-note entries, not incidental dates in prose.
 * Returns sorted unique YYYY-MM-DD strings.
 */
function extractProgressDates(body) {
  const dates = new Set();
  for (const line of String(body || '').split('\n')) {
    const heading = /^#{1,6}\s+/.test(line);
    const progress = /progress note/i.test(line);
    const datedLabel = /^\s*(?:[-*]\s+)?(?:\*\*)?date(?:\*\*)?\s*:/i.test(line);
    const bulletDate = /^\s*[-*]\s+\d{4}-\d{2}-\d{2}\b/.test(line);
    if (!heading && !progress && !datedLabel && !bulletDate) continue;
    const isos = line.match(/\d{4}-\d{2}-\d{2}/g) || [];
    for (const d of isos) dates.add(d);
    const pretty = isoDateFromPretty(line);
    if (pretty) dates.add(pretty);
  }
  return [...dates].sort();
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Named cadence when 3+ distinct progress-note days form a regular gap. */
function inferCadenceFromDates(dates) {
  if (!dates || dates.length < 3) return null;
  const ms = dates.map(d => Date.parse(d + 'T00:00:00Z')).filter(n => !Number.isNaN(n));
  if (ms.length < 3) return null;
  ms.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ms.length; i++) gaps.push((ms[i] - ms[i - 1]) / 86400000);
  if (!gaps.length) return null;
  const med = median(gaps);
  const regular = gaps.every(g => Math.abs(g - med) <= Math.max(1.25, med * 0.45));
  if (!regular) return null;
  if (gaps.every(g => g >= 0.5 && g <= 3.5) && gaps.some(g => g >= 2.5) && gaps.some(g => g <= 1.5)) {
    return 'weekdays';
  }
  if (med >= 0.5 && med <= 2) return 'daily';
  if (med > 2 && med <= 4 && gaps.every(g => g <= 3.5)) return 'weekdays';
  if (med >= 5 && med <= 10) return 'weekly';
  if (med >= 25 && med <= 35) return 'monthly';
  return null;
}

function normJob(value) {
  return String(value || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tiedHeartbeats(taskId, fm, heartbeats) {
  const id = String(taskId || '').toUpperCase();
  const jobs = [fm && fm.heartbeat_job, fm && fm.job].map(normJob).filter(Boolean);
  const hits = [];
  for (const hb of heartbeats || []) {
    const hbJob = normJob(hb.job || '');
    const hbType = normJob(hb.type || '');
    const file = normJob((hb.filename || '').replace(/\.md$/i, ''));
    const idHit = id && (hb.taskIds || []).some(t => String(t).toUpperCase() === id);
    const jobHit = jobs.some(j => j && (j === hbJob || j === hbType || (file && file.includes(j))));
    if (idHit || jobHit) hits.push(hb);
  }
  return hits;
}

function parseWhen(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T12:00:00Z');
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function latestRun(progressDates, heartbeatDates) {
  const candidates = [];
  for (const d of progressDates || []) {
    const ms = parseWhen(d);
    if (ms != null) candidates.push({ raw: d, ms });
  }
  for (const d of heartbeatDates || []) {
    const ms = parseWhen(d);
    if (ms != null) candidates.push({ raw: d, ms });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.ms - a.ms);
  return candidates[0].raw;
}

/**
 * @param {object} input
 * @param {string} [input.taskId]
 * @param {string} [input.title]
 * @param {object} [input.frontmatter]
 * @param {string} [input.body]
 * @param {object[]} [input.heartbeats]  { date, job, type, filename, taskIds }
 * @param {string|number|Date} [input.now]
 */
function classifyTask(input = {}) {
  const fm = input.frontmatter || {};
  const title = input.title || fm.title || '';
  const body = input.body || '';
  const progressDates = extractProgressDates(body);
  const noteCadence = inferCadenceFromDates(progressDates);
  const hits = tiedHeartbeats(input.taskId, fm, input.heartbeats);
  const heartbeatTied = hits.length > 0 || !!String(fm.heartbeat_job || '').trim();
  const titleHit = TITLE_RE.test(String(title));

  const explicitType = normalizeType(fm.type);
  let type;
  let typeSource;
  if (explicitType) {
    type = explicitType;
    typeSource = 'explicit';
  } else if (hasCadenceField(fm)) {
    type = 'standing';
    typeSource = 'inferred:cadence';
  } else if (heartbeatTied) {
    type = 'standing';
    typeSource = 'inferred:heartbeat';
  } else if (noteCadence) {
    type = 'standing';
    typeSource = 'inferred:progress-notes';
  } else if (titleHit) {
    type = 'standing';
    typeSource = 'inferred:title';
  } else {
    type = 'project';
    typeSource = 'default';
  }

  const result = {
    type,
    typeSource,
    standingStatus: null,
    cadence: null,
    heartbeatJob: null,
    lastRun: null,
  };

  if (type !== 'standing') return result;

  const cadence = cadenceFromFields(fm) || noteCadence || cadenceFromTitle(title) || null;
  const heartbeatJob = String(fm.heartbeat_job || '').trim()
    || (hits.find(h => h.job) || {}).job
    || null;
  const lastRun = latestRun(progressDates, hits.map(h => h.date).filter(Boolean));
  const explicitStatus = normalizeStandingStatus(fm.standing_status);

  let standingStatus;
  if (explicitStatus) {
    standingStatus = explicitStatus;
  } else {
    const lastMs = parseWhen(lastRun);
    const nowMs = input.now != null ? new Date(input.now).getTime() : Date.now();
    standingStatus = (lastMs != null && (nowMs - lastMs) <= activeWindowMs(cadence))
      ? 'active'
      : 'inactive';
  }

  result.standingStatus = standingStatus;
  result.cadence = cadence;
  result.heartbeatJob = heartbeatJob;
  result.lastRun = lastRun;
  return result;
}

function formatFmValue(val) {
  const s = String(val);
  if (!s || /[:#\[\]{},&*!|>'"@`%]/.test(s) || /\s/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

/** Insert or replace frontmatter keys. Values that are null/undefined are skipped. */
function upsertFrontmatter(content, updates) {
  const keys = Object.keys(updates || {}).filter(k => updates[k] != null && String(updates[k]) !== '');
  let text = content || '';
  let fmLines = [];
  let body = text;
  let had = false;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      had = true;
      fmLines = text.slice(3, end).replace(/^\n/, '').replace(/\n$/, '').split('\n').filter(l => l.length);
      body = text.slice(end + 4);
    }
  }
  for (const key of keys) {
    const line = key + ': ' + formatFmValue(updates[key]);
    const idx = fmLines.findIndex(l => new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:').test(l));
    if (idx >= 0) {
      let end2 = idx + 1;
      while (end2 < fmLines.length && /^\s/.test(fmLines[end2])) end2++;
      fmLines.splice(idx, end2 - idx, line);
    } else {
      fmLines.push(line);
    }
  }
  const fmBlock = '---\n' + fmLines.join('\n') + '\n---';
  if (!body.length) return fmBlock + '\n';
  if (!body.startsWith('\n')) body = '\n' + body;
  return fmBlock + body;
}

/**
 * Pull standing tasks out of workflow columns.
 * `classify(task)` returns the classifyTask() shape. May also set shortName on the task.
 */
function applyTaskTypes(board, classify) {
  const standing = { scheduled: [], active: [], inactive: [] };
  for (const key of WORKFLOW_SECTIONS) {
    if (!Array.isArray(board[key])) board[key] = [];
    board[key] = board[key].filter(task => {
      const info = classify(task) || {};
      task.type = info.type || 'project';
      task.typeSource = info.typeSource || 'default';
      task.standingStatus = info.standingStatus || null;
      task.cadence = info.cadence || null;
      task.heartbeatJob = info.heartbeatJob || null;
      task.heartbeat_job = info.heartbeatJob || null;
      task.lastRun = info.lastRun || null;
      if (task.type !== 'standing') return true;
      const bucket = STANDING_STATUSES.includes(info.standingStatus) ? info.standingStatus : 'inactive';
      task.standingStatus = bucket;
      task.standing_status = bucket;
      task.boardSection = key;
      task.workflowStatus = key;
      task.status = 'standing';
      standing[bucket].push(task);
      return false;
    });
  }
  for (const task of [...standing.scheduled, ...standing.active, ...standing.inactive]) {
    task.standing_status = task.standingStatus;
  }
  for (const key of WORKFLOW_SECTIONS) {
    for (const task of board[key]) {
      task.standing_status = null;
    }
  }
  board.standing = standing;
  const standingTotal = standing.scheduled.length + standing.active.length + standing.inactive.length;
  board.stats = {
    total: board.inbox.length + board.inProgress.length + board.parked.length
      + board.blocked.length + board.done.length + standingTotal,
    inbox: board.inbox.length,
    inProgress: board.inProgress.length,
    parked: board.parked.length,
    blocked: board.blocked.length,
    done: board.done.length,
    standing: standingTotal,
    standingScheduled: standing.scheduled.length,
    standingActive: standing.active.length,
    standingInactive: standing.inactive.length,
  };
  return board;
}

/**
 * Filename metadata for heartbeat markdown.
 * relDir is the path under Heartbeats/, using / or \ separators.
 */
function parseHeartbeatFilename(filename, relDir) {
  let name = String(filename || '').replace(/\.md$/i, '');
  let isAlert = false;
  let isHandled = false;
  if (/^NEEDS-ATTENTION[-_]/i.test(name)) {
    isAlert = true;
    name = name.replace(/^NEEDS-ATTENTION[-_]/i, '');
  } else if (/^HANDLED[-_]/i.test(name)) {
    isHandled = true;
    name = name.replace(/^HANDLED[-_]/i, '');
  }
  let date = null;
  let type = name;
  const dtMatch = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})[-_]?(.*)$/);
  if (dtMatch) {
    date = dtMatch[1] + 'T' + dtMatch[2] + ':' + dtMatch[3];
    type = dtMatch[4] || 'heartbeat';
  } else {
    const dMatch = name.match(/^(\d{4}-\d{2}-\d{2})[-_]?(.*)$/);
    if (dMatch) {
      date = dMatch[1];
      type = dMatch[2] || 'heartbeat';
    }
  }
  const parts = String(relDir || '').split(/[/\\]/).filter(Boolean);
  return {
    machine: parts[0] || 'unknown',
    subAgent: parts.length > 1 ? parts.slice(1).join('/') : null,
    date,
    type: String(type || 'heartbeat').replace(/[-_]/g, ' ').trim() || 'heartbeat',
    isAlert,
    isHandled,
  };
}

function taskDocRel(task) {
  const id = task && task.taskId;
  if (task && task.link) {
    let link = String(task.link).replace(/\\/g, '/').replace(/^\.\//, '');
    if (link.startsWith('03 - Agents/')) return link;
    link = link.replace(/^Coordination\//, '');
    return '03 - Agents/Coordination/' + link;
  }
  if (id) return '03 - Agents/Coordination/Tasks/' + id + '.md';
  return null;
}

function fieldsFromClassification(info) {
  const standing = info && info.type === 'standing';
  return {
    type: (info && info.type) || 'project',
    typeSource: (info && info.typeSource) || 'default',
    standingStatus: standing ? info.standingStatus : null,
    standing_status: standing ? info.standingStatus : null,
    cadence: standing ? info.cadence : null,
    heartbeatJob: standing ? info.heartbeatJob : null,
    heartbeat_job: standing ? info.heartbeatJob : null,
    lastRun: standing ? info.lastRun : null,
  };
}

module.exports = {
  NAMED_CADENCES,
  TASK_TYPES,
  STANDING_STATUSES,
  WORKFLOW_SECTIONS,
  parseFrontmatter,
  splitDocument,
  normalizeType,
  normalizeStandingStatus,
  assertCadence,
  assertTaskFields,
  extractProgressDates,
  inferCadenceFromDates,
  classifyTask,
  upsertFrontmatter,
  applyTaskTypes,
  parseHeartbeatFilename,
  taskDocRel,
  fieldsFromClassification,
  activeWindowMs,
};
