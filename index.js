const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs').promises; // For async file operations
const ClawBridge = require('./lib/ClawBridge'); // Import ClawBridge
const VaultReader = require('./lib/VaultReader'); // Vault integration

const app = express();

// Load OverClaw instance config at startup (sync — file is small and gitignored)
let ocConfig = {};
try {
  ocConfig = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config', 'overclaw.json'), 'utf-8'));
} catch {}

const port = parseInt(process.env.PORT || ocConfig.port || '8355', 10); // Default 8355

// OverClaw's own state (learnings, etc.) lives here, not in ~/.openclaw
const OVERCLAW_DATA_DIR = path.join(__dirname, 'data');

// Initialize ClawBridge with environment variables
const openclawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL || ocConfig.openclawGatewayUrl || 'ws://127.0.0.1:18789';
const openclawApiToken = process.env.OPENCLAW_API_TOKEN;

if (!openclawApiToken) {
  console.warn('OPENCLAW_API_TOKEN is not set. ClawBridge will not be able to authenticate with OpenClaw Gateway.');
}

let clawBridge = null;
try {
  if (openclawGatewayUrl && openclawApiToken) {
    clawBridge = new ClawBridge(openclawGatewayUrl, openclawApiToken);
  } else {
    console.warn('ClawBridge disabled: OPENCLAW_GATEWAY_URL or OPENCLAW_API_TOKEN not set.');
  }
} catch (err) {
  console.warn(`ClawBridge init failed: ${err.message} — gateway routes will return degraded responses`);
}

// ---------------------------------------------------------------------------
// VaultReader — reads swarm coordination data from the Obsidian vault
// ---------------------------------------------------------------------------
const VAULT_PATH = process.env.VAULT_PATH
  || (ocConfig.brainPath && ocConfig.brainPath.replace(/^~/, process.env.HOME))
  || path.join(process.env.HOME, 'My-AI-Brain');
let vaultReader;
try {
  vaultReader = new VaultReader(VAULT_PATH);
  console.log(`VaultReader initialized for: ${VAULT_PATH}`);
} catch (err) {
  console.warn(`VaultReader init failed: ${err.message} — vault routes will return degraded responses`);
  vaultReader = null;
}

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper function to extract agent ID from session key (duplicate for server-side use)
function getAgentIdFromSessionKey(sessionKey) {
    const parts = sessionKey.split(':');
    if (parts.length > 1 && parts[0] === 'agent') {
        return parts[1];
    }
    return null;
}

// ---------------------------------------------------------------------------
// Stuck task detection helpers
// ---------------------------------------------------------------------------
const STUCK_DAYS_DEFAULT = parseInt(ocConfig.stuckDaysThreshold || '5', 10);

/** Parse a date string that may include trailing time / timezone text. */
function parseTaskDate(str) {
  if (!str || str === '\u2014' || str === '-') return null;
  let d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  const m = str.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) { d = new Date(m[1]); if (!isNaN(d.getTime())) return d; }
  return null;
}

/**
 * Mutates a task object with isStuck / isOverdue / isStale / staleDays / stuckReason.
 * Call on any in-progress task before returning it to the client.
 */
function flagStuckTask(task, now = Date.now(), stuckDays = STUCK_DAYS_DEFAULT) {
  // 1. Past deadline?
  if (task.deadline && task.deadline !== '\u2014') {
    const dl = parseTaskDate(task.deadline);
    if (dl && dl.getTime() < now) {
      const d = Math.floor((now - dl.getTime()) / 86400000);
      task.isStuck     = true;
      task.isOverdue   = true;
      task.overdueDays = d;
      task.stuckReason = `Overdue by ${d}d (deadline was ${task.deadline})`;
      return;
    }
  }
  // 2. Stale (started too long ago)?
  if (task.created && task.created !== '\u2014') {
    const started = parseTaskDate(task.created);
    if (started) {
      const days = (now - started.getTime()) / 86400000;
      if (days > stuckDays) {
        task.isStuck    = true;
        task.isStale    = true;
        task.staleDays  = Math.floor(days);
        task.stuckReason = `No activity for ${Math.floor(days)}d (in progress since ${task.created})`;
      }
    }
  }
}

/**
 * Parse Task Board.md and move one in-progress row to the blocked section.
 * Returns updated file content (does NOT write or commit).
 */
function moveTaskToBlocked(content, taskId, reason) {
  const today = new Date().toISOString().slice(0, 10);
  const lines  = content.split('\n');
  let sec = null, taskRowIdx = -1, taskRowCells = null, blockedSepIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (hm) { sec = hm[1].toLowerCase(); continue; }

    // In-progress section — find the task row by ID
    if (sec && sec.includes('progress') && t.startsWith('|')) {
      if (t.includes(taskId) && !/^\|[\s\-:]+\|/.test(t)) {
        taskRowIdx   = i;
        taskRowCells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      }
    }
    // Blocked section — track separator row position so we can insert after it
    if (sec && sec.includes('blocked') && /^\|[\s\-:]+\|/.test(t)) {
      blockedSepIdx = i;
    }
  }

  if (taskRowIdx === -1) throw new Error(`Task ${taskId} not found in In Progress section`);

  // Build the blocked row
  // In Progress columns: TaskId | Title | Agent | Started  | Deadline
  // Blocked columns:     TaskId | Title | Agent | Blocked Since | Reason
  const idCell    = taskRowCells[0] || taskId;
  const titleCell = taskRowCells[1] || '';
  const agentCell = taskRowCells[2] || '';
  const blockedRow = `| ${idCell} | ${titleCell} | ${agentCell} | ${today} | ${reason} |`;

  // Remove from in-progress
  const newLines = lines.filter((_, i) => i !== taskRowIdx);

  // Adjust blocked separator index after the removal
  const adjSepIdx = blockedSepIdx > taskRowIdx ? blockedSepIdx - 1 : blockedSepIdx;

  if (adjSepIdx >= 0) {
    // Insert immediately after the blocked table's separator row
    newLines.splice(adjSepIdx + 1, 0, blockedRow);
  } else {
    // Blocked table has no separator (empty / absent) — bootstrap it
    let hdrIdx = -1, s2 = null;
    for (let i = 0; i < newLines.length; i++) {
      const hm = newLines[i].trim().match(/^##\s+(.*)/);
      if (hm) s2 = hm[1].toLowerCase();
      if (s2 && s2.includes('blocked') && hdrIdx === -1) hdrIdx = i;
    }
    const tableLines = [
      '',
      '| Task ID | Title | Agent | Blocked Since | Reason |',
      '|---------|-------|-------|---------------|--------|',
      blockedRow,
    ];
    if (hdrIdx >= 0) {
      newLines.splice(hdrIdx + 1, 0, ...tableLines);
    } else {
      newLines.push('', '## \ud83d\udea7 Blocked', ...tableLines);
    }
  }

  return newLines.join('\n');
}


// ---------------------------------------------------------------------------
// Task Board — assignment helpers
// ---------------------------------------------------------------------------

/** Move an Inbox row → In Progress. newAgent = vault shortname (lowercase). */
function moveTaskToInProgress(content, taskId, newAgent) {
  const today  = new Date().toISOString().slice(0, 10);
  const lines  = content.split('\n');
  let sec = null, rowIdx = -1, rowCells = null, ipSepIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (hm) { sec = hm[1].toLowerCase(); continue; }
    if (sec && sec.includes('inbox') && t.startsWith('|') && t.includes(taskId) && !/^\|[\s\-:]+\|/.test(t)) {
      rowIdx   = i;
      rowCells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    }
    if (sec && sec.includes('progress') && /^\|[\s\-:]+\|/.test(t)) ipSepIdx = i;
  }
  if (rowIdx === -1) throw new Error(`Task ${taskId} not found in Inbox section`);
  // Inbox: TaskId | Title | AssignedTo | Priority | Deadline | Created
  const ipRow = `| ${rowCells[0]||taskId} | ${rowCells[1]||''} | ${newAgent} | ${today} | ${rowCells[4]||'\u2014'} |`;
  const nl    = lines.filter((_, i) => i !== rowIdx);
  const adj   = ipSepIdx > rowIdx ? ipSepIdx - 1 : ipSepIdx;
  if (adj >= 0) {
    nl.splice(adj + 1, 0, ipRow);
  } else {
    let hi = -1, s2 = null;
    for (let i = 0; i < nl.length; i++) {
      const hm = nl[i].trim().match(/^##\s+(.*)/);
      if (hm) s2 = hm[1].toLowerCase();
      if (s2 && s2.includes('progress') && hi === -1) hi = i;
    }
    const tbl = ['', '| Task ID | Title | Agent | Started | Deadline |', '|---------|-------|-------|---------|----------|', ipRow];
    if (hi >= 0) nl.splice(hi + 1, 0, ...tbl); else nl.push('', '## \ud83d\udd04 In Progress', ...tbl);
  }
  return nl.join('\n');
}

/** Update Agent cell on a Blocked row (keep status/reason). */
function updateBlockedTaskAgent(content, taskId, newAgent) {
  const lines = content.split('\n');
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (hm) { sec = hm[1].toLowerCase(); continue; }
    if (sec && sec.includes('blocked') && t.startsWith('|') && t.includes(taskId) && !/^\|[\s\-:]+\|/.test(t)) {
      const cells = lines[i].replace(/^\|/, '').replace(/\|$/, '').split('|');
      if (cells.length >= 3) cells[2] = ` ${newAgent} `;
      lines[i] = '|' + cells.join('|') + '|';
      return lines.join('\n');
    }
  }
  throw new Error(`Task ${taskId} not found in Blocked section`);
}

