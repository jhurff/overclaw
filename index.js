const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs').promises; // For async file operations
const crypto = require('crypto');
const ClawBridge = require('./lib/ClawBridge'); // Import ClawBridge
const VaultReader = require('./lib/VaultReader'); // Vault integration
const McpServer  = require('./lib/McpServer');   // MCP protocol server
const BrainStore = require('./lib/BrainStore');  // Document DB

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

// ---------------------------------------------------------------------------
// BrainStore — centralized document DB (replaces Git/vault-sync)
// ---------------------------------------------------------------------------
const BRAIN_DB_PATH = process.env.BRAIN_DB_PATH
  || path.join(__dirname, 'data', 'brain.db');
let brainStore;
try {
  brainStore = new BrainStore(BRAIN_DB_PATH);
  console.log(`BrainStore initialized: ${BRAIN_DB_PATH} (${brainStore.stats().documents} docs)`);
} catch (err) {
  console.warn(`BrainStore init failed: ${err.message}`);
  brainStore = null;
}

// Seed admin user from env if users table is empty
if (brainStore) {
  const bcrypt = require('bcrypt');
  const adminUser = process.env.OVERCLAW_ADMIN_USER;
  const adminPass = process.env.OVERCLAW_ADMIN_PASS;
  if (adminUser && adminPass) {
    const existing = brainStore.getUserByUsername(adminUser);
    if (!existing) {
      bcrypt.hash(adminPass, 10).then(hash => {
        brainStore.createUser({
          id: 'admin-' + crypto.randomBytes(4).toString('hex'),
          username: adminUser,
          passwordHash: hash,
          role: 'admin'
        });
        console.log(`BrainStore: seeded admin user '${adminUser}'`);
      }).catch(() => {});
    }
  }
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
  // Any agent key: capitalize first letter (no hardcoded list — new agents work automatically)
  const agentName = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
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

// GET /api/agents/onboarding-snippet?agent=<name>
// Returns a tailored onboarding snippet for copy-paste into a new agent session.
app.get('/api/agents/onboarding-snippet', async (req, res) => {
  const agentKey = (req.query.agent || '').trim().toLowerCase();
  if (!agentKey) return res.status(400).json({ error: 'agent query param required' });

  // Pull live agent registry and config
  let agentData = {};
  const cfg = await readConfig();
  const net = Object.assign({ localhostIp: '127.0.0.1', localnetIp: '192.168.68.42', privateWanIp: '100.69.254.0', publicWanIp: '' }, cfg.network || {});

  try {
    const agents = await vaultReader.getAgentRegistry();
    const found  = agents.find(a =>
      (a.nickname || a.agent || '').toLowerCase() === agentKey
    );
    if (found) agentData = found;
  } catch (e) { /* best-effort */ }

  // Capitalise first letter for display
  const name    = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
  const role    = agentData.primary_role || agentData.role || 'Agent';
  const machine = agentData.machine || 'unknown';
  const type    = agentData.type    || 'AI Agent';
  const account = agentData.account || '';

  // Zone determines which IP to use for MCP endpoint
  // Priority: config agentZones → agent registry network_zone field → default 'localnet'
  const savedZones = cfg.agentZones || {};
  const zone    = savedZones[agentKey] ||
                  (agentData.network_zone || agentData.zone || '').toLowerCase().replace(/[^a-z_]/g, '') ||
                  'localnet';
  const ZONE_LABELS = {
    localhost:   'localhost (same host as OverClaw)',
    localnet:    'localnet (LAN)',
    private_wan: 'private WAN (Tailscale/VPN)',
    public_wan:  'public WAN (internet)',
  };
  const mcpHostMap = {
    localhost:   net.localhostIp  || '127.0.0.1',
    localnet:    net.localnetIp   || '192.168.68.42',
    private_wan: net.privateWanIp || '100.69.254.0',
    public_wan:  net.publicWanIp  || '<PUBLIC_WAN_IP>',
  };
  const mcpHost = mcpHostMap[zone] || mcpHostMap.localnet;
  const mcpPort = cfg.port || 8355;
  const mcpUrl  = `http://${mcpHost}:${mcpPort}/mcp`;
  const sseUrl  = `http://${mcpHost}:${mcpPort}/mcp/sse`;
  const brainUrl = `http://${mcpHost}:${mcpPort}/brain`;
  const swarmUrl = `http://${mcpHost}:${mcpPort}/swarm`;

  const snippet = [
    `# OverClaw Onboarding — ${name}`,
    ``,
    `You are **${name}**, an AI agent in the Jimmy Hurff swarm.`,
    `- **Role:** ${role}`,
    `- **Machine:** ${machine}`,
    `- **Type:** ${type}`,
    account ? `- **Account:** ${account}` : null,
    `- **Network Zone:** \`${zone}\` — ${ZONE_LABELS[zone] || zone}`,
    ``,
    `## 🔌 MCP Connection`,
    ``,
    `Connect to the OverClaw coordination server:`,
    ``,
    `- **Endpoint:** \`${mcpUrl}\`  (Streamable HTTP, MCP 2025-03-26)`,
    `- **SSE:** \`${sseUrl}\``,
    `- **API key:** get from Bitwarden item \`overclaw-mcp-key\``,
    `- **Auth header:** \`Authorization: Bearer <key>\``,
    `- **Agent header:** \`X-Agent-Name: ${agentKey}\` (always pass this on REST calls)`,
    `- **MCP tool calls:** pass \`_agentName: "${agentKey}"\` in every tool argument`,
    ``,
    `## 📚 First Steps After Connecting`,
    ``,
    `1. **Read the Brain README** — your canonical orientation doc:`,
    `   \`brain_read({ path: "README.md" })\``,
    `   Or browse: ${brainUrl}?path=README.md`,
    ``,
    `2. **Check notifications** — any tasks assigned to you:`,
    `   \`get_notifications({ agent: "${agentKey}" })\``,
    ``,
    `3. **Check your task inbox:**`,
    `   \`get_my_tasks({ agent: "${agentKey}" })\``,
    ``,
    `4. **Claim and work tasks:**`,
    `   \`get_task\`, \`claim_task\`, \`complete_task\`, \`block_task\``,
    ``,
    `## 🧠 Brain DB Quick Reference`,
    ``,
    `| Tool | Purpose |`,
    `|------|---------|`,
    `| \`brain_read\`   | Read a document by path |`,
    `| \`brain_write\`  | Create or update a document |`,
    `| \`brain_search\` | Full-text search across all docs |`,
    `| \`brain_list\`   | List directory contents |`,
    `| \`brain_history\`| View version history for a doc |`,
    ``,
    `Always pass \`_agentName: "${agentKey}"\` so your activity is attributed correctly.`,
    ``,
    `## 📊 Swarm Dashboard`,
    ``,
    `Monitor the swarm at: ${swarmUrl}`,
    `Your brain connectivity globe on the swarm page shows green when you've read/written in the last 15 min.`,
    ``,
    `---`,
    `*Generated by OverClaw onboarding — ${new Date().toISOString().slice(0, 10)}*`,
  ].filter(l => l !== null).join('\n');

  res.json({ agent: agentKey, name, zone, mcpUrl, snippet });
});

// Config Viewer screen route
// ── Config helpers ──────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config', 'overclaw.json');

async function readConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

async function writeConfig(patch) {
  const current = await readConfig();
  const merged  = deepMerge(current, patch);
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}

function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        typeof base[k] === 'object' && base[k] !== null) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Detect live network IPs on this host
function detectNetworkIps() {
  const { execSync } = require('child_process');
  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };

  // Local-area IP (first non-loopback, non-docker, non-tailscale IPv4)
  const ifaceLines = safe(() =>
    execSync('ip -4 addr show 2>/dev/null', { timeout: 3000 }).toString(), ''
  ).split('\n');
  let localnetIp = '';
  for (const line of ifaceLines) {
    const m = line.match(/\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)\s+.*?\s+(\S+)$/);
    if (!m) continue;
    const [, ip,, iface] = m;
    if (ip === '127.0.0.1') continue;
    if (iface.startsWith('docker') || iface.startsWith('br-') || iface.startsWith('veth')) continue;
    if (iface === 'tailscale0') continue;
    localnetIp = ip;
    break;
  }

  // Tailscale IP
  const tailscaleIp = safe(() =>
    execSync('tailscale ip --4 2>/dev/null', { timeout: 3000 }).toString().trim(), ''
  );

  // Public WAN IP (best-effort, quick)
  const publicIp = safe(() =>
    execSync('curl -s --max-time 4 https://api.ipify.org 2>/dev/null', { timeout: 6000 }).toString().trim(), ''
  );

  return {
    localhostIp: '127.0.0.1',
    localnetIp:  localnetIp  || '',
    privateWanIp: tailscaleIp || '',
    publicWanIp:  publicIp    || '',
  };
}

// GET /api/overclaw-config
app.get('/api/overclaw-config', async (req, res) => {
  const cfg = await readConfig();
  res.json(cfg);
});

// POST /api/overclaw-config  — patch config (deep-merge)
app.post('/api/overclaw-config', async (req, res) => {
  try {
    const merged = await writeConfig(req.body || {});
    // Reload live references that don't need restart
    if (merged.network) Object.assign(ocConfig, { network: merged.network });
    const RESTART_FIELDS = ['port', 'bindHost', 'openclawGatewayUrl'];
    const requiresRestart = RESTART_FIELDS.some(f => req.body && f in req.body);
    res.json({ ok: true, config: merged, requiresRestart });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/network/detect  — detect live IPs on this host
app.get('/api/network/detect', async (req, res) => {
  try {
    const detected = detectNetworkIps();
    res.json(detected);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/config', async (req, res) => {
  const cfg = await readConfig();
  const ocCfg = {
    brainPath:            cfg.brainPath            || '~/My-AI-Brain',
    port:                 cfg.port                 || 8355,
    scanFrequencySeconds: cfg.scanFrequencySeconds || 300,
    openclawGatewayUrl:   cfg.openclawGatewayUrl   || 'ws://127.0.0.1:18789',
    vaultAutoPullOnLoad:  cfg.vaultAutoPullOnLoad  !== false,
    network: Object.assign({
      localhostIp:  '127.0.0.1',
      localnetIp:   '',
      privateWanIp: '',
      publicWanIp:  '',
    }, cfg.network || {}),
  };
  res.render('config', { title: 'OverClaw Settings', currentPath: '/config', ocConfig: ocCfg, brainStats: brainStore ? brainStore.stats() : null });
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
  res.render('activity', { title: 'OverClaw Activity Feed', currentPath: '/activity' });
});

// GET /api/feed?limit=200&agent=&type=
// Unified activity feed: brain ops + doc writes + heartbeats + MCP connects
app.get('/api/feed', async (req, res) => {
  const limit     = Math.min(parseInt(req.query.limit  || '200', 10), 1000);
  const agentFilter = (req.query.agent || '').toLowerCase().trim();
  const typeFilter  = (req.query.type  || '').toLowerCase().trim();

  const events = [];

  // ── 1. Brain activity (reads / writes / searches / lists) ──────────────
  if (brainStore) {
    try {
      const rows = brainStore.db.prepare(
        `SELECT agent, op, path, ok, ts FROM brain_activity ORDER BY ts DESC LIMIT 2000`
      ).all();
      for (const r of rows) {
        const opMap = { read:'brain_read', write:'brain_write', search:'brain_search', list:'brain_list' };
        events.push({
          type:    opMap[r.op] || ('brain_' + r.op),
          agent:   r.agent,
          summary: r.op === 'write'  ? `Wrote ${r.path || '?'}`
                 : r.op === 'read'   ? `Read ${r.path || '?'}`
                 : r.op === 'search' ? `Searched ${r.path || 'all docs'}`
                 : r.op === 'list'   ? `Listed ${r.path || '/'}`
                 : r.op,
          detail:  r.path || null,
          ok:      r.ok !== 0,
          ts:      r.ts,
        });
      }
    } catch(e) { console.error('[feed] brain_activity:', e.message); }

    // ── 2. Document versions (brain writes with attribution) ───────────────
    try {
      const rows = brainStore.db.prepare(
        `SELECT path, version, saved_at, saved_by, change_note FROM document_versions ORDER BY saved_at DESC LIMIT 2000`
      ).all();
      for (const r of rows) {
        events.push({
          type:    'doc_version',
          agent:   (r.saved_by || 'unknown').toLowerCase(),
          summary: `${r.version === 1 ? 'Created' : 'Edited'} ${r.path}`,
          detail:  r.change_note || (r.version === 1 ? 'Initial version' : `v${r.version}`),
          ok:      true,
          ts:      r.saved_at,
        });
      }
    } catch(e) { console.error('[feed] document_versions:', e.message); }
  }

  // ── 3. Heartbeats ─────────────────────────────────────────────────────
  try {
    const hbs = await vaultReader.getHeartbeats({ limit: 500 }).catch(() => []);
    for (const hb of hbs) {
      const agentKey = (hb.agent || hb.machine || 'unknown').toLowerCase()
        .replace(/[^a-z]/g, '').replace(/h2fclanker\d*/g, 'spike');
      events.push({
        type:    'heartbeat',
        agent:   agentKey || 'unknown',
        summary: `Heartbeat from ${hb.machine || hb.agent || '?'}`,
        detail:  hb.notes || null,
        ok:      true,
        ts:      hb.date ? new Date(hb.date).getTime() : null,
      });
    }
  } catch(e) { console.error('[feed] heartbeats:', e.message); }

  // ── 4. MCP connections (brain_activity where op logged by MCP session) ─
  // (covered by brain_activity above — MCP tool calls show up as brain_* events)

  // Filter, sort, dedupe, limit
  let filtered = events.filter(e => e.ts);
  if (agentFilter) filtered = filtered.filter(e => (e.agent||'').includes(agentFilter));
  if (typeFilter)  filtered = filtered.filter(e => (e.type||'').includes(typeFilter));

  // Sort newest first
  filtered.sort((a, b) => b.ts - a.ts);

  // Remove near-duplicate brain_activity + doc_version pairs (same agent, path, within 2s)
  const seen = new Set();
  const deduped = [];
  for (const e of filtered) {
    if (e.type === 'brain_write' && e.detail) {
      const key = e.agent + '|' + e.detail + '|' + Math.floor(e.ts / 2000);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(e);
    if (deduped.length >= limit) break;
  }

  res.json({ total: deduped.length, events: deduped });
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
// Legacy vault UI routes — redirected to Brain DB UI
app.get('/vault/doc',    (req, res) => res.redirect('/brain' + (req.query.path ? '?path=' + encodeURIComponent(req.query.path) : '')));
app.get('/vault/edit',   (req, res) => res.redirect('/brain' + (req.query.path ? '?path=' + encodeURIComponent(req.query.path) : '')));
app.get('/vault/graph',  (req, res) => res.redirect('/brain'));
app.get('/vault/browse', (req, res) => res.redirect('/brain'));

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
  'Grok-Bot/Luther':       { key: 'luther', label: 'Luther — Grok Bot cloud',                   canWake: false },
  'Grok-Bot/Peter':        { key: 'peter',  label: 'Peter — Grok Bot cloud',                    canWake: false },
  'Grok-Bot/Buster':       { key: 'buster', label: 'Buster — Grok Bot cloud',                   canWake: false },
  // Legacy flat key (fallback for old heartbeat files not yet moved)
  'Grok-Bot':              { key: 'luther', label: 'Luther — Grok Bot cloud (legacy)',           canWake: false },
};

/** All agents as an ordered list for the picker. */
const RESOLVE_AGENTS_LIST = [
  { key: 'spike', label: 'Spike — OpenClaw / H2FClanker2',         canWake: true  },
  { key: 'steve', label: 'Steve — Claude Cowork / BrightMove MBP', canWake: false },
  { key: 'bill',  label: 'Bill — ChatGPT / H2FClanker1',            canWake: false },
  { key: 'lex',   label: 'Lex — Cursor / BrightMove MBP',          canWake: false },
  { key: 'luther', label: 'Luther — Grok Bot cloud',              canWake: false },
  { key: 'peter',  label: 'Peter — Grok Bot cloud',               canWake: false },
  { key: 'buster', label: 'Buster — Grok Bot cloud',              canWake: false },
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
      !l.startsWith('resolution_agent:') &&
      !l.startsWith('resolution_note:')
    );
    fmKeep.push(`resolution_status: dispatched`);
    fmKeep.push(`resolution_dispatched_at: ${nowISO}`);
    fmKeep.push(`resolution_agent: ${effectiveAgentKey}`);
    // First line of instructions written to frontmatter for quick surface in Swarm Overview
    const noteLine = instructions.split('\n')[0].trim().slice(0, 250)
      .replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fmKeep.push(`resolution_note: "${noteLine}"`);
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

// POST /api/resolve/close — directly mark an alert as HANDLED (issue fixed at source)
app.post('/api/resolve/close', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const { alertPath, note } = req.body || {};
  if (!alertPath) return res.status(400).json({ error: 'alertPath required' });
  try {
    const filePath = '08 - QA-and-Monitoring/Heartbeats/' + alertPath;
    const vaultAbs = path.resolve(vaultReader.vaultPath);
    const abs      = path.resolve(vaultAbs, filePath);
    if (!abs.startsWith(vaultAbs + path.sep)) return res.status(403).json({ error: 'Path traversal denied' });

    // Must be a NEEDS-ATTENTION file
    const basename = path.basename(abs);
    if (!basename.toUpperCase().startsWith('NEEDS-ATTENTION')) {
      return res.status(400).json({ error: 'Only NEEDS-ATTENTION files can be closed this way' });
    }

    const content = await vaultReader.getFile(filePath);
    const fm      = parseFrontmatterText(content);

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

    // Update frontmatter
    const fmKeep = fmLines.filter(l =>
      !l.startsWith('resolution_status:') &&
      !l.startsWith('resolution_dispatched_at:') &&
      !l.startsWith('resolution_agent:')
    );
    fmKeep.push(`resolution_status: closed`);
    fmKeep.push(`resolution_closed_at: ${nowISO}`);
    fmKeep.push(`resolution_closed_by: Jimmy`);
    const newFm = '---\n' + fmKeep.join('\n') + '\n---';

    // Append resolution section
    const resNote = note ? note.trim() : 'Issue resolved at source.';
    const histEntry = [
      '',
      `### Closed — ${nowET}`,
      `**Closed by:** Jimmy  `,
      `**Resolution note:** ${resNote}`,
      '',
    ].join('\n');

    let newBody;
    if (body.includes('## 🔧 Resolution History')) {
      newBody = body.trimEnd() + '\n' + histEntry;
    } else {
      newBody = body.trimEnd() + '\n\n---\n\n## 🔧 Resolution History\n' + histEntry;
    }

    // Write updated content to the file first
    const newContent = newFm + '\n\n' + newBody;
    await fs.writeFile(abs, newContent, 'utf-8');

    // Rename NEEDS-ATTENTION-* → HANDLED-*
    const dir         = path.dirname(abs);
    const handledName = basename.replace(/^NEEDS-ATTENTION[-_]/i, 'HANDLED-');
    const handledAbs  = path.join(dir, handledName);
    await fs.rename(abs, handledAbs);

    // Derive vault-relative paths for the commit message
    const alertId = path.basename(alertPath, '.md');
    const synced  = await vaultSync(`resolve: close ${alertId.slice(0, 80)} — ${resNote.slice(0, 60)}`);

    res.json({
      ok: true,
      synced: synced.ok,
      syncWarning: synced.ok ? null : synced.stderr,
      alertId,
      handledName,
    });
  } catch (err) {
    console.error(`[resolve/close] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/alerts/close-by-job — auto-close heartbeat alerts when a source recovers
//
// Called by monitors when they detect a FAILED → OK recovery for a specific
// source/job.  Immediately stamps resolution_status: closed on the relevant
// heartbeat file so the alert disappears from the feed without waiting for the
// next scheduled monitor run.
//
// Body: { machine, job, note? }
//   machine  — "H2FClanker2", "OpenClaw", etc.
//   job      — job name, e.g. "bjb-disposition-monitor"
//   note     — optional free-text recovery note (shown in history)
//
// Auth: same MCP_API_KEY used by agents
app.post('/api/alerts/close-by-job', async (req, res) => {
  // Lightweight bearer-token check (same key agents use for task APIs)
  const auth = req.headers.authorization || '';
  const expectedKey = process.env.MCP_API_KEY;
  if (expectedKey && auth !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!vaultReader) return vaultUnavailable(res);

  const { machine, job, note } = req.body || {};
  if (!machine || !job) {
    return res.status(400).json({ error: '"machine" and "job" are required' });
  }

  try {
    const result = await vaultReader.closeHeartbeatAlerts(machine, job, {
      note: note || 'Source recovered — auto-closed on recovery detection.',
      closedBy: 'auto-recovery',
    });

    if (result.closed > 0) {
      // Commit the changes to vault so they're durable
      const syncMsg = `spike: auto-close alert ${job} on ${machine} — recovered`;
      const synced = await vaultSync(syncMsg);
      return res.json({
        ok: true,
        closed: result.closed,
        files: result.files,
        synced: synced.ok,
        syncWarning: synced.ok ? null : synced.stderr,
      });
    } else {
      return res.json({
        ok: true,
        closed: 0,
        files: [],
        message: 'No open heartbeat alerts found for this machine/job combination.',
      });
    }
  } catch (err) {
    console.error(`[alerts/close-by-job] error: ${err.message}`);
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

// GET /api/vault/task?path=<vault-relative-path>  — read individual task file
app.get('/api/vault/task', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const relPath = (req.query.path || '').trim().replace(/\.\./g, '');
  if (!relPath) return res.status(400).json({ error: 'path required' });
  try {
    const task = await vaultReader.getTaskFile(relPath);
    res.json(task);
  } catch (err) {
    const code = err.message.includes('scope') ? 403 : (err.code === 'ENOENT' ? 404 : 500);
    res.status(code).json({ error: err.message });
  }
});

// POST /api/vault/task?path=<vault-relative-path>  — update task frontmatter + vault-sync
app.post('/api/vault/task', async (req, res) => {
  if (!vaultReader) return vaultUnavailable(res);
  const relPath = (req.query.path || '').trim().replace(/\.\./g, '');
  if (!relPath) return res.status(400).json({ error: 'path required' });
  const updates = req.body || {};
  try {
    await vaultReader.updateTaskFile(relPath, updates);
    const taskBase = require('path').basename(relPath, '.md');
    const synced   = await vaultSync(`task: update ${taskBase.slice(0, 80)}`);
    res.json({ ok: true, synced: synced.ok, syncWarning: synced.ok ? null : synced.stderr });
  } catch (err) {
    const code = err.message.includes('scope') ? 403 : 500;
    res.status(code).json({ error: err.message });
  }
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
      Spike:  ['OpenClaw'],
      Steve:  ['BrightMove-MBP'],
      Lex:    ['BrightMove-MBP/Cursor'],
      Bill:   ['H2FClanker1'],
      Luther: ['Grok-Bot/Luther', 'Grok-Bot'],
      Peter:  ['Grok-Bot/Peter'],
      Buster: ['Grok-Bot/Buster'],
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

// ---------------------------------------------------------------------------
// GET /api/swarm/summary — combined swarm snapshot (BrainStore-native)
// ---------------------------------------------------------------------------
app.get('/api/swarm/summary', async (req, res) => {
  try {
    // Task board + agent registry from BrainStore
    let taskBoard = { inbox:[], inProgress:[], blocked:[], done:[], stats:{} };
    let agents = [];
    if (brainStore) {
      const boardDoc = brainStore.getDoc('03 - Agents/Coordination/Task Board.md');
      if (boardDoc) {
        const { parseTaskBoardSimple, parseAgentRegistrySimple } = require('./lib/McpServer');
        // Use BrainStore stats directly
        const searchRows = brainStore.listDir('03 - Agents', { recursive: false });
        // Parse task board markdown
        const boardLines = boardDoc.content.split('\n');
        const sectionAliases = {
          inbox: ['inbox'], inProgress: ['in progress','in-progress'],
          blocked: ['blocked'], done: ['done'],
        };
        let curSection = null;
        const sectionMap = {};
        for (const line of boardLines) {
          const m = line.match(/^##\s+(.+)/);
          if (m) {
            curSection = m[1].trim().toLowerCase();
            sectionMap[curSection] = sectionMap[curSection] || [];
          } else if (curSection) {
            sectionMap[curSection].push(line);
          }
        }
        for (const [heading, lines] of Object.entries(sectionMap)) {
          let key = null;
          if (sectionAliases.inbox.some(a => heading.includes(a))) key = 'inbox';
          else if (sectionAliases.inProgress.some(a => heading.includes(a))) key = 'inProgress';
          else if (sectionAliases.blocked.some(a => heading.includes(a))) key = 'blocked';
          else if (sectionAliases.done.some(a => heading.includes(a))) key = 'done';
          if (!key) continue;
          const rows = [];
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('|') || /^\|[\s\-:]+\|/.test(t)) continue;
            const cells = t.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
            rows.push(cells);
          }
          taskBoard[key] = rows.slice(1).map(cells => {
            if (!cells[0]) return null;
            const m2 = cells[0].match(/TASK-[A-Z0-9]+-\d+/);
            const taskId = m2 ? m2[0] : cells[0].replace(/\*\*/g,'').trim();
            if (!taskId || /^[\s\-–—|]+$/.test(taskId)) return null;
            return { taskId, title: (cells[1]||'').replace(/\*\*/g,'').trim(), agent: (cells[2]||'').trim() };
          }).filter(Boolean);
        }
        taskBoard.stats = {
          total: taskBoard.inbox.length + taskBoard.inProgress.length + taskBoard.blocked.length + taskBoard.done.length,
          inbox: taskBoard.inbox.length, inProgress: taskBoard.inProgress.length,
          blocked: taskBoard.blocked.length, done: taskBoard.done.length,
        };
        const agentDoc = brainStore.getDoc('03 - Agents/Agent Registry.md');
        if (agentDoc) {
          const lines2 = agentDoc.content.split('\n');
          let inTable = false, header = null;
          for (const line of lines2) {
            const t = line.trim();
            if (!t.startsWith('|')) { if (inTable) break; continue; }
            if (/^\|[\s\-:|]+\|/.test(t)) continue;
            const cells = t.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
            if (!inTable) {
              if (cells.map(c=>c.toLowerCase()).some(c=>c.includes('nickname'))) {
                inTable = true; header = cells.map(c=>c.toLowerCase().replace(/\s+/g,'_'));
              }
              continue;
            }
            if (cells.every(c=>c===''||c==='-')) continue;
            const a = {}; header.forEach((k,i)=>{ a[k]=(cells[i]||'').replace(/\*\*/g,'').trim(); });
            agents.push(a);
          }
        }
      }
    }

    // Heartbeats + heatmap still from VaultReader (filesystem scan)
    let heartbeats = [], heatmap = { days:[], agents:[] }, alerts = [];
    if (vaultReader) {
      [heartbeats, heatmap, alerts] = await Promise.all([
        vaultReader.getHeartbeats({ limit: 200 }).catch(() => []),
        vaultReader.getActivityHeatmap().catch(() => ({ days:[], agents:[] })),
        vaultReader.getAlerts().catch(() => []),
      ]);
    }

    // Last-heartbeat-per-machine map
    const lastHeartbeat = {};
    for (const hb of heartbeats) {
      const key = hb.subAgent ? `${hb.machine}/${hb.subAgent}` : hb.machine;
      if (!lastHeartbeat[key] || (hb.date || '') > (lastHeartbeat[key].date || ''))
        lastHeartbeat[key] = hb;
    }

    // Flag stuck in-progress tasks (>48h with no deadline)
    const now = Date.now();
    (taskBoard.inProgress || []).forEach(t => flagStuckTask(t, now));
    if (taskBoard.stats) taskBoard.stats.stuck = (taskBoard.inProgress||[]).filter(t=>t.isStuck).length;

    const brainStats = brainStore ? brainStore.stats() : null;

    res.json({ taskBoard, agents, heartbeats, heatmap, alerts, lastHeartbeat, brainStats, brainActivity: brainStore ? brainStore.getAgentActivitySummary() : [] });
  } catch (err) {
    console.error('[swarm/summary] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/security/swarm-posture — live AI swarm security posture checks
app.get('/api/security/swarm-posture', async (req, res) => {
  const { execSync } = require('child_process');
  const HOME = process.env.HOME;
  const safe      = (fn, fb = null) => { try { return fn(); } catch { return fb; } };
  const safeAsync = async (fn, fb = null) => { try { return await fn(); } catch { return fb; } };

  // ── SECRETS & CREDENTIALS ──────────────────────────────────────────────────
  const bwKeyPath = path.join(HOME, '.config/bitwarden/master.key');
  const bwKeyStat = await safeAsync(() => fs.stat(bwKeyPath));
  const bwKeyMode = bwKeyStat ? (bwKeyStat.mode & 0o777).toString(8).padStart(3, '0') : null;

  const rotationPolicyExists = vaultReader
    ? await safeAsync(async () => { await vaultReader.getFile('08 - QA-and-Monitoring/Security/Credential-Rotation-Policy.md'); return true; }, false)
    : null;

  // ── NETWORK EXPOSURE ───────────────────────────────────────────────────────
  const ssOut       = safe(() => execSync('ss -tlnp 2>/dev/null', { timeout: 4000 }).toString(), '');
  const gwPortLines = ssOut.split('\n').filter(l => l.includes('18789') || l.includes('8355'));
  // OpenClaw (18789) exposure — flag if listening on 0.0.0.0 (should be localhost-only)
  const openclawExposed   = gwPortLines.filter(l => l.includes('18789')).some(l => /\b0\.0\.0\.0:/.test(l));
  // OverClaw (8355) — 0.0.0.0 binding is intentional (LAN access per design decision 2026-09-02)
  const overclawLanAccess = gwPortLines.filter(l => l.includes('8355')).some(l => /\b0\.0\.0\.0:/.test(l));
  const gatewayExposed    = openclawExposed; // LAN-intentional OverClaw binding does not count as exposed

  const tailscaleActive = safe(() =>
    execSync('systemctl is-active tailscaled 2>/dev/null', { timeout: 3000 }).toString().trim() === 'active', false);
  const tailscaleIP = safe(() =>
    execSync('tailscale ip --4 2>/dev/null', { timeout: 3000 }).toString().trim() || null, null);

  // ── HOST HARDENING ─────────────────────────────────────────────────────────
  const sshConf = await safeAsync(() => fs.readFile('/etc/ssh/sshd_config', 'utf-8'), '');
  const sshPasswordAuth = !sshConf ? 'unknown'
    : /^\s*PasswordAuthentication\s+yes\b/im.test(sshConf) ? 'enabled'
    : /^\s*PasswordAuthentication\s+no\b/im.test(sshConf)  ? 'disabled'
    : 'unknown';
  const sshRootLogin = !sshConf ? 'unknown'
    : /^\s*PermitRootLogin\s+no\b/im.test(sshConf)               ? 'no'
    : /^\s*PermitRootLogin\s+prohibit-password\b/im.test(sshConf) ? 'prohibit-password'
    : /^\s*PermitRootLogin\s+yes\b/im.test(sshConf)              ? 'yes'
    : 'default';

  const ufwConf   = await safeAsync(() => fs.readFile('/etc/ufw/ufw.conf', 'utf-8'), '');
  const ufwActive = ufwConf
    ? /^\s*ENABLED\s*=\s*yes\b/im.test(ufwConf)
    : safe(() => execSync('systemctl is-active ufw 2>/dev/null', { timeout: 3000 }).toString().trim() === 'active', null);

  const updatesStr    = safe(() => execSync('apt list --upgradable 2>/dev/null | tail -n +2 | wc -l', { timeout: 8000 }).toString().trim(), null);
  const pendingUpdates = updatesStr !== null ? parseInt(updatesStr, 10) : null;

  // ── AUDIT TRAIL ────────────────────────────────────────────────────────────
  const hbStatePath    = path.join(HOME, '.openclaw/workspace/memory/heartbeat-state.json');
  const heartbeatState = await safeAsync(async () => JSON.parse(await fs.readFile(hbStatePath, 'utf-8')), null);

  const overclawLogsDir  = path.join(HOME, 'repos/overclaw/logs');
  const overclawLogCount = await safeAsync(async () => (await fs.readdir(overclawLogsDir)).length, null);

  // ── PROMPT INJECTION ───────────────────────────────────────────────────────
  const billPromptPath   = path.join(HOME, 'My-AI-Brain/03 - Agents/Bill/system-prompt.md');
  const lexPromptPath    = path.join(HOME, 'My-AI-Brain/03 - Agents/Lex/system-prompt.md');
  const billPromptExists = await safeAsync(async () => { await fs.access(billPromptPath); return true; }, false);
  const lexPromptExists  = await safeAsync(async () => { await fs.access(lexPromptPath); return true; }, false);

  // ── AGENT OVER-PRIVILEGE ───────────────────────────────────────────────────
  const accessPolicyExists = vaultReader
    ? await safeAsync(async () => { await vaultReader.getFile('03 - Agents/Coordination/Agent-Access-Policy.md'); return true; }, false)
    : null;

  const sshKeyFiles = await safeAsync(() => fs.readdir(path.join(HOME, '.ssh')), []);
  const deployKeys  = (sshKeyFiles || []).filter(f => /^(deploy_|id_deploy)/.test(f));

  res.json({
    generatedAt: new Date().toISOString(),
    credentials: {
      bwKeyExists:          !!bwKeyStat,
      bwKeyMode,
      bwKeySecure:          bwKeyMode === '600',
      rotationPolicyExists: rotationPolicyExists === null ? null : !!rotationPolicyExists,
      sharedPatRisk:        true,
    },
    network: {
      tailscaleActive,
      tailscaleIP,
      gatewayExposed,        // true only if OpenClaw (18789) binds 0.0.0.0
      openclawExposed,       // OpenClaw gateway 0.0.0.0 binding check
      overclawLanAccess,     // OverClaw 0.0.0.0 binding — intentional LAN design
      overclawLanIntentional: true,
      portLines: gwPortLines.slice(0, 6),
    },
    hostHardening: {
      sshPasswordAuth,
      sshRootLogin,
      ufwActive,
      pendingUpdates,
    },
    auditTrail: {
      heartbeatActive:        !!heartbeatState,
      heartbeatLastEmail:     heartbeatState?.lastChecks?.email ?? null,
      gitleaksScheduleActive: true,
      overclawLogCount,
    },
    promptInjection: {
      openclawGuard:    true,
      billGuard:        false,
      lexGuard:         false,
      billPromptExists,
      lexPromptExists,
    },
    agentPrivilege: {
      accessPolicyExists,
      sharedPatInUse:  true,
      deployKeysCount: deployKeys.length,
      deployKeyNames:  deployKeys,
    },
  });
});

// ---------------------------------------------------------------------------
// Vault path → OverClaw feature route mapper
// ---------------------------------------------------------------------------
function mapVaultPathToOverclaw(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (/Task Board/i.test(p))                             return '/task-board';
  if (/03 - Agents\/Agent Registry/i.test(p))            return '/agents';
  if (/03 - Agents\/Coordination/i.test(p))              return '/task-board';
  if (/03 - Agents\/Notifications/i.test(p))             return '/agents';
  if (/03 - Agents\//i.test(p))                          return '/agents';
  if (/08 - QA-and-Monitoring\/Heartbeats/i.test(p))     return '/activity';
  if (/08 - QA-and-Monitoring/i.test(p))                 return '/activity';
  if (/06 - Loops/i.test(p))                             return '/scheduled-tasks';
  if (/02 - Projects/i.test(p))                          return '/task-board';
  return `/vault/doc?path=${encodeURIComponent(p)}`;
}

// Global brain search page
app.get('/search', (req, res) => res.redirect('/brain?q=' + (req.query.q || '')));


app.get('/api/vault/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length < 2) {
    return res.json({ results: [], query, total: 0 });
  }

  const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash', '_Archive', '.DS_Store']);
  const results = [];
  const lowerQuery = query.toLowerCase();

  async function walkDir(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const matchingLines = [];
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(lowerQuery)) {
              matchingLines.push({ lineNo: idx + 1, text: line.trim().slice(0, 220) });
            }
          });
          if (matchingLines.length > 0) {
            const relPath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, '/');
            results.push({
              path: relPath,
              title: path.basename(fullPath, '.md'),
              folder: path.dirname(relPath),
              snippets: matchingLines.slice(0, 4),
              totalMatches: matchingLines.length,
              overclawLink: mapVaultPathToOverclaw(relPath),
              docLink: `/vault/doc?path=${encodeURIComponent(relPath)}`,
            });
          }
        } catch { /* skip unreadable */ }
      }
    }
  }

  try {
    await walkDir(VAULT_PATH);
    results.sort((a, b) => b.totalMatches - a.totalMatches);
    res.json({ results: results.slice(0, 60), query, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GAP ATLAS — blind-spot map for the swarm
// ---------------------------------------------------------------------------
const ATLAS_JSON_PATH  = path.join(VAULT_PATH, '08 - QA-and-Monitoring', 'ATLAS', 'atlas.json');
const ATLAS_GAPS_DIR   = path.join(VAULT_PATH, '08 - QA-and-Monitoring', 'ATLAS', 'gaps');

async function readAtlasFile() {
  try {
    const text = await fs.readFile(ATLAS_JSON_PATH, 'utf-8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, updated: null, description: '', regions: [], gaps: [] };
    throw err;
  }
}

async function writeAtlasFile(atlas) {
  await fs.mkdir(path.dirname(ATLAS_JSON_PATH), { recursive: true });
  await fs.writeFile(ATLAS_JSON_PATH, JSON.stringify(atlas, null, 2), 'utf-8');
}

app.get('/gap-atlas', (req, res) => {
  res.render('gap-atlas', {
    title: 'GAP ATLAS — OverClaw',
    currentPath: '/gap-atlas',
  });
});

app.get('/api/gap/atlas', async (req, res) => {
  try {
    const atlas = await readAtlasFile();
    res.json({ ok: true, atlas, lastSyncAt: vaultReader ? vaultReader.lastSyncAt : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/gap/record', async (req, res) => {
  const { region, agent, taskId, title, note } = req.body || {};
  if (!region || !title) {
    return res.status(400).json({ ok: false, error: 'region and title are required' });
  }
  try {
    const atlas = await readAtlasFile();
    const today       = new Date().toISOString().slice(0, 10);
    const compact     = today.replace(/-/g, '');
    const todayCount  = (atlas.gaps || []).filter(g => g.id && g.id.startsWith(`GAP-${compact}`)).length;
    const seq         = String(todayCount + 1).padStart(3, '0');
    const id          = `GAP-${compact}-${seq}`;

    const gap = {
      id,
      date:   today,
      taskId: taskId || null,
      region,
      agent:  agent || 'Spike',
      title,
      note:   note || '',
    };
    if (!Array.isArray(atlas.gaps)) atlas.gaps = [];
    atlas.gaps.push(gap);
    atlas.updated = today;

    // Increment region hit count
    const reg = (atlas.regions || []).find(r => r.id === region);
    if (reg) {
      reg.hitCount = (reg.hitCount || 0) + 1;
      reg.lastHit  = today;
    }

    await writeAtlasFile(atlas);

    // Write individual gap markdown
    await fs.mkdir(ATLAS_GAPS_DIR, { recursive: true });
    const gapMd = [
      `# ${id} — ${title}`,
      '',
      `**Date:** ${today}`,
      `**Region:** ${region}`,
      `**Agent:** ${agent || 'Spike'}`,
      `**Task:** ${taskId || '—'}`,
      '',
      '## Note',
      note || '—',
      '',
    ].join('\n');
    await fs.writeFile(path.join(ATLAS_GAPS_DIR, `${id}.md`), gapMd, 'utf-8');

    // Vault sync
    try { await vaultSync(`gap: record ${id} (${region})`); } catch (syncErr) {
      console.warn(`GAP: vault sync failed — ${syncErr.message}`);
    }

    res.json({ ok: true, gap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// MCP Server — Model Context Protocol endpoints for swarm agents
// Docs: GET /mcp   Streamable-HTTP: POST /mcp   SSE: GET /mcp/sse
// ---------------------------------------------------------------------------

const MCP_API_KEY = process.env.MCP_API_KEY || ocConfig.mcpApiKey || null;

const mcpServer = vaultReader
  ? new McpServer({ vaultReader, vaultPath: VAULT_PATH, clawBridge, brainStore })
  : (brainStore ? new McpServer({ vaultReader: null, vaultPath: VAULT_PATH, clawBridge, brainStore }) : null);

/** Require Bearer token or X-Api-Key when MCP_API_KEY is configured. */
function mcpAuth(req, res, next) {
  if (!MCP_API_KEY) return next();           // no key = open on LAN/Tailscale
  const auth = req.headers.authorization || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7).trim()
             : (req.headers['x-api-key'] || '').trim();
  if (key !== MCP_API_KEY)
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  next();
}

/** CORS preflight for /mcp/* — agents on other hosts need this. */
app.options('/mcp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.sendStatus(204);
});
app.options('/mcp/:any*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.sendStatus(204);
});

/**
 * GET /mcp — discovery endpoint.
 * Returns server info, available tools, transport URLs, and auth requirements.
 */
app.get('/mcp', mcpAuth, (req, res) => {
  const tools = mcpServer ? mcpServer.tools() : [];
  res.json({
    name:        'OverClaw MCP Server',
    version:     '2.0.0',
    description: 'Swarm task board and coordination tools for AI agents',
    protocols:   ['2024-11-05', '2025-03-26'],
    transports: {
      streamableHttp: { method: 'POST', url: '/mcp',         note: 'MCP 2025-03-26, preferred' },
      sse:            { method: 'GET',  url: '/mcp/sse',      note: 'MCP 2024-11-05, for Cursor/legacy clients' },
      sseMessage:     { method: 'POST', url: '/mcp/message',  note: 'SSE transport message endpoint' },
    },
    auth: MCP_API_KEY ? 'Bearer token required (Authorization: Bearer <key> or X-Api-Key header)' : 'Open (no auth required)',
    tools: tools.map(t => ({ name: t.name, description: t.description })),
    available: !!mcpServer,
  });
});

/**
 * POST /mcp — Streamable HTTP transport (MCP 2025-03-26).
 * Single endpoint for all JSON-RPC messages; supports single and batch.
 */
app.post('/mcp', mcpAuth, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!mcpServer)
    return res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP server not available (vault not loaded)' } });

  const body = req.body;
  if (!body) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: empty body' } });

  try {
    const ctx = { agentName: req.headers['x-agent-name'] || 'agent' };
    // Batch requests
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map(msg => mcpServer.dispatch(msg, ctx)))).filter(r => r !== null);
      return res.json(results);
    }
    if (body.jsonrpc !== '2.0')
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });

    const result = await mcpServer.dispatch(body, ctx);
    // Notifications (no id) — 202 with no body
    if (result === null) return res.status(202).end();
    res.json(result);
  } catch (err) {
    console.error('[MCP POST] error:', err.message);
    res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } });
  }
});