/** Move an In-Progress or Blocked row back to Inbox (unassign). */
function moveTaskToInbox(content, taskId, fromSection) {
  const today   = new Date().toISOString().slice(0, 10);
  const lines   = content.split('\n');
  let sec = null, rowIdx = -1, rowCells = null, inboxSepIdx = -1;
  const fromKey = fromSection === 'inProgress' ? 'progress' : 'blocked';

  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (hm) { sec = hm[1].toLowerCase(); continue; }
    if (sec && sec.includes(fromKey) && t.startsWith('|') &&
        t.includes(taskId) && !/^\|[\s\-:]+\|/.test(t)) {
      rowIdx   = i;
      rowCells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    }
    if (sec && sec.includes('inbox') && /^\|[\s\-:]+\|/.test(t)) inboxSepIdx = i;
  }

  if (rowIdx === -1) throw new Error(`Task ${taskId} not found in ${fromSection} section`);

  // InProgress cols: TaskId | Title | Agent | Started  | Deadline
  // Blocked cols:    TaskId | Title | Agent | Blocked Since | Reason
  // Inbox cols:      TaskId | Title | Assigned To | Priority | Deadline | Created
  const idCell    = rowCells[0] || taskId;
  const titleCell = rowCells[1] || '';
  const deadline  = fromSection === 'inProgress' ? (rowCells[4] || '\u2014') : '\u2014';
  const inboxRow  = `| ${idCell} | ${titleCell} | \u2014 | \u2014 | ${deadline} | ${today} |`;

  const newLines  = lines.filter((_, i) => i !== rowIdx);
  const adjSepIdx = inboxSepIdx > rowIdx ? inboxSepIdx - 1 : inboxSepIdx;

  if (adjSepIdx >= 0) {
    newLines.splice(adjSepIdx + 1, 0, inboxRow);
  } else {
    let hdrIdx = -1, s2 = null;
    for (let i = 0; i < newLines.length; i++) {
      const hm = newLines[i].trim().match(/^##\s+(.*)/);
      if (hm) s2 = hm[1].toLowerCase();
      if (s2 && s2.includes('inbox') && hdrIdx === -1) hdrIdx = i;
    }
    const tbl = ['', '| Task ID | Title | Assigned To | Priority | Deadline | Created |',
      '|---------|-------|-------------|----------|----------|---------|', inboxRow];
    if (hdrIdx >= 0) newLines.splice(hdrIdx + 1, 0, ...tbl);
    else newLines.push('', '## \ud83d\udce5 Inbox', ...tbl);
  }

  return newLines.join('\n');
}

/** Reusable vault-sync push. */
async function vaultSync(message) {
  const { execFile } = require('child_process');
  const bin = require('path').join(process.env.HOME, '.local', 'bin', 'vault-sync');
  return new Promise(resolve =>
    execFile(bin, ['push', message], { timeout: 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr })
    )
  );
}

/** Write a Tier-2 notification .md for any agent. */
async function writeNotificationFile(agentKey, taskId, title, fromSection) {
  const cap = { spike:'Spike', steve:'Steve', lex:'Lex', bill:'Bill', jimmy:'Jimmy' };
  const agentName = cap[agentKey.toLowerCase()] || agentKey;
  const now   = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
  const dir   = require('path').join(VAULT_PATH, '03 - Agents', 'Notifications', agentName);
  await require('fs').promises.mkdir(dir, { recursive: true });
  const body = [
    '---',
    'type: task-assigned',
    `taskId: ${taskId}`,
    `assignedAt: ${now.toISOString()}`,
    `fromSection: ${fromSection}`,
    '---', '',
    `# Task Assignment: ${taskId}`, '',
    `You have been assigned **${taskId}** from the Task Board.`, '',
    `**Title:** ${title}`,
    `**From:** ${fromSection === 'inbox' ? 'Inbox \u2192 In Progress' : 'Blocked (agent reassigned)'}`,
    `**Assigned at:** ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`, '',
    'Check the Task Board for full details.', '',
  ].join('\n');
  await require('fs').promises.writeFile(require('path').join(dir, stamp + '-task-assigned.md'), body, 'utf-8');
  return { agentName };
}

// Root route - Dashboard
app.get('/', (req, res) => res.redirect(301, '/swarm'));

// Agents screen route — swarm personas from vault registry
app.get('/agents', (req, res) => {
  res.render('agents', { title: 'Swarm Agents', currentPath: '/agents' });
});

// Config Viewer screen route
app.get('/config', async (req, res) => {
  let cfg = {};
  try {
    const raw = await fs.readFile(path.join(__dirname, 'config', 'overclaw.json'), 'utf-8');
    cfg = JSON.parse(raw);
  } catch {}
  const ocCfg = {
    brainPath:            cfg.brainPath            || '~/My-AI-Brain',
    port:                 cfg.port                 || 8355,
    scanFrequencySeconds: cfg.scanFrequencySeconds || 300,
    openclawGatewayUrl:   cfg.openclawGatewayUrl   || 'ws://127.0.0.1:18789',
    vaultAutoPullOnLoad:  cfg.vaultAutoPullOnLoad  !== false,
  };
  res.render('config', { title: 'OverClaw Settings', currentPath: '/config', ocConfig: ocCfg });
});

// Sessions Viewer screen route
app.get('/sessions', (req, res) => {
  res.render('sessions', { title: 'OverClaw Sessions Viewer' });
});

// Scheduled Tasks — swarm-wide cron/loops view
app.get('/scheduled-tasks', (req, res) => {
  res.render('scheduled-tasks', { title: 'Scheduled Tasks', currentPath: '/scheduled-tasks' });
});
// Legacy redirect
app.get('/cron-jobs', (req, res) => res.redirect(301, '/scheduled-tasks'));

// Tools & Models — swarm-wide capability/model view
app.get('/tools', (req, res) => {
  res.render('tools', { title: 'Tools & Models', currentPath: '/tools' });
});
// Legacy redirect
app.get('/skills', (req, res) => res.redirect(301, '/tools'));

// Nodes — physical machines in the swarm
app.get('/nodes', (req, res) => {
  res.render('nodes', { title: 'Swarm Nodes', currentPath: '/nodes' });
});

// Logs screen route
app.get('/logs', (req, res) => {
  res.render('logs', { title: 'OverClaw Logs' });
});

// Debug screen route
app.get('/debug', (req, res) => {
  res.render('debug', { title: 'OverClaw Debug' });
});

// Docs screen route
app.get('/docs', (req, res) => {
  res.render('docs', { title: 'OverClaw Documentation' });
});

// Activity & Audit Log screen route
app.get('/activity', (req, res) => {
  res.render('activity', { title: 'OverClaw Activity & Audit Log', currentPath: '/activity' });
});

// ---------------------------------------------------------------------------
// Swarm routes — vault-powered
// ---------------------------------------------------------------------------

// Swarm overview page
app.get('/swarm', (req, res) => {
  res.render('swarm', { title: 'Swarm Overview', currentPath: '/swarm' });
});

// Task board page
app.get('/task-board', (req, res) => {
  res.render('task-board', { title: 'Task Board', currentPath: '/task-board' });
});

// Vault document viewer page
app.get('/vault/doc', (req, res) => {
  const filePath = (req.query.path || '').replace(/\.\./g, ''); // basic sanitize
  res.render('vault-doc', { title: 'Vault Doc', filePath, currentPath: '/vault/doc' });
});

// Vault markdown editor page
app.get('/vault/edit', (req, res) => {
  const filePath = (req.query.path || '').replace(/\.\./g, '');
  if (!filePath) return res.redirect('/vault/doc');
  const fname = filePath.split('/').pop();
  res.render('vault-edit', { title: 'Edit: ' + fname, filePath, currentPath: '/vault/edit' });
});