/**
 * GET /mcp/sse — SSE transport (MCP 2024-11-05).
 * Client connects here; server sends an `endpoint` event with the POST URL,
 * then keeps the stream open for response delivery.
 */
app.get('/mcp/sse', mcpAuth, (req, res) => {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!mcpServer) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Vault not available' })}\n\n`);
    return res.end();
  }

  const sessionId = mcpServer.attachSse(res);
  req.on('close', () => mcpServer.detachSse(sessionId));
});

/**
 * POST /mcp/message — SSE transport message handler (MCP 2024-11-05).
 * Client sends JSON-RPC here; server returns 202 immediately and pushes
 * the response over the SSE stream.
 */
app.post('/mcp/message', mcpAuth, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!mcpServer)
    return res.status(503).json({ error: 'MCP server not available' });

  const { sessionId } = req.query;
  const body = req.body;

  if (!body || body.jsonrpc !== '2.0')
    return res.status(400).json({ error: 'Invalid JSON-RPC 2.0 request' });

  // Ack immediately so the client knows the message was received
  res.status(202).end();

  try {
    const result = await mcpServer.dispatch(body);
    if (result !== null && sessionId) {
      mcpServer.sendSse(sessionId, result);
    }
  } catch (err) {
    console.error('[MCP SSE message] error:', err.message);
    if (sessionId) {
      mcpServer.sendSse(sessionId, {
        jsonrpc: '2.0', id: body.id ?? null,
        error: { code: -32603, message: err.message },
      });
    }
  }
});