// Vault graph explorer page
app.get('/vault/graph', (req, res) => {
  res.render('vault-graph', { title: 'Vault Graph', currentPath: '/vault/graph' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Needs-Attention Resolver
// ─────────────────────────────────────────────────────────────────────────────

/** Map heartbeat machine directory → agent routing info. */
const RESOLVE_AGENT_MAP = {
  'OpenClaw':              { key: 'spike', label: 'Spike — OpenClaw / H2FClanker2',         canWake: true  },
  'H2FClanker2':           { key: 'spike', label: 'Spike — OpenClaw / H2FClanker2',         canWake: true  },
  'BrightMove-MBP':        { key: 'steve', label: 'Steve — Claude Cowork / BrightMove MBP', canWake: false },
  'BrightMove-MBP/Cursor': { key: 'lex',   label: 'Lex — Cursor / BrightMove MBP',          canWake: false },
  'H2FClanker1':           { key: 'bill',  label: 'Bill — ChatGPT / H2FClanker1',            canWake: false },
};

/** All agents as an ordered list for the picker. */
const RESOLVE_AGENTS_LIST = [
  { key: 'spike', label: 'Spike — OpenClaw / H2FClanker2',         canWake: true  },
  { key: 'steve', label: 'Steve — Claude Cowork / BrightMove MBP', canWake: false },
  { key: 'bill',  label: 'Bill — ChatGPT / H2FClanker1',            canWake: false },
  { key: 'lex',   label: 'Lex — Cursor / BrightMove MBP',          canWake: false },
];

/**
 * Parse plain YAML-style frontmatter from raw markdown content.
 * Returns {} when no frontmatter block found.
 */
function parseFrontmatterText(content) {
  if (!content || !content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = content.slice(3, end).trim();
  const result = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    result[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return result;
}

/** Infer which agent should receive the resolution dispatch. */
function inferResolutionAgent(relPath, fm) {
  if (relPath) {
    const parts = relPath.split(/[/\\]/);
    // Try machine/subAgent combo first (e.g. BrightMove-MBP/Cursor)
    if (parts.length >= 2) {
      const combo = parts[0] + '/' + parts[1];
      if (RESOLVE_AGENT_MAP[combo]) return RESOLVE_AGENT_MAP[combo];
    }
    if (RESOLVE_AGENT_MAP[parts[0]]) return RESOLVE_AGENT_MAP[parts[0]];
  }
  // Fallback: frontmatter for_agent / agent field
  const fa = ((fm && (fm.for_agent || fm.agent)) || '').toLowerCase();
  if (/spike|openclaw/.test(fa)) return RESOLVE_AGENT_MAP['OpenClaw'];
  if (/steve/.test(fa))          return RESOLVE_AGENT_MAP['BrightMove-MBP'];
  if (/lex|cursor/.test(fa))     return RESOLVE_AGENT_MAP['BrightMove-MBP/Cursor'];
  if (/bill/.test(fa))           return RESOLVE_AGENT_MAP['H2FClanker1'];
  return RESOLVE_AGENT_MAP['OpenClaw'];
}

/** Build the full context object the resolver form needs. */
async function buildResolveContext(alertRelPath) {
  const filePath = '08 - QA-and-Monitoring/Heartbeats/' + alertRelPath;
  const content  = await vaultReader.getFile(filePath);
  const fm       = parseFrontmatterText(content);
  const filename = path.basename(alertRelPath, '.md');
  const agent    = inferResolutionAgent(alertRelPath, fm);

  // Strip frontmatter to get markdown body
  let body = content;
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) body = content.slice(end + 4).trimStart();
  }

  return {
    alertId:           filename,
    filePath,
    relPath:           alertRelPath,
    job:               fm.job              || '',
    writtenBy:         fm.written_by        || '',
    forAgent:          fm.for_agent         || fm.agent || '',
    issue:             fm.issue             || '',
    actionRequested:   fm.action_requested  || '',
    severity:          fm.severity          || '',
    status:            fm.status            || '',
    deliveryStatus:    fm.delivery_status   || '',
    writtenAt:         fm.written_at         || '',
    resolutionStatus:  fm.resolution_status  || null,
    body,
    agent,
    allAgents: RESOLVE_AGENTS_LIST,
  };
}

// GET /resolve — Resolver form page
app.get('/resolve', (req, res) => {
  const alertPath = (req.query.alert || '').replace(/\.\./g, '');
  if (!alertPath) return res.redirect('/swarm');
  res.render('resolve', { title: 'Resolve Alert', alertPath, currentPath: '/resolve' });
});

// GET /api/resolve/context — JSON context for resolver form
app.get('/api/resolve/context', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const alertPath = (req.query.alert || '').replace(/\.\./g, '');
  if (!alertPath) return res.status(400).json({ error: 'alert path required' });
  try {
    const ctx = await buildResolveContext(alertPath);
    res.json(ctx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/resolve — submit resolution instructions and dispatch to agent
app.post('/api/resolve', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const { alertPath, agentKey, agentLabel, instructions } = req.body || {};
  if (!alertPath || !instructions) {
    return res.status(400).json({ error: 'alertPath and instructions are required' });
  }
  try {
    const filePath = '08 - QA-and-Monitoring/Heartbeats/' + alertPath;
    const vaultAbs = path.resolve(vaultReader.vaultPath);
    const abs      = path.resolve(vaultAbs, filePath);
    if (!abs.startsWith(vaultAbs + path.sep)) {
      return res.status(403).json({ error: 'Path traversal denied' });
    }

    // 1. Read + parse current alert file
    const content  = await vaultReader.getFile(filePath);
    const fm       = parseFrontmatterText(content);

    // Split frontmatter from body
    let fmLines = [];
    let body    = content;
    if (content.startsWith('---')) {
      const end = content.indexOf('\n---', 3);
      if (end !== -1) {
        fmLines = content.slice(3, end).trim().split('\n');
        body    = content.slice(end + 4).trimStart();
      }
    }

    const now    = new Date();
    const nowISO = now.toISOString();
    const nowET  = now.toLocaleString('en-US', { timeZone: 'America/New_York',
                                                  dateStyle: 'medium', timeStyle: 'short' });
    const effectiveAgentKey   = agentKey   || 'spike';
    const effectiveAgentLabel = agentLabel || effectiveAgentKey;

    // 2. Update frontmatter — add/overwrite resolution fields
    const fmKeep = fmLines.filter(l =>
      !l.startsWith('resolution_status:') &&
      !l.startsWith('resolution_dispatched_at:') &&
      !l.startsWith('resolution_agent:')
    );
    fmKeep.push(`resolution_status: dispatched`);
    fmKeep.push(`resolution_dispatched_at: ${nowISO}`);
    fmKeep.push(`resolution_agent: ${effectiveAgentKey}`);
    const newFm = '---\n' + fmKeep.join('\n') + '\n---';

    // 3. Append resolution history section to body
    const quotedInstructions = instructions.split('\n').map(l => `> ${l}`).join('\n');
    const histEntry = [
      '',
      `### Dispatched — ${nowET}`,
      `**Routed to:** ${effectiveAgentLabel}  `,
      `**Instructions from Jimmy:**`,
      '',
      quotedInstructions,
      '',
    ].join('\n');

    let newBody;
    if (body.includes('## 🔧 Resolution History')) {
      // Append new dispatch entry inside the existing section
      newBody = body.trimEnd() + '\n' + histEntry;
    } else {
      newBody = body.trimEnd() + '\n\n---\n\n## 🔧 Resolution History\n' + histEntry;
    }

    // 4. Write updated alert file
    const newContent = newFm + '\n\n' + newBody;
    await fs.writeFile(abs, newContent, 'utf-8');

    // 5. Write notification file to agent
    const agentName  = effectiveAgentKey.charAt(0).toUpperCase() + effectiveAgentKey.slice(1);
    const alertId    = path.basename(alertPath, '.md');
    const notifDir   = path.join(VAULT_PATH, '03 - Agents', 'Notifications', agentName);
    await fs.mkdir(notifDir, { recursive: true });
    const stamp      = now.toISOString().slice(0, 16).replace('T', '-').replace(/:(\d{2})$/, '-$1');
    const notifLines = [
      '---',
      'type: alert-resolution',
      `alertId: ${alertId}`,
      `alertPath: ${filePath}`,
      `dispatchedAt: ${nowISO}`,
      `dispatchedBy: Jimmy`,
      `agentKey: ${effectiveAgentKey}`,
      '---', '',
      `# Alert Resolution Request`, '',
      `Jimmy has reviewed the following alert and provided resolution instructions.`, '',
      `**Alert ID:** \`${alertId}\`  `,
      `**Alert file:** \`${filePath}\`  `,
      `**Dispatched:** ${nowET}`, '',
      '## Jimmy\'s Instructions', '',
      instructions, '',
      '## Steps to Complete', '',
      `1. Read the full alert at \`${filePath}\``,
      '2. Execute Jimmy\'s instructions above',
      '3. When fully resolved, rename the alert file: `NEEDS-ATTENTION-*` → `HANDLED-*`',
      '4. Write a brief resolution note in the file before renaming (optional but encouraged)',
      '',
    ];
    await fs.writeFile(
      path.join(notifDir, stamp + '-alert-resolution.md'),
      notifLines.join('\n'),
      'utf-8'
    );

    // 6. Vault sync (commit + push everything)
    const synced = await vaultSync(
      `resolve: dispatch ${alertId.slice(0, 80)} → ${effectiveAgentKey}`
    );

    // 7. Wake Spike if she's the target (same gateway)
    let wakeResult = null;
    if (effectiveAgentKey === 'spike' && clawBridge) {
      try {
        wakeResult = await clawBridge.wakeAgent(
          `🔧 Alert resolution dispatched by Jimmy.\n\nAlert: ${alertId}\n\nInstructions:\n${instructions.slice(0, 400)}\n\nPlease read your notification file at ${notifDir} and act on it now.`,
          'agent:main'
        );
      } catch (e) {
        wakeResult = { error: e.message };
      }
    }

    res.json({
      ok: true,
      synced: synced.ok,
      syncWarning: synced.ok ? null : synced.stderr,
      woke: !!(wakeResult && !wakeResult.error),
      alertId,
      agentKey: effectiveAgentKey,
    });
  } catch (err) {
    console.error(`[resolve] POST error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Helper: return a degraded response when the vault is unavailable
function vaultUnavailable(res, details) {
  return res.status(503).json({ error: 'Vault not available', details: details || 'VaultReader not initialized' });
}

// Helper: return a degraded response when ClawBridge is unavailable
function gatewayUnavailable(res) {
  return res.status(503).json({ error: 'OpenClaw gateway not available', details: 'Set OPENCLAW_GATEWAY_URL and OPENCLAW_API_TOKEN to enable gateway features.' });
}

// GET /api/vault/status
app.get('/api/vault/status', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const status = await vaultReader.isAvailable();
    res.json({ ...status, lastSyncAt: vaultReader.lastSyncAt, syncInProgress: vaultReader.syncInProgress });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check vault status', details: err.message });
  }
});

// POST /api/vault/sync — manual git pull
app.post('/api/vault/sync', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const result = await vaultReader.sync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

// GET /api/vault/task-board
app.get('/api/vault/task-board', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);
    const data = await vaultReader.getTaskBoard();
    // Annotate in-progress tasks with stuck flags before sending to client
    const now = Date.now();
    (data.inProgress || []).forEach(t => flagStuckTask(t, now));
    if (data.stats) data.stats.stuck = (data.inProgress || []).filter(t => t.isStuck).length;
    res.json(data);
  } catch (err) {
    console.error(`Error reading task board: ${err.message}`);
    res.status(500).json({ error: 'Failed to read task board', details: err.message });
  }
});

// GET /api/vault/agents
app.get('/api/vault/agents', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);
    const agents = await vaultReader.getAgentRegistry();
    res.json(agents);
  } catch (err) {
    console.error(`Error reading agent registry: ${err.message}`);
    res.status(500).json({ error: 'Failed to read agent registry', details: err.message });
  }
});

// API: read a vault file
app.get('/api/vault/file', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const filePath = (req.query.path || '').trim();
  try {
    const vaultAbs = path.resolve(vaultReader.vaultPath);
    const abs = filePath ? path.resolve(vaultAbs, filePath) : vaultAbs;
    // Security check
    if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
      return res.status(403).json({ error: 'Path traversal denied' });
    }
    let stat;
    try { stat = await fs.stat(abs); } catch { return res.status(404).json({ error: 'Not found' }); }
    if (stat.isDirectory()) {
      const listing = await vaultReader.listDir(filePath);
      return res.json(listing);
    }
    // File — must be .md
    const content = await vaultReader.getFile(filePath);
    res.json({ type: 'file', content, path: filePath });
  } catch (err) {
    const status = err.message.includes('denied') ? 403 : err.message.includes('Only') ? 400 : 404;
    res.status(status).json({ error: err.message });
  }
});

// API: vault graph data
app.get('/api/vault/graph', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const graph = await vaultReader.buildGraph();
    res.json(graph);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build graph', details: err.message });
  }
});


// POST /api/vault/file — write a vault .md file and vault-sync push
app.post('/api/vault/file', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const { path: filePath, content, commitMessage } = req.body || {};
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
  if (content === undefined || content === null)  return res.status(400).json({ error: 'content required' });
  try {
    const vaultAbs = path.resolve(vaultReader.vaultPath);
    const abs      = path.resolve(vaultAbs, filePath);
    if (!abs.startsWith(vaultAbs + path.sep)) return res.status(403).json({ error: 'Path traversal denied' });
    if (!abs.endsWith('.md')) return res.status(400).json({ error: 'Only .md files can be written' });
    await fs.writeFile(abs, content, 'utf-8');
    const synced = await vaultSync((commitMessage || 'vault: edit ' + path.basename(filePath)).slice(0, 200));
    if (!synced.ok)
      return res.status(207).json({ ok: true, synced: false, path: filePath,
        warning: 'Saved locally but vault-sync failed', details: synced.stderr });
    res.json({ ok: true, synced: true, path: filePath, savedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: 'Write failed', details: err.message }); }
});

// API: resolve wiki link name to vault path
app.get('/api/vault/resolve', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const name = (req.query.name || '').toLowerCase().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const graph = await vaultReader.buildGraph();
    // Find node whose name matches (case-insensitive)
    const node = graph.nodes.find(n => n.name.toLowerCase() === name);
    if (!node) return res.status(404).json({ error: 'Not found', name });
    res.json({ path: node.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vault/activity
app.get('/api/vault/activity', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);
    const limitParam = parseInt(req.query.limit || '100', 10);
    const heartbeats = await vaultReader.getHeartbeats({ limit: limitParam });
    res.json(heartbeats);
  } catch (err) {
    console.error(`Error reading vault activity: ${err.message}`);
    res.status(500).json({ error: 'Failed to read vault activity', details: err.message });
  }
});

// GET /api/swarm/summary — combined swarm snapshot
app.get('/api/swarm/summary', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);

    // Fetch in parallel
    const [taskBoard, agents, heartbeats, heatmap, alerts] = await Promise.all([
      vaultReader.getTaskBoard().catch(e => ({ error: e.message })),
      vaultReader.getAgentRegistry().catch(e => []),
      vaultReader.getHeartbeats({ limit: 200 }).catch(e => []),
      vaultReader.getActivityHeatmap().catch(e => ({ days: [], agents: [] })),
      vaultReader.getAlerts().catch(e => []),
    ]);

    // Build last-heartbeat-per-machine map
    const lastHeartbeat = {};
    for (const hb of heartbeats) {
      const key = hb.subAgent ? `${hb.machine}/${hb.subAgent}` : hb.machine;
      if (!lastHeartbeat[key]) lastHeartbeat[key] = hb;
    }

    // Fallback for agents that write work logs but not heartbeat files.
    // Lex (Cursor) writes session logs to 03 - Agents/Cursor/ but never
    // writes to the Heartbeats directory (Cursor has no background scheduler).
    // Use the most recent dated .md file in that dir as a proxy for last-seen.
    const LEX_KEY = 'BrightMove-MBP/Cursor';
    if (!lastHeartbeat[LEX_KEY] || !lastHeartbeat[LEX_KEY].date) {
      const lexDate = await vaultReader.getLatestEntryDate('03 - Agents/Cursor').catch(() => null);
      if (lexDate) {
        lastHeartbeat[LEX_KEY] = {
          machine: 'BrightMove-MBP', subAgent: 'Cursor',
          date: lexDate, isAlert: false, isHandled: false,
          filename: 'work-log-fallback', type: 'work-log',
        };
      }
    }

    // Flag stuck in-progress tasks and surface count in stats
    const nowMs = Date.now();
    (taskBoard.inProgress || []).forEach(t => flagStuckTask(t, nowMs));
    const stuckCount = (taskBoard.inProgress || []).filter(t => t.isStuck).length;
    if (taskBoard.stats) taskBoard.stats.stuck = stuckCount;

    res.json({
      vaultPath: VAULT_PATH,
      taskBoardStats: taskBoard.stats || {},
      taskBoard: {
        inbox:      (taskBoard.inbox      || []).slice(0, 8),
        inProgress: (taskBoard.inProgress || []).slice(0, 8),
        blocked:    (taskBoard.blocked    || []).slice(0, 8),
        done:       (taskBoard.done       || []).slice(0, 5),
      },
      agents,
      lastHeartbeat,
      alerts,
      heatmap,
    });
  } catch (err) {
    console.error(`Error building swarm summary: ${err.message}`);
    res.status(500).json({ error: 'Failed to build swarm summary', details: err.message });
  }
});

// Normalize gateway response: may be array or { agents: [...] } / { list: [...] }
function normalizeAgentsList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.agents)) return raw.agents;
  if (raw && Array.isArray(raw.list)) return raw.list;
  return [];
}

// API endpoint to list OpenClaw agents (summary for dashboard card)
app.get('/api/agents', async (req, res) => {
  if (!clawBridge) return gatewayUnavailable(res);
  try {
    const raw = await clawBridge.getAgents();
    const agents = normalizeAgentsList(raw);
    res.json(agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace,
      agentDir: agent.agentDir
    })));
  } catch (error) {
    console.error(`Error fetching agents via ClawBridge: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch agents', details: error.message });
  }
});

// API endpoint to get detailed OpenClaw sessions
app.get('/api/sessions-detail', async (req, res) => {
  if (!clawBridge) return gatewayUnavailable(res);
  try {
    const sessions = await clawBridge.getSessions();
    res.json(sessions);
  } catch (error) {
    console.error(`Error fetching sessions via ClawBridge: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch session details', details: error.message });
  }
});

// API endpoint to list OpenClaw cron jobs
app.get('/api/cron-jobs', async (req, res) => {
  if (!clawBridge) return gatewayUnavailable(res);
  try {
    const cronData = await clawBridge.getCronJobs();
    res.json(cronData);
  } catch (error) {
    console.error(`Error fetching cron jobs via ClawBridge: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch cron jobs', details: error.message });
  }
});

// Instance-specific node config — reads from gitignored config/instance.json
// Source code stays generic; each deployment maintains its own instance.json
app.get('/api/instance-nodes', async (req, res) => {
  const configPath = path.join(__dirname, 'config', 'instance.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    res.json(cfg.nodes || []);
  } catch {
    res.json([]);
  }
});

// Read current OverClaw app config (from gitignored config/overclaw.json)
app.get('/api/overclaw-config', async (req, res) => {
  try {
    const raw = await fs.readFile(path.join(__dirname, 'config', 'overclaw.json'), 'utf-8');
    res.json(JSON.parse(raw));
  } catch { res.json({}); }
});

// Save OverClaw app config
app.post('/api/overclaw-config', async (req, res) => {
  const cfgPath = path.join(__dirname, 'config', 'overclaw.json');
  try {
    let current = {};
    try { current = JSON.parse(await fs.readFile(cfgPath, 'utf-8')); } catch {}
    const updated = Object.assign(current, req.body);
    await fs.writeFile(cfgPath, JSON.stringify(updated, null, 2));
    const requiresRestart = req.body.brainPath !== undefined
      || req.body.port !== undefined
      || req.body.openclawGatewayUrl !== undefined;
    res.json({ ok: true, requiresRestart });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// API endpoint for OCUs to fetch learning entries
app.get('/api/learnings', async (req, res) => {
  const learningsDbPath = path.join(OVERCLAW_DATA_DIR, 'learnings_db.json');
  try {
    const data = await fs.readFile(learningsDbPath, 'utf8');
    const learnings = JSON.parse(data);
    res.json(Array.isArray(learnings) ? learnings : []);
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await fs.mkdir(OVERCLAW_DATA_DIR, { recursive: true });
        await fs.writeFile(learningsDbPath, '[]', 'utf8');
      } catch (e) {
        console.warn(`Could not create learnings_db.json at ${learningsDbPath}: ${e.message}`);
      }
      return res.json([]);
    }
    console.error(`Error fetching learnings from ${learningsDbPath}: ${error}`);
    res.status(500).json({ error: 'Failed to fetch learnings', details: error.message });
  }
});

// Whitelisted Git repositories for history viewing
const WHITELISTED_GIT_REPOS = [
  path.join(process.env.HOME, 'projects', 'overclaw'),
  path.join(process.env.HOME, 'weedstock_project'),
];

// Security function to validate file paths
const ALLOWED_CONFIG_FILES_MAIN_WORKSPACE = [
    'SOUL.md',
    'USER.md',
    'AGENTS.md',
    'TOOLS.md',
    'MEMORY.md', 
    'DELIVERABLES.md', 
];

const ALLOWED_DATA_MEMORY_FILES = [
    'projects_log.md',
];

const ALLOWED_SUBAGENT_CORE_CONFIG_FILES = [
  'SOUL.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
];

// Regex for OpenClaw usage reports (e.g., openclaw_usage_report_YYYY-MM-DD.md)
const OPENCLAW_USAGE_REPORT_PATTERN = /^openclaw_usage_report_\d{4}-\d{2}-\d{2}\.md$/;

async function isValidAgentConfigFile(agentId, requestedFilePath, agentDetails) {
    const WORKSPACE_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'workspace');
    const DATA_MEMORY_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'data', 'memory');

    // Normalize requested path for security checks
    const normalizedPath = path.normalize(requestedFilePath);

    // 1. Prevent directory traversal (e.g., ../../)
    if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
        console.warn(`Security alert: Path traversal attempt detected: ${requestedFilePath}`);
        return false;
    }

    // 2. Check for main agent's workspace files
    if (agentId === 'main') {
        if (ALLOWED_CONFIG_FILES_MAIN_WORKSPACE.includes(normalizedPath)) {
            return true; 
        }
        // Daily memory files in main agent's workspace memory (e.g., memory/YYYY-MM-DD.md)
        if (normalizedPath.startsWith('memory/') && normalizedPath.match(/^memory\/\d{4}-\d{2}-\d{2}\.md$/)) {
            return true; 
        }
        // Other specific memory files in the shared data/memory folder (e.g., projects_log.md)
        if (ALLOWED_DATA_MEMORY_FILES.includes(normalizedPath)) {
            return true;
        }
        // OpenClaw usage reports in ~/.openclaw/data/memory/
        if (normalizedPath.match(OPENCLAW_USAGE_REPORT_PATTERN)) {
          return true;
        }
    }

    // 3. Check for specific subagent files
    if (agentDetails && agentDetails.agentDir) {
      // Core config files for subagents (e.g., SOUL.md in their agentDir)
      if (ALLOWED_SUBAGENT_CORE_CONFIG_FILES.includes(normalizedPath)) {
          // Construct the full path to verify it's within the agent's own agentDir
          const expectedFullPath = path.join(agentDetails.agentDir, normalizedPath);
          // Check if this file actually exists at the expected path
          try {
            await fs.access(expectedFullPath); 
            return true;
          } catch (e) {
            console.warn(`Security alert: Subagent config file ${expectedFullPath} not found or accessible.`);
            return false;
          }
      }
    }
    
    // 4. Check for specific subagent memory files in ~/.openclaw/data/memory/AGENT_ID/...
    if (normalizedPath.startsWith(`memory/${agentId}/`)) {
        const relativeToAgentMemoryDir = normalizedPath.substring(`memory/${agentId}/`.length);

        // Subagent's MEMORY.md (e.g., memory/sheeba-m/MEMORY.md)
        if (relativeToAgentMemoryDir === 'MEMORY.md') {
            return true;
        }
        // Subagent's daily memory files (e.g., memory/sheeba-m/YYYY-MM-DD.md)
        if (relativeToAgentMemoryDir.match(/^\d{4}-\d{2}-\d{2}\.md$/)) {
            return true;
        }
    }

    // Add checks for other specific files that are NOT in git but are safe to read, e.g. openclaw.json
    if (agentId === 'main' && normalizedPath === 'openclaw.json') {
      return true;
    }

    console.warn(`Security alert: Unauthorized file access for agent ${agentId}, path: ${requestedFilePath}`);
    return false;
}

// Function to get the full absolute path based on agentId and relative filePath
function getFullPath(agentId, filePath, agentDetails) {
    const WORKSPACE_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'workspace');
    const DATA_MEMORY_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'data', 'memory');

    let fullPath;
    if (agentId === 'main') {
        if (filePath === 'openclaw.json') {
            fullPath = path.join(process.env.HOME, '.openclaw', filePath);
        } else if (filePath.startsWith('memory/')) {
            if (ALLOWED_DATA_MEMORY_FILES.includes(filePath) || filePath.match(OPENCLAW_USAGE_REPORT_PATTERN)) {
              fullPath = path.join(DATA_MEMORY_BASE_PATH, filePath);
            } else {
              fullPath = path.join(WORKSPACE_BASE_PATH, filePath);
            }
        } else {
            fullPath = path.join(WORKSPACE_BASE_PATH, filePath);
        }
    } else { // For subagents
        // Core config files in agent's own agentDir
        if (agentDetails && agentDetails.agentDir && ALLOWED_SUBAGENT_CORE_CONFIG_FILES.includes(filePath)) {
            fullPath = path.join(agentDetails.agentDir, filePath);
        }
        // Memory files in ~/.openclaw/data/memory/AGENT_ID/
        else if (filePath.startsWith(`memory/${agentId}/`)) {
            fullPath = path.join(DATA_MEMORY_BASE_PATH, agentId, filePath.substring(`memory/${agentId}/`.length));
        }
    }
    return fullPath;
}

// Function to find if a given file path belongs to a whitelisted Git repo
async function getGitRepoPathForFile(fullFilePath) {
  for (const repoPath of WHITELISTED_GIT_REPOS) {
    if (fullFilePath.startsWith(repoPath)) {
      try {
        await fs.access(path.join(repoPath, '.git'));
        return repoPath;
      } catch (e) {
        // Not a valid git repo or .git not accessible, continue
      }
    }
  }
  return null;
}

// API endpoint to list discoverable config files for an agent
app.get('/api/agent-config-files/:agentId', async (req, res) => {
  const { agentId } = req.params;
  const agentInfoResponse = await fetch(`http://localhost:${port}/api/agents`); 
  const agents = await agentInfoResponse.json();
  const agent = agents.find(a => a.id === agentId);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const discoverableFiles = [];
  
  if (agentId === 'main') {
      ALLOWED_CONFIG_FILES_MAIN_WORKSPACE.forEach(file => {
          discoverableFiles.push({
              name: file,
              path: file,
              type: 'config',
              agentId: agent.id,
              isVersionControlled: false
          });
      });
      discoverableFiles.push({
          name: 'openclaw.json',
          path: 'openclaw.json',
          type: 'config',
          agentId: agent.id,
          isVersionControlled: false 
      });

      discoverableFiles.push({
        name: 'Model Settings',
        path: '__model_settings__',
        type: 'setting',
        agentId: agent.id,
        isVersionControlled: false
      });

      discoverableFiles.push({
        name: 'projects_log.md',
        path: 'projects_log.md',
        type: 'project',
        agentId: agent.id,
        isVersionControlled: false
      });
  } else {
      ALLOWED_SUBAGENT_CORE_CONFIG_FILES.forEach(file => {
          discoverableFiles.push({
              name: file,
              path: file,
              type: 'config',
              agentId: agent.id,
              isVersionControlled: false
          });
      });
  }

  // Dynamically find daily memory files for main agent in workspace memory
  if (agentId === 'main') {
    const mainWorkspaceMemoryPath = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory');
    try {
        const files = await fs.readdir(mainWorkspaceMemoryPath);
        for (const file of files) {
            if (file.match(/^\d{4}-\d{2}-\d{2}\.md$/) || ALLOWED_CONFIG_FILES_MAIN_WORKSPACE.includes(`memory/${file}`)) {
                discoverableFiles.push({
                    name: file,
                    path: `memory/${file}`,
                    type: 'memory',
                    agentId: agent.id,
                    isVersionControlled: false
                });
            }
        }
    } catch (e) {
        // Expected if dir doesn't exist
    }
  }

  // Dynamically find OpenClaw usage reports for main agent in data/memory
  if (agentId === 'main') {
    const mainDataMemoryPath = path.join(process.env.HOME, '.openclaw', 'data', 'memory');
    try {
        const files = await fs.readdir(mainDataMemoryPath);
        for (const file of files) {
            if (file.match(OPENCLAW_USAGE_REPORT_PATTERN)) {
                discoverableFiles.push({
                    name: file,
                    path: file,
                    type: 'report',
                    agentId: agent.id,
                    isVersionControlled: false
                });
            }
        }
    } catch (e) {
        // Expected if dir doesn't exist
    }
  }
  
  // Dynamically find memory files for specific subagents
  const subagentDataMemoryPath = path.join(process.env.HOME, '.openclaw', 'data', 'memory', agentId);
  try {
      const files = await fs.readdir(subagentDataMemoryPath);
      for (const file of files) {
          if (file === 'MEMORY.md' || file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) {
              discoverableFiles.push({
                  name: file,
                  path: `memory/${agentId}/${file}`,
                  type: 'memory',
                  agentId: agent.id,
                  isVersionControlled: false
              });
          }
      }
  } catch (e) {
      // Expected for many agents
  }

  // Now, dynamically determine if a discovered file is version controlled
  for (const file of discoverableFiles) {
      if (file.type !== 'setting') {
        const fullFilePath = getFullPath(agentId, file.path, agent);
        if (fullFilePath) {
            const repoPath = await getGitRepoPathForFile(fullFilePath);
            file.isVersionControlled = !!repoPath;
        }
      }
  }

  res.json(discoverableFiles);
});

// API endpoint to get content of a specific file
app.get('/api/file-content', async (req, res) => {
  const { agentId, filePath } = req.query;

  if (!agentId || !filePath) {
    return res.status(400).json({ error: 'Missing agentId or filePath' });
  }

  const agentInfoResponse = await fetch(`http://localhost:${port}/api/agents`); 
  const agents = await agentInfoResponse.json();
  const agent = agents.find(a => a.id === agentId);

  if (!await isValidAgentConfigFile(agentId, filePath, agent)) {
    return res.status(403).json({ error: 'Unauthorized file access attempt' });
  }

  const fullPath = getFullPath(agentId, filePath, agent);
  if (!fullPath) {
      return res.status(500).json({ error: 'Could not determine full path for file.' });
  }

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch (error) {
    console.error(`Error reading file ${fullPath}: ${error}`);
    res.status(500).json({ error: 'Failed to read file', details: error.message });
  }
});

// API endpoint to get Git history for a specific file
app.get('/api/file-history', async (req, res) => {
  const { agentId, filePath } = req.query;

  if (!agentId || !filePath) {
    return res.status(400).json({ error: 'Missing agentId or filePath' });
  }

  const agentInfoResponse = await fetch(`http://localhost:${port}/api/agents`); 
  const agents = await agentInfoResponse.json();
  const agent = agents.find(a => a.id === agentId);

  if (!await isValidAgentConfigFile(agentId, filePath, agent)) {
      return res.status(403).json({ error: 'Unauthorized file history access attempt' });
  }

  const fullFilePath = getFullPath(agentId, filePath, agent);
  if (!fullFilePath) {
      return res.status(500).json({ error: 'Could not determine full path for file history.' });
  }

  const repoPath = await getGitRepoPathForFile(fullFilePath);
  if (!repoPath) {
    return res.status(404).json({ error: 'File not found in a whitelisted Git repository.', fullFilePath });
  }

  const relativeFilePath = path.relative(repoPath, fullFilePath);

  exec(`git log --pretty=format:'%h|%an|%ad|%s' --date=short -- "${relativeFilePath}"`, { cwd: repoPath }, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error for git log on ${relativeFilePath} in ${repoPath}: ${error}`);
      return res.status(500).json({ error: 'Failed to fetch git history', details: stderr, stdout: stdout });
    }

    const commits = stdout.split('\n').filter(line => line.trim() !== '').map(line => {
      const parts = line.split('|');
      return {
        hash: parts[0],
        author: parts[1],
        date: parts[2],
        subject: parts[3]
      };
    });
    res.json(commits);
  });
});

// NEW API endpoint to get Model Configuration for a specific agent
app.get('/api/agent-model-settings/:agentId', async (req, res) => {
  const { agentId } = req.params;

  const openclawConfigPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');

  try {
    const configContent = await fs.readFile(openclawConfigPath, 'utf-8');
    const openclawConfig = JSON.parse(configContent);

    const globalDefaultModel = openclawConfig.agents?.defaults?.model || 'Not set';
    let agentSpecificModel = 'Not set';
    let modelOrder = [];
    let agentFound = false;

    if (openclawConfig.agents?.list) {
      const agentConfig = openclawConfig.agents.list.find(a => a.id === agentId);
      if (agentConfig) {
        agentFound = true;
        agentSpecificModel = agentConfig.model || globalDefaultModel;
        modelOrder = agentConfig.modelOrder || [];
      }
    }

    res.json({
      agentId,
      globalDefaultModel,
      agentSpecificModel,
      modelOrder,
      agentFound
    });

  } catch (error) {
    console.error(`Error fetching model settings for ${agentId}: ${error}`);
    res.status(500).json({ error: 'Failed to fetch model settings', details: error.message });
  }
});

// NEW API endpoint to get OverClaw version and upgrade history
app.get('/api/overclaw-versions', async (req, res) => {
  const overclawProjectPath = __dirname; // Dynamically get the current script's directory
  const packageJsonPath = path.join(overclawProjectPath, 'package.json');

  try {
    // 1. Get current version from package.json
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const currentVersion = packageJson.version || 'Unknown';

    // 2. Get upgrade history from git log
    // Filter for commits that mention 'version', 'feat', 'fix' or specifically 'upgrade' in package.json
    const gitLogCommand = `git log --pretty=format:'%h|%an|%ad|%s' --date=short --grep="version" --grep="feat" --grep="fix" -- package.json`;
    
    exec(gitLogCommand, { cwd: overclawProjectPath }, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error for git log on package.json in ${overclawProjectPath}: ${error}`);
        return res.status(500).json({ error: 'Failed to fetch OverClaw upgrade history', details: stderr, stdout: stdout });
      }

      const history = stdout.split('\n').filter(line => line.trim() !== '').map(line => {
        const parts = line.split('|');
        return {
          hash: parts[0],
          author: parts[1],
          date: parts[2],
          subject: parts[3]
        };
      });

      res.json({
        currentVersion,
        upgradeHistory: history
      });
    });

  } catch (error) {
    console.error(`Error fetching OverClaw versions: ${error}`);
    res.status(500).json({ error: 'Failed to fetch OverClaw versions', details: error.message });
  }
});

// NEW: Server-side debug endpoint to simulate client-side processing
app.get('/debug-agents-data', async (req, res) => {
  const debugLogs = [];
  const log = (msg, data) => debugLogs.push({ msg, data, timestamp: new Date().toISOString() });

  try {
    log('Server-side DEBUG: Initiating /api/agents...');
    const agentsRaw = await new Promise((resolve, reject) => {
      exec('openclaw agents list --json', (error, stdout, stderr) => {
        if (error) reject({ error, stderr, stdout });
        else resolve(stdout);
      });
    });
    const agents = JSON.parse(agentsRaw);
    log('Server-side DEBUG: Agents data (from /api/agents):', agents);

    log('Server-side DEBUG: Initiating /api/sessions-detail...');
    const sessionsRaw = await new Promise((resolve, reject) => {
      exec('openclaw sessions --json --all-agents', (error, stdout, stderr) => {
        if (error) reject({ error, stderr, stdout });
        else resolve(stdout);
      });
    });
    const sessionsData = JSON.parse(sessionsRaw);
    log('Server-side DEBUG: Sessions raw data (from /api/sessions-detail):', sessionsData);

    const allSessions = (sessionsData.sessions || []).map(s => ({
        ...s,
        updatedAtMs: s.updatedAtMs || (s.updatedAt ? new Date(s.updatedAt).getTime() : undefined)
    }));
    log('Server-side DEBUG: All sessions available for processing (normalized updatedAtMs):', allSessions);

    const combinedData = agents.map(agent => {
      const agentSessions = allSessions.filter(session => {
          const extractedAgentId = getAgentIdFromSessionKey(session.key);
          return extractedAgentId === agent.id;
      });
      
      agentSessions.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));

      const lastActivityMs = agentSessions.length > 0 
          ? Math.max(...agentSessions.filter(s => s.updatedAtMs !== undefined).map(s => s.updatedAtMs))
          : null; 
      const lastActivity = lastActivityMs ? new Date(lastActivityMs).toLocaleString() : 'N/A';

      const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
      const now = Date.now();
      const activeSessions = agentSessions.filter(s => {
          const ageMs = now - (s.updatedAtMs || 0); 
          const isActive = (s.updatedAtMs !== undefined) && (ageMs < ACTIVE_THRESHOLD_MS); 
          return isActive;
      }); 
      const activeSessionsCount = activeSessions.length;

      const mostRelevantSession = activeSessions.length > 0 ? activeSessions[0] : (agentSessions.length > 0 ? agentSessions[0] : null);
      let currentTask = 'N/A';
      if (mostRelevantSession) {
          if (mostRelevantSession.message && typeof mostRelevantSession.message === 'string' && mostRelevantSession.message.length > 0) {
              currentTask = mostRelevantSession.message; 
          } else if (mostRelevantSession.lastMessage?.message && typeof mostRelevantSession.lastMessage.message === 'string' && mostRelevantSession.lastMessage.message.length > 0) {
              currentTask = mostRelevantSession.lastMessage.message; 
          } else if (mostRelevantSession.key) {
              const keyParts = mostRelevantSession.key.split(':');
              if (keyParts.includes('cron')) {
                  currentTask = `Cron Job: ${keyParts[3] || 'Unknown'}`;
              }
              if (currentTask === 'N/A') {
                  currentTask = `Chat Session: ${keyParts[keyParts.length - 1]}`;
              }
          }
      }
      currentTask = currentTask.length > 100 ? currentTask.substring(0, 97) + '...' : currentTask;
      
      return {
        ...agent,
        lastActivity,
        activeSessionsCount,
        currentTask,
      };
    });

    res.json({ combinedData, debugLogs });

  } catch (error) {
    log('Server-side DEBUG: Error in /debug-agents-data:', error);
    res.status(500).json({ error: 'Server-side debug failed', details: error.message, logs: debugLogs, originalError: error });
  }
});