// ---------------------------------------------------------------------------
// REST agent API — simple HTTP shortcuts for non-MCP agents (Bill, Steve, etc.)
// These endpoints wrap the same MCP tool logic but speak plain REST.
// ---------------------------------------------------------------------------

/** Auth for REST agent API — same key as MCP, or open if no key set. */
const agentApiAuth = mcpAuth;

/**
 * GET /api/agent/tasks?agent=<shortname>[&status=inbox|in_progress|blocked|all]
 * Returns tasks assigned to the agent, grouped by section.
 */
app.get('/api/agent/tasks', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const agent  = (req.query.agent  || '').toLowerCase();
  const status = (req.query.status || 'all');
  if (!agent) return res.status(400).json({ error: 'agent query param required' });
  try {
    const result = await mcpServer._getMyTasks({ agent, status });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/agent/tasks/:taskId/claim
 * Body: { agent }
 */
app.post('/api/agent/tasks/:taskId/claim', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const { agent } = req.body || {};
  if (!agent) return res.status(400).json({ error: 'agent required in body' });
  try {
    const result = await mcpServer._claimTask({ taskId: req.params.taskId, agent });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/agent/tasks/:taskId/complete
 * Body: { agent, output }
 */
app.post('/api/agent/tasks/:taskId/complete', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const { agent, output } = req.body || {};
  if (!agent || !output) return res.status(400).json({ error: 'agent and output required in body' });
  try {
    const result = await mcpServer._completeTask({ taskId: req.params.taskId, agent, output });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/agent/tasks/:taskId/block
 * Body: { agent, reason }
 */
app.post('/api/agent/tasks/:taskId/block', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const { agent, reason } = req.body || {};
  if (!agent || !reason) return res.status(400).json({ error: 'agent and reason required in body' });
  try {
    const result = await mcpServer._blockTask({ taskId: req.params.taskId, agent, reason });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/agent/tasks/:taskId/note
 * Body: { agent, note }
 */
app.post('/api/agent/tasks/:taskId/note', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const { agent, note } = req.body || {};
  if (!agent || !note) return res.status(400).json({ error: 'agent and note required in body' });
  try {
    const result = await mcpServer._addTaskNote({ taskId: req.params.taskId, agent, note });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/agent/notifications?agent=<shortname>
 * Returns unread notification files.
 */
app.get('/api/agent/notifications', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const agent = (req.query.agent || '').toLowerCase();
  if (!agent) return res.status(400).json({ error: 'agent query param required' });
  try {
    const result = await mcpServer._getNotifications({ agent });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/agent/notifications/handled
 * Body: { agent, filename }
 */
app.post('/api/agent/notifications/handled', agentApiAuth, async (req, res) => {
  if (!mcpServer) return vaultUnavailable(res);
  const { agent, filename } = req.body || {};
  if (!agent || !filename) return res.status(400).json({ error: 'agent and filename required in body' });
  try {
    const result = await mcpServer._markNotificationHandled({ agent, filename });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Simple /status route
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Background vault sync REMOVED
// ---------------------------------------------------------------------------
// vault-sync / git pull is no longer used. All writes go through BrainStore.
// VaultReader is kept for heartbeat scanning only (read-only filesystem).

// ---------------------------------------------------------------------------
// Brain Auth middleware — bearer token (agents) OR session cookie (users)
// ---------------------------------------------------------------------------
function brainAuth(req, res, next) {
  // 1. Bearer token (agents)
  const auth = req.headers.authorization || '';
  const bearerKey = auth.startsWith('Bearer ') ? auth.slice(7).trim()
                  : (req.headers['x-api-key'] || '').trim();
  if (MCP_API_KEY && bearerKey === MCP_API_KEY) {
    req.brainActor = { type: 'agent', name: req.headers['x-agent-name'] || 'agent' };
    return next();
  }
  // 2. Session cookie (browser users)
  if (brainStore) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token   = cookies['brain_session'];
    if (token) {
      const session = brainStore.getSession(token);
      if (session) {
        req.brainActor = { type: 'user', name: session.username, role: session.role };
        return next();
      }
    }
  }
  // Neither bearer nor session — redirect browsers, reject API callers
  const wantsBrowser = !auth && (req.headers.accept || '').includes('text/html');
  if (wantsBrowser) {
    return res.redirect('/brain/login?next=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function parseCookies(str) {
  const out = {};
  for (const part of str.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth routes — /auth/login, /auth/logout, /auth/me
// ---------------------------------------------------------------------------
const bcrypt = require('bcrypt');

app.post('/auth/login', async (req, res) => {
  if (!brainStore) return res.status(503).json({ error: 'BrainStore unavailable' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = brainStore.getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  brainStore.createSession({ token, userId: user.id, ip: req.ip });
  brainStore.updateLastLogin(user.id);
  res.setHeader('Set-Cookie',
    `brain_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}`);
  res.json({ ok: true, username: user.username, role: user.role });
});

app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies['brain_session'] && brainStore) {
    brainStore.deleteSession(cookies['brain_session']);
  }
  res.setHeader('Set-Cookie', 'brain_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/auth/me', brainAuth, (req, res) => {
  res.json({ actor: req.brainActor });
});

// ---------------------------------------------------------------------------
// Brain REST API — /api/brain/*
// ---------------------------------------------------------------------------

function requireBrain(req, res) {
  if (!brainStore) { res.status(503).json({ error: 'BrainStore unavailable' }); return false; }
  return true;
}

// GET /api/brain/doc?path=
app.get('/api/brain/doc', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const docPath = req.query.path;
  if (!docPath) return res.status(400).json({ error: 'path required' });
  const agentName = req.brainActor?.name || 'unknown';
  try {
    const doc = brainStore.getDoc(docPath);
    if (!doc) {
      brainStore.logActivity(agentName, 'read', docPath, false);
      return res.status(404).json({ error: 'Not found' });
    }
    brainStore.logActivity(agentName, 'read', docPath, true);
    res.json(doc);
  } catch (err) {
    brainStore.logActivity(agentName, 'read', docPath, false);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/brain/doc?path=  body: { content, changeNote? }
app.put('/api/brain/doc', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const docPath = req.query.path;
  if (!docPath) return res.status(400).json({ error: 'path required' });
  const { content, changeNote } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });
  const updatedBy = req.brainActor?.name || 'unknown';
  try {
    const result = brainStore.putDoc(docPath, content, { updatedBy, changeNote });
    brainStore.logActivity(updatedBy, 'write', docPath);
    res.json({ ok: true, ...result, path: docPath });
  } catch (err) {
    console.error('[brain PUT] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/brain/doc?path=
app.delete('/api/brain/doc', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const docPath = req.query.path;
  if (!docPath) return res.status(400).json({ error: 'path required' });
  const result = brainStore.deleteDoc(docPath);
  res.json({ ok: true, ...result });
});

// POST /api/brain/move  body: { from, to }
app.post('/api/brain/move', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const result = brainStore.moveDoc(from, to, { updatedBy: req.brainActor?.name || 'unknown' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/brain/list?dir=&recursive=
app.get('/api/brain/list', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const dir       = req.query.dir || '';
  const recursive = req.query.recursive === 'true' || req.query.recursive === '1';
  const items     = brainStore.listDir(dir, { recursive });
  res.json({ dir, items });
});

// GET /api/brain/tree?dir=
app.get('/api/brain/tree', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const dir  = req.query.dir || '';
  const tree = brainStore.getTree(dir);
  res.json(tree);
});

// GET /api/brain/search?q=&dir=&limit=
app.get('/api/brain/search', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const q     = req.query.q || '';
  const dir   = req.query.dir || '';
  const limit = parseInt(req.query.limit) || 20;
  if (!q.trim()) return res.status(400).json({ error: 'q required' });
  const results = brainStore.search(q, { limit, dir });
  res.json({ q, results });
});

// GET /api/brain/history?path=&limit=
app.get('/api/brain/history', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const docPath = req.query.path;
  if (!docPath) return res.status(400).json({ error: 'path required' });
  const limit   = parseInt(req.query.limit) || 50;
  const history = brainStore.getHistory(docPath, { limit });
  res.json({ path: docPath, history });
});

// GET /api/brain/version?path=&v=
app.get('/api/brain/version', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const docPath = req.query.path;
  const version = parseInt(req.query.v);
  if (!docPath || !version) return res.status(400).json({ error: 'path and v required' });
  const ver = brainStore.getVersion(docPath, version);
  if (!ver) return res.status(404).json({ error: 'Version not found' });
  res.json(ver);
});

// POST /api/brain/restore  body: { path, version }
app.post('/api/brain/restore', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  const { path: docPath, version } = req.body || {};
  if (!docPath || !version) return res.status(400).json({ error: 'path and version required' });
  try {
    const result = brainStore.restoreVersion(docPath, version, { updatedBy: req.brainActor?.name || 'unknown' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/brain/stats
app.get('/api/brain/stats', brainAuth, (req, res) => {
  if (!requireBrain(req, res)) return;
  res.json(brainStore.stats());
});

// Browser UI routes
app.get('/brain', brainAuth, (req, res) => {
  res.render('brain-browse', { title: 'AI Brain', actor: req.brainActor });
});
app.get('/brain/doc', (req, res) => {
  // Redirect /brain/doc?path=... → /brain?path=... (brain-browse is the unified editor)
  const target = '/brain' + (req.query.path ? '?path=' + encodeURIComponent(req.query.path) : '');
  res.redirect(302, target);
});
app.get('/brain/history', brainAuth, (req, res) => {
  res.render('brain-history', { title: 'AI Brain — History', actor: req.brainActor, docPath: req.query.path || '' });
});
app.get('/brain/login', (req, res) => {
  res.render('brain-login', { title: 'OverClaw — Sign In' });
});

// ---------------------------------------------------------------------------
// Start the server
const bindHost = process.env.BIND_HOST || ocConfig.bindHost || '127.0.0.1';
app.listen(port, bindHost, () => {
  console.log(`OverClaw running at http://${bindHost}:${port}`);
});