// Projects Kanban board — redirected to vault-backed task board
app.get('/projects/kanban', (req, res) => res.redirect(301, '/task-board'));
app.get('/kanban', (req, res) => res.redirect(301, '/task-board'));

// Helper function to read projects data
async function readProjects() {
  const data = await fs.readFile(path.join(__dirname, 'data', 'projects.json'), 'utf8');
  return JSON.parse(data);
}

// Helper function to write projects data
async function writeProjects(data) {
  await fs.writeFile(path.join(__dirname, 'data', 'projects.json'), JSON.stringify(data, null, 2));
}

// API: Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const projectsData = await readProjects();
    res.json(projectsData.projects);
  } catch (error) {
    console.error(`Error reading projects: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch projects', details: error.message });
  }
});

// API: Get single project by ID
app.get('/api/projects/:id', async (req, res) => {
  try {
    const projectsData = await readProjects();
    const project = projectsData.projects.find(p => p.id === req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error(`Error reading project ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch project', details: error.message });
  }
});

// API: Create new project
app.post('/api/projects', async (req, res) => {
  try {
    const projectsData = await readProjects();
    const newProject = {
      id: `proj-${String(projectsData.projects.length + 1).padStart(3, '0')}`,
      created: new Date().toISOString(),
      ...req.body,
      progressNotes: [],
      impediments: [],
      blockers: []
    };
    projectsData.projects.push(newProject);
    await writeProjects(projectsData);
    res.status(201).json(newProject);
  } catch (error) {
    console.error(`Error creating project: ${error.message}`);
    res.status(500).json({ error: 'Failed to create project', details: error.message });
  }
});

// API: Update project
app.put('/api/projects/:id', async (req, res) => {
  try {
    const projectsData = await readProjects();
    const index = projectsData.projects.findIndex(p => p.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const updatedProject = { ...projectsData.projects[index], ...req.body };
    projectsData.projects[index] = updatedProject;
    await writeProjects(projectsData);
    res.json(updatedProject);
  } catch (error) {
    console.error(`Error updating project ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to update project', details: error.message });
  }
});

// API: Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const projectsData = await readProjects();
    const index = projectsData.projects.findIndex(p => p.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }
    projectsData.projects.splice(index, 1);
    await writeProjects(projectsData);
    res.status(204).send();
  } catch (error) {
    console.error(`Error deleting project ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete project', details: error.message });
  }
});

// POST /api/vault/task-board/escalate — promote a stuck in-progress task to blocked
app.post('/api/vault/task-board/escalate', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const { taskId, reason } = req.body || {};
  if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'taskId required' });
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);

    const today         = new Date().toISOString().slice(0, 10);
    const escalateReason = (reason || '').trim()
      || `Auto-escalated by OverClaw on ${today}: stuck in progress with no recent activity`;

    const taskBoardPath = path.join(VAULT_PATH, '03 - Agents', 'Coordination', 'Task Board.md');
    const content       = await fs.readFile(taskBoardPath, 'utf-8');
    const newContent    = moveTaskToBlocked(content, taskId, escalateReason);

    await fs.writeFile(taskBoardPath, newContent, 'utf-8');
    console.log(`Escalated ${taskId} to Blocked in Task Board.md`);

    // Commit via vault-sync
    const { execFile } = require('child_process');
    const vaultSyncBin = path.join(process.env.HOME, '.local', 'bin', 'vault-sync');
    const syncResult = await new Promise(resolve =>
      execFile(vaultSyncBin, ['push', `task: escalate ${taskId} \u2192 blocked`],
        { timeout: 30000 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr })
      )
    );

    if (syncResult.err) {
      console.warn(`vault-sync after escalation of ${taskId}: ${syncResult.stderr}`);
      return res.status(207).json({
        ok: true, synced: false, taskId,
        warning: 'Task moved locally but vault-sync failed — run a manual Sync',
        details: syncResult.stderr,
      });
    }

    res.json({ ok: true, synced: true, taskId, reason: escalateReason, escalatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`Escalation failed for ${taskId}: ${err.message}`);
    res.status(500).json({ error: 'Escalation failed', details: err.message });
  }
});

// POST /api/vault/task-board/return-to-inbox — move an in-progress or blocked task back to inbox
app.post('/api/vault/task-board/return-to-inbox', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const { taskId, fromSection } = req.body || {};
  if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'taskId required' });
  if (!['inProgress', 'blocked'].includes(fromSection))
    return res.status(400).json({ error: 'fromSection must be inProgress or blocked' });
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);

    const taskBoardPath = path.join(VAULT_PATH, '03 - Agents', 'Coordination', 'Task Board.md');
    const content       = await fs.readFile(taskBoardPath, 'utf-8');
    const newContent    = moveTaskToInbox(content, taskId, fromSection);

    await fs.writeFile(taskBoardPath, newContent, 'utf-8');
    console.log(`Moved ${taskId} back to Inbox from ${fromSection}`);

    const syncResult = await vaultSync(`task: return ${taskId} \u2192 inbox`);
    if (!syncResult.ok) {
      console.warn(`vault-sync after return-to-inbox of ${taskId}: ${syncResult.stderr}`);
      return res.status(207).json({
        ok: true, synced: false, taskId,
        warning: 'Task moved locally but vault-sync failed \u2014 run a manual Sync',
        details: syncResult.stderr,
      });
    }

    res.json({ ok: true, synced: true, taskId, fromSection, returnedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`Return-to-inbox failed for ${taskId}: ${err.message}`);
    res.status(500).json({ error: 'Return to inbox failed', details: err.message });
  }
});


// GET /api/vault/notifications/:agentName — unread notification files for an agent
app.get('/api/vault/notifications/:agentName', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const notifications = await vaultReader.getNotifications(req.params.agentName);
    res.json({ notifications });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/vault/task-board/assign — assign+start (Inbox→InProgress) or reassign blocked agent
app.post('/api/vault/task-board/assign', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const { taskId, agentKey, fromSection } = req.body || {};
  if (!taskId   || typeof taskId   !== 'string') return res.status(400).json({ error: 'taskId required' });
  if (!agentKey || typeof agentKey !== 'string') return res.status(400).json({ error: 'agentKey required' });
  if (!['inbox','blocked'].includes(fromSection))
    return res.status(400).json({ error: 'fromSection must be inbox or blocked' });
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);
    const tbPath = path.join(VAULT_PATH, '03 - Agents', 'Coordination', 'Task Board.md');
    const raw    = await fs.readFile(tbPath, 'utf-8');
    // Best-effort title extraction for the notification message
    let taskTitle = taskId;
    const tm = raw.match(new RegExp('\\|[^|]*' + taskId.replace(/-/g,'\\-') + '[^|]*\\|\\s*([^|]+)\\|'));
    if (tm) taskTitle = tm[1].replace(/\*+/g,'').trim().slice(0, 80);
    const newContent = fromSection === 'inbox'
      ? moveTaskToInProgress(raw, taskId, agentKey.toLowerCase())
      : updateBlockedTaskAgent(raw, taskId, agentKey.toLowerCase());
    await fs.writeFile(tbPath, newContent, 'utf-8');
    // Tier 2 — vault notification file
    let notified = false;
    if (agentKey.toLowerCase() !== 'jimmy') {
      try { await writeNotificationFile(agentKey, taskId, taskTitle, fromSection); notified = true; }
      catch (ne) { console.warn('Notification file write failed:', ne.message); }
    }
    // vault-sync commit
    const syncRes = await vaultSync('task: assign ' + taskId + ' \u2192 ' + agentKey);
    // Tier 1 — live wake for Spike (same gateway, non-fatal if it fails)
    let wake = null;
    if (agentKey.toLowerCase() === 'spike' && clawBridge) {
      try {
        await clawBridge.wakeAgent('\ud83d\udccb Task assigned: ' + taskId + ' \u2014 ' + taskTitle + '. Check Task Board.');
        wake = 'sent';
      } catch (we) { console.warn('Tier-1 wake (non-fatal):', we.message); wake = 'failed: ' + we.message; }
    }
    if (!syncRes.ok)
      return res.status(207).json({ ok: true, synced: false, taskId, agentKey, fromSection,
        notified, wake, warning: 'Updated locally but vault-sync failed', details: syncRes.stderr });
    res.json({ ok: true, synced: true, taskId, agentKey, fromSection, notified, wake, assignedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Assign failed for ' + taskId + ': ' + err.message);
    res.status(500).json({ error: 'Assign failed', details: err.message });
  }
});

// GET /api/heartbeat-history — per-agent heartbeat check-in counts for the last N days
app.get('/api/heartbeat-history', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  try {
    const status = await vaultReader.isAvailable();
    if (!status.available) return vaultUnavailable(res, status.error);

    const days = Math.min(parseInt(req.query.days || '7', 10), 30);
    const heartbeats = await vaultReader.getHeartbeats({ limit: 1000 });

    // Build list of last N calendar days, oldest first
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayList.push(d.toISOString().slice(0, 10));
    }

    // Agent → vault machine-key mapping (matches swarm summary keys)
    const agentDefs = {
      Spike: ['OpenClaw'],
      Steve: ['BrightMove-MBP'],
      Lex:   ['BrightMove-MBP/Cursor'],
      Bill:  ['H2FClanker1'],
    };

    const history = {};
    for (const [name, keys] of Object.entries(agentDefs)) {
      const agentHBs = heartbeats.filter(hb => {
        const key = hb.subAgent ? `${hb.machine}/${hb.subAgent}` : hb.machine;
        return keys.includes(key);
      });
      const counts = dayList.map(day =>
        agentHBs.filter(hb => hb.date && hb.date.startsWith(day)).length
      );
      history[name] = { days: dayList, counts };
    }

    res.json(history);
  } catch (err) {
    console.error(`Error fetching heartbeat history: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch heartbeat history', details: err.message });
  }
});

// Security page
app.get('/security', (req, res) => {
  res.render('security', { title: 'Vault Security', currentPath: '/security' });
});

// GET /api/security/summary
app.get('/api/security/summary', async (req, res) => {
  const KNOWN_FP_RULES   = new Set(['curl-auth-user']);
  const KNOWN_FP_SECRETS = new Set(['Kwa/JGHl4v0AlYFQyuGWtg']); // Ahrefs BKS analytics embed

  const out = {
    lastScan: null, gitleaksVersion: '8.26.0',
    commitCount: null, totalFindings: 0, realFindings: 0, falsePositives: 0,
    findings: [], auditHistory: [], auditLog: null, policy: null,
    nextScanSchedule: 'Every Sunday at 9:00 AM ET',
  };

  // 1. Most recent gitleaks JSON in /tmp
  try {
    const tmpFiles = await fs.readdir('/tmp');
    const reports  = tmpFiles
      .filter(f => f.startsWith('gitleaks-report-') && f.endsWith('.json'))
      .sort().reverse();
    if (reports.length > 0) {
      const raw   = JSON.parse(await fs.readFile(path.join('/tmp', reports[0]), 'utf-8'));
      const dateM = reports[0].match(/(\d{4}-\d{2}-\d{2})/);
      if (dateM) out.lastScan = dateM[1];
      out.totalFindings = raw.length;
      const real = raw.filter(f => !KNOWN_FP_RULES.has(f.RuleID) && !KNOWN_FP_SECRETS.has(f.Secret));
      out.falsePositives = raw.length - real.length;
      out.realFindings   = real.length;
      const byRule = {};
      for (const f of real) (byRule[f.RuleID] = byRule[f.RuleID] || []).push(f);
      const RULE_META = {
        'slack-webhook-url': {
          label: 'Slack Webhook URL', severity: 'high',
          remediation: 'Rotate at api.slack.com → BrightMove app → Incoming Webhooks. Store new URL in Bitwarden (slack-webhook-brightmove-agent-monitoring) — never paste in vault files.',
        },
        'generic-api-key': {
          label: 'Generic API Key', severity: 'medium',
          remediation: 'Verify: check view-source on the site. If it is a public analytics embed key (like Ahrefs), add to suppression list. If a real secret, rotate and move to Bitwarden.',
        },
        'private-key': { label: 'Private Key', severity: 'high',
          remediation: 'Rotate immediately and remove from repo history.' },
      };
      out.findings = Object.entries(byRule).map(([ruleId, items]) => {
        const meta = RULE_META[ruleId] || {};
        const uniqueFiles = [...new Set(items.map(i => i.File))];
        return {
          ruleId, label: meta.label || ruleId,
          severity:    meta.severity || 'medium',
          count:       items.length, fileCount: uniqueFiles.length,
          files:       uniqueFiles.slice(0, 3),
          firstDate:   items[0]?.Date?.slice(0, 10),
          firstCommit: items[0]?.Commit?.slice(0, 8),
          author:      items[0]?.Author,
          remediation: meta.remediation || 'Review and rotate if sensitive.',
          status: 'open',
        };
      }).sort((a, b) => ({ high:0, medium:1, low:2 }[a.severity]||2) - ({ high:0, medium:1, low:2 }[b.severity]||2));
    }
  } catch (e) { console.warn('Security summary: gitleaks parse failed:', e.message); }

  // 2. Commit count
  try {
    const { execSync } = require('child_process');
    out.commitCount = parseInt(execSync('git rev-list --count --all HEAD', { cwd: VAULT_PATH, timeout: 5000 }).toString().trim(), 10) || null;
  } catch {}

  // 3. Vault files
  if (vaultReader) {
    try {
      const txt = await vaultReader.getFile('08 - QA-and-Monitoring/Security/Security-Audit-Log.md');
      out.auditLog = txt;
      const sections = txt.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
      out.auditHistory = sections.map(s => {
        const hdr   = s.match(/^## (\d{4}-\d{2}-\d{2}) — (.+)/);
        if (!hdr) return null;
        const totalM = s.match(/Total findings[:\s]+(\d+)/i);
        const realM  = s.match(/Real findings[:\s]+(\d+)/i) || s.match(/(\d+) real\b/i);
        const fpM    = s.match(/FP suppressed[:\s]+(\d+)/i) || s.match(/false positive[s]?[:\s]+(\d+)/i);
        const commM  = s.match(/([\d,]+) commits/i);
        return {
          date: hdr[1], label: hdr[2].trim().slice(0, 60),
          total:   totalM ? parseInt(totalM[1])                   : null,
          real:    realM  ? parseInt(realM[1])                    : null,
          fps:     fpM    ? parseInt(fpM[1])                      : null,
          commits: commM  ? commM[1]                              : null,
        };
      }).filter(Boolean).reverse();
    } catch {}
    try { out.policy = await vaultReader.getFile('SECURITY.md'); } catch {}
  }

  res.json(out);
});

// POST /api/security/scan — trigger a fresh gitleaks scan (~5s)
app.post('/api/security/scan', async (req, res) => {
  const gitleaksBin = path.join(process.env.HOME, '.local', 'bin', 'gitleaks');
  try { await fs.access(gitleaksBin); } catch {
    return res.status(503).json({ error: 'gitleaks binary not found', hint: gitleaksBin });
  }
  const today      = new Date().toISOString().slice(0, 10);
  const reportPath = `/tmp/gitleaks-report-${today}.json`;
  const { execFile } = require('child_process');
  try {
    await new Promise((resolve, reject) =>
      execFile(gitleaksBin, [
        'detect', '--source', VAULT_PATH,
        '--log-opts', '--all',
        '--report-format', 'json',
        '--report-path', reportPath,
      ], { timeout: 90000 },
      (err, stdout, stderr) => {
        if (err && err.code !== 1) return reject(err); // code 1 = leaks found, not an error
        resolve();
      })
    );
    res.json({ ok: true, reportPath, scanDate: today });
  } catch (err) {
    console.error('Security scan failed:', err.message);
    res.status(500).json({ error: 'Scan failed', details: err.message });
  }
});

// Simple /status route
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Background vault sync — git pull every 5 minutes
// ---------------------------------------------------------------------------
if (vaultReader) {
  const VAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  // Initial pull on startup
  vaultReader.sync().then(r => {
    if (r.ok && !r.skipped) console.log(`Vault: initial sync complete${r.stdout ? ' — ' + r.stdout : ''}`);
    else if (!r.ok) console.warn(`Vault: initial sync failed — ${r.error}`);
  });
  // Recurring pull
  setInterval(() => {
    vaultReader.sync().then(r => {
      if (!r.ok && !r.skipped) console.warn(`Vault: background sync failed — ${r.error}`);
    });
  }, VAULT_SYNC_INTERVAL_MS);
  console.log(`Vault: auto-sync enabled every ${VAULT_SYNC_INTERVAL_MS / 60000} minutes`);
}

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`OverClaw running at http://0.0.0.0:${port}`);
});
