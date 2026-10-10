'use strict';

/**
 * McpServer.js — OverClaw MCP (Model Context Protocol) Server
 *
 * Exposes the swarm task board to agents via the Model Context Protocol.
 * Implements JSON-RPC 2.0 over HTTP.
 *
 * Transports:
 *   Streamable HTTP (MCP 2025-03-26): POST /mcp
 *   SSE transport   (MCP 2024-11-05): GET /mcp/sse  +  POST /mcp/message
 *   Discovery:                        GET /mcp
 *
 * Tools (10):
 *   get_my_tasks              — tasks assigned to an agent, by section
 *   get_task_board            — full board snapshot
 *   get_task                  — read a task file
 *   claim_task                — inbox → in_progress
 *   complete_task             — in_progress/blocked → done
 *   block_task                — in_progress/inbox → blocked
 *   add_task_note             — append progress note to task file
 *   list_agents               — agent registry
 *   get_notifications         — unread notification files for an agent
 *   mark_notification_handled — rename notification file to HANDLED-*
 */

const path     = require('path');
const fs       = require('fs').promises;
const crypto   = require('crypto');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = '2024-11-05';

const AGENT_DISPLAY = {
  spike:  'Spike',
  steve:  'Steve',
  lex:    'Lex',
  bill:   'Bill',
  jimmy:  'Jimmy',
  luther: 'Luther',
};

// ---------------------------------------------------------------------------
// Pure task-board string-manipulation helpers
// Operate on raw markdown content string; always return updated string.
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowET() {
  return new Date().toLocaleString('en-US', {
    timeZone:  'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Find a task row in specific sections of the markdown.
 * Returns { rowIdx, rowCells, sec } or null.
 */
function findRow(lines, taskId, ...sectionKeywords) {
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (hm) { sec = hm[1].toLowerCase(); continue; }
    if (!sec) continue;
    if (!sectionKeywords.some(k => sec.includes(k))) continue;
    if (!t.startsWith('|')) continue;
    if (/^\|[\s\-:]+\|/.test(t)) continue;                       // separator row
    if (!t.toUpperCase().includes(taskId.toUpperCase())) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    return { rowIdx: i, rowCells: cells, sec };
  }
  return null;
}

/** Find the separator row index of a section. */
function findSepIdx(lines, ...sectionKeywords) {
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (hm) { sec = hm[1].toLowerCase(); continue; }
    if (!sec) continue;
    if (sectionKeywords.some(k => sec.includes(k)) && /^\|[\s\-:]+\|/.test(t)) return i;
  }
  return -1;
}

/** Find the heading line index of a section. */
function findHeadingIdx(lines, ...sectionKeywords) {
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const t  = lines[i].trim();
    const hm = t.match(/^##\s+(.*)/);
    if (!hm) continue;
    sec = hm[1].toLowerCase();
    if (sectionKeywords.some(k => sec.includes(k))) return i;
  }
  return -1;
}

/** Insert a row after the separator of a section (or create the section). */
function insertRow(lines, row, sep, heading, headerRow, separatorRow) {
  if (sep >= 0) {
    lines.splice(sep + 1, 0, row);
  } else {
    const hi = heading >= 0 ? heading : -1;
    const tbl = ['', headerRow, separatorRow, row];
    if (hi >= 0) lines.splice(hi + 1, 0, ...tbl);
    else lines.push(...tbl);
  }
}

/** Move task row from Inbox → In Progress. */
function moveToInProgress(content, taskId, agent) {
  const lines = content.split('\n');
  const found = findRow(lines, taskId, 'inbox');
  if (!found) throw new Error(`Task ${taskId} not found in Inbox`);
  const { rowIdx, rowCells } = found;
  const ipRow = `| ${rowCells[0]} | ${rowCells[1]} | ${agent} | ${today()} | ${rowCells[4] || '—'} |`;
  const nl    = lines.filter((_, i) => i !== rowIdx);
  const adj   = (idx) => idx > rowIdx ? idx - 1 : idx;
  const sep   = adj(findSepIdx(lines, 'progress'));
  const hi    = adj(findHeadingIdx(lines, 'progress'));
  insertRow(nl, ipRow, sep, hi,
    '| Task ID | Title | Agent | Started | Deadline |',
    '|---------|-------|-------|---------|----------|');
  return nl.join('\n');
}

/** Move task row from In Progress (or Inbox) → Blocked. */
function moveToBlocked(content, taskId, reason) {
  const lines = content.split('\n');
  const found = findRow(lines, taskId, 'progress', 'inbox');
  if (!found) throw new Error(`Task ${taskId} not found in In Progress or Inbox`);
  const { rowIdx, rowCells } = found;
  const bRow = `| ${rowCells[0]} | ${rowCells[1]} | ${rowCells[2] || '—'} | ${today()} | ${reason} |`;
  const nl   = lines.filter((_, i) => i !== rowIdx);
  const adj  = (idx) => idx > rowIdx ? idx - 1 : idx;
  const sep  = adj(findSepIdx(lines, 'blocked'));
  const hi   = adj(findHeadingIdx(lines, 'blocked'));
  insertRow(nl, bRow, sep, hi,
    '| Task ID | Title | Agent | Blocked Since | Reason |',
    '|---------|-------|-------|---------------|--------|');
  return nl.join('\n');
}

/** Move task row from In Progress or Blocked → Done. */
function moveToDone(content, taskId, agent, output) {
  const lines = content.split('\n');
  const found = findRow(lines, taskId, 'progress', 'blocked');
  if (!found) throw new Error(`Task ${taskId} not found in In Progress or Blocked`);
  const { rowIdx, rowCells } = found;
  const dRow = `| ${rowCells[0]} | ${rowCells[1]} | ${agent} | ${today()} | ${output.slice(0, 150)} |`;
  const nl   = lines.filter((_, i) => i !== rowIdx);
  const adj  = (idx) => idx > rowIdx ? idx - 1 : idx;
  const sep  = adj(findSepIdx(lines, 'done'));
  const hi   = adj(findHeadingIdx(lines, 'done'));
  insertRow(nl, dRow, sep, hi,
    '| Task ID | Title | Agent | Completed | Output |',
    '|---------|-------|-------|-----------|--------|');
  return nl.join('\n');
}

// ---------------------------------------------------------------------------
// McpServer class
// ---------------------------------------------------------------------------

class McpServer {
  /**
   * @param {object} opts
   * @param {object} opts.vaultReader  VaultReader instance (for reads)
   * @param {string} opts.vaultPath    Absolute path to vault root
   */
  constructor({ vaultReader, vaultPath }) {
    this.vaultReader = vaultReader;
    this.vaultPath   = vaultPath;
    this.boardPath   = path.join(vaultPath, '03 - Agents', 'Coordination', 'Task Board.md');
    this.tasksDir    = path.join(vaultPath, '03 - Agents', 'Coordination', 'Tasks');
    this.notifsDir   = path.join(vaultPath, '03 - Agents', 'Notifications');

    // SSE sessions: sessionId → { res, keepAlive }
    this._sseSessions = new Map();
  }

  // ── vault-sync ────────────────────────────────────────────────────────────

  _vaultSync(message) {
    const bin = path.join(process.env.HOME, '.local', 'bin', 'vault-sync');
    return new Promise(resolve =>
      execFile(bin, ['push', message], { timeout: 30_000 },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout?.trim(), stderr: stderr?.trim() })
      )
    );
  }

  // ── tool definitions ──────────────────────────────────────────────────────

  tools() {
    return [
      {
        name: 'get_my_tasks',
        description: [
          'Return all open tasks assigned to an agent, grouped by section (inbox, in_progress, blocked).',
          'Call this on startup to know what work is waiting. Filter by status to narrow results.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              description: 'Your agent shortname: spike | lex | bill | steve | luther | jimmy',
            },
            status: {
              type: 'string',
              enum: ['inbox', 'in_progress', 'blocked', 'all'],
              description: 'Section to filter (default: all)',
            },
          },
          required: ['agent'],
        },
      },
      {
        name: 'get_task_board',
        description: 'Get the full task board — all sections: inbox, in_progress, blocked, and optionally recent done tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            includeDone: {
              type: 'boolean',
              description: 'Include recent done tasks (default: false)',
            },
          },
        },
      },
      {
        name: 'get_task',
        description: 'Read the full markdown content and board metadata of a specific task.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID, e.g. TASK-20261008-001' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'claim_task',
        description: [
          'Claim a task from the Inbox — moves it to In Progress and assigns it to you.',
          'Always call this before starting work so the board stays accurate.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to claim' },
            agent:  { type: 'string', description: 'Your agent shortname' },
          },
          required: ['taskId', 'agent'],
        },
      },
      {
        name: 'complete_task',
        description: [
          'Mark a task as Done. Moves it from In Progress (or Blocked) to the Done section.',
          'Include a concise output summary — it will be shown in the Done table.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to complete' },
            agent:  { type: 'string', description: 'Your agent shortname' },
            output: { type: 'string', description: 'One-line summary of what was accomplished' },
          },
          required: ['taskId', 'agent', 'output'],
        },
      },
      {
        name: 'block_task',
        description: [
          'Mark a task as Blocked. Use when you cannot proceed and need human or other-agent intervention.',
          'Be specific about the blocker and what is needed to unblock.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to block' },
            agent:  { type: 'string', description: 'Your agent shortname' },
            reason: { type: 'string', description: 'Specific blocker + what is needed to unblock' },
          },
          required: ['taskId', 'agent', 'reason'],
        },
      },
      {
        name: 'add_task_note',
        description: 'Append a progress update or note to a task file without changing its board status.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID' },
            agent:  { type: 'string', description: 'Your agent shortname' },
            note:   { type: 'string', description: 'Note text to append' },
          },
          required: ['taskId', 'agent', 'note'],
        },
      },
      {
        name: 'list_agents',
        description: 'List all agents in the swarm with their roles, machines, and status.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_notifications',
        description: [
          'Check for unread task assignment and alert notifications for an agent.',
          'Returns filenames + previews. Always check this on startup.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Agent shortname to check notifications for' },
          },
          required: ['agent'],
        },
      },
      {
        name: 'mark_notification_handled',
        description: [
          'Mark a notification as handled by prefixing it HANDLED-.',
          'Always call this after reading and acting on a notification.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            agent:    { type: 'string', description: 'Agent shortname' },
            filename: { type: 'string', description: 'Notification filename (without directory path)' },
          },
          required: ['agent', 'filename'],
        },
      },
    ];
  }

  // ── tool handlers ─────────────────────────────────────────────────────────

  async _getMyTasks({ agent, status = 'all' }) {
    const board = await this.vaultReader.getTaskBoard();
    const al    = (agent || '').toLowerCase();
    const match = a => (a || '').toLowerCase() === al;

    const inbox      = ['in_progress', 'blocked'].includes(status) ? [] :
                       (board.inbox      || []).filter(t => match(t.assignedTo || t.agent));
    const inProgress = ['inbox', 'blocked'].includes(status)       ? [] :
                       (board.inProgress || []).filter(t => match(t.agent));
    const blocked    = ['inbox', 'in_progress'].includes(status)   ? [] :
                       (board.blocked    || []).filter(t => match(t.agent));

    const total = inbox.length + inProgress.length + blocked.length;
    return {
      agent,
      summary: `${total} open task${total !== 1 ? 's' : ''} for ${agent}: ` +
               `${inbox.length} inbox, ${inProgress.length} in progress, ${blocked.length} blocked`,
      inbox,
      inProgress,
      blocked,
    };
  }

  async _getTaskBoard({ includeDone = false } = {}) {
    const board = await this.vaultReader.getTaskBoard();
    return {
      stats:      board.stats      || {},
      inbox:      board.inbox      || [],
      inProgress: board.inProgress || [],
      blocked:    board.blocked    || [],
      done:       includeDone ? (board.done || []).slice(0, 20) : [],
    };
  }

  async _getTask({ taskId }) {
    const id      = taskId.trim().toUpperCase();
    const relPath = path.join('03 - Agents', 'Coordination', 'Tasks', `${id}.md`);
    const content = await this.vaultReader.getFile(relPath);

    // Look up board metadata
    const board = await this.vaultReader.getTaskBoard();
    const allTasks = [
      ...(board.inbox      || []),
      ...(board.inProgress || []),
      ...(board.blocked    || []),
      ...(board.done       || []),
    ];
    const entry = allTasks.find(t => {
      const raw = (t.id || t.taskId || '');
      const stripped = raw.replace(/\[([^\]]+)\]\([^)]+\)/, '$1').trim();
      return stripped.toUpperCase().includes(id) || id.includes(stripped.toUpperCase());
    });

    return { taskId: id, boardEntry: entry || null, content };
  }

  async _claimTask({ taskId, agent }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    let raw   = await fs.readFile(this.boardPath, 'utf-8');
    raw       = moveToInProgress(raw, id, al);
    await fs.writeFile(this.boardPath, raw, 'utf-8');
    await this._appendToTask(id, al,
      `## 🚀 Claimed\n\n**Agent:** ${al}  \n**Date:** ${today()} — claimed via MCP and moved to In Progress.\n`);
    const synced = await this._vaultSync(`task: ${al} claims ${id}`);
    return {
      ok: true, taskId: id, agent: al, status: 'in_progress',
      synced: synced.ok, message: `${id} moved to In Progress, assigned to ${al}`,
    };
  }

  async _completeTask({ taskId, agent, output }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    let raw   = await fs.readFile(this.boardPath, 'utf-8');
    raw       = moveToDone(raw, id, al, output);
    await fs.writeFile(this.boardPath, raw, 'utf-8');
    await this._appendToTask(id, al,
      `## ✅ Completed\n\n**Agent:** ${al}  \n**Date:** ${today()}  \n\n**Output:** ${output}\n`);
    const synced = await this._vaultSync(`task: ${al} completes ${id} — ${output.slice(0, 60)}`);
    return {
      ok: true, taskId: id, agent: al, status: 'done',
      synced: synced.ok, message: `${id} marked Done`,
    };
  }

  async _blockTask({ taskId, agent, reason }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    let raw   = await fs.readFile(this.boardPath, 'utf-8');
    raw       = moveToBlocked(raw, id, reason);
    await fs.writeFile(this.boardPath, raw, 'utf-8');
    await this._appendToTask(id, al,
      `## 🔴 Blocked\n\n**Agent:** ${al}  \n**Date:** ${today()}  \n**Reason:** ${reason}\n`);
    const synced = await this._vaultSync(`task: block ${id} — ${reason.slice(0, 60)}`);
    return {
      ok: true, taskId: id, agent: al, status: 'blocked', reason,
      synced: synced.ok, message: `${id} moved to Blocked`,
    };
  }

  async _addTaskNote({ taskId, agent, note }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    const et  = nowET();
    await this._appendToTask(id, al,
      `\n---\n\n## 📝 Progress Note — ${et} ET\n\n**From:** ${al}  \n\n${note}\n`);
    const synced = await this._vaultSync(`task: ${al} note on ${id}`);
    return { ok: true, taskId: id, agent: al, synced: synced.ok, message: `Note appended to ${id}` };
  }

  async _listAgents() {
    const agents = await this.vaultReader.getAgentRegistry();
    return { agents };
  }

  async _getNotifications({ agent }) {
    const name = AGENT_DISPLAY[(agent || '').toLowerCase()] || agent;
    const dir  = path.join(this.notifsDir, name);
    try {
      const files  = await fs.readdir(dir);
      const unread = files.filter(f => !f.startsWith('HANDLED-') && f.endsWith('.md'));
      const items  = await Promise.all(unread.map(async filename => {
        const content = await fs.readFile(path.join(dir, filename), 'utf-8').catch(() => '');
        return { filename, preview: content.slice(0, 800) };
      }));
      return { agent: name, unreadCount: items.length, notifications: items };
    } catch (err) {
      if (err.code === 'ENOENT') return { agent: name, unreadCount: 0, notifications: [] };
      throw err;
    }
  }

  async _markNotificationHandled({ agent, filename }) {
    const name = AGENT_DISPLAY[(agent || '').toLowerCase()] || agent;
    const dir  = path.join(this.notifsDir, name);
    const src  = path.join(dir, filename);
    const dst  = path.join(dir, filename.startsWith('HANDLED-') ? filename : `HANDLED-${filename}`);
    // Path traversal guard
    if (!src.startsWith(dir + path.sep) && src !== dir) throw new Error('Invalid filename');
    await fs.rename(src, dst);
    const synced = await this._vaultSync(`notif: handled ${filename.slice(0, 60)}`);
    return { ok: true, agent: name, handled: path.basename(dst), synced: synced.ok };
  }

  // ── private helpers ───────────────────────────────────────────────────────

  /** Append text to a task .md file, creating it if missing. */
  async _appendToTask(taskId, agent, text) {
    const fp = path.join(this.tasksDir, `${taskId}.md`);
    try {
      const existing = await fs.readFile(fp, 'utf-8');
      await fs.writeFile(fp, existing.trimEnd() + '\n\n' + text, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        await fs.mkdir(this.tasksDir, { recursive: true });
        await fs.writeFile(fp, `# ${taskId}\n\n*Auto-created by MCP (${agent}).*\n\n${text}`, 'utf-8');
      } else throw err;
    }
  }

  // ── JSON-RPC 2.0 dispatch ─────────────────────────────────────────────────

  /**
   * Dispatch a single JSON-RPC message object.
   * Returns a response object or null (for notifications that need no reply).
   */
  async dispatch(msg) {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }

    const { method, params = {}, id } = msg;

    const ok  = (result) => ({ jsonrpc: '2.0', id: id ?? null, result });
    const err = (code, message, data) => ({
      jsonrpc: '2.0', id: id ?? null,
      error: { code, message, ...(data != null ? { data } : {}) },
    });

    // Notifications — no id, no response
    if (id === undefined && method !== 'initialize') return null;

    try {
      switch (method) {

        // ── handshake ──────────────────────────────────────────────────────
        case 'initialize':
          return ok({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools:     {},
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: { name: 'overclaw', version: '2.0.0' },
            instructions: [
              'You are connected to the OverClaw swarm coordination server (http://localhost:8355).',
              '',
              'STARTUP CHECKLIST:',
              '1. Call `get_notifications` with your agent shortname — check for new assignments.',
              '2. Call `get_my_tasks` with your agent shortname — see your open work.',
              '3. For each task in your inbox, read it with `get_task`, then call `claim_task` to start.',
              '4. When you finish a task, call `complete_task` with a concise output summary.',
              '5. If you are blocked, call `block_task` with a specific reason.',
              '',
              'Valid agent shortnames: spike, lex, bill, steve, luther, jimmy.',
              'Always pass your shortname — not your full display name.',
            ].join('\n'),
          });

        case 'initialized':
        case 'notifications/initialized':
          return null;

        case 'ping':
          return ok({});

        // ── tools ──────────────────────────────────────────────────────────
        case 'tools/list':
          return ok({ tools: this.tools() });

        case 'tools/call': {
          if (!vaultReady(this)) return err(-32603, 'Vault not available');
          const { name, arguments: args = {} } = params;
          let result;
          switch (name) {
            case 'get_my_tasks':              result = await this._getMyTasks(args);              break;
            case 'get_task_board':            result = await this._getTaskBoard(args);            break;
            case 'get_task':                  result = await this._getTask(args);                 break;
            case 'claim_task':                result = await this._claimTask(args);               break;
            case 'complete_task':             result = await this._completeTask(args);            break;
            case 'block_task':                result = await this._blockTask(args);               break;
            case 'add_task_note':             result = await this._addTaskNote(args);             break;
            case 'list_agents':               result = await this._listAgents(args);              break;
            case 'get_notifications':         result = await this._getNotifications(args);        break;
            case 'mark_notification_handled': result = await this._markNotificationHandled(args); break;
            default: return err(-32601, `Unknown tool: ${name}`);
          }
          return ok({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        }

        // ── resources ──────────────────────────────────────────────────────
        case 'resources/list':
          return ok({
            resources: [
              {
                uri:         'overclaw://task-board/summary',
                name:        'Task Board Summary',
                mimeType:    'application/json',
                description: 'Live task board stats: counts per section',
              },
              {
                uri:         'overclaw://task-board/inbox',
                name:        'Inbox',
                mimeType:    'application/json',
                description: 'All unclaimed tasks in the inbox',
              },
            ],
          });

        case 'resources/read': {
          if (!vaultReady(this)) return err(-32603, 'Vault not available');
          const { uri } = params;
          const board   = await this.vaultReader.getTaskBoard();
          if (uri === 'overclaw://task-board/summary') {
            return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(board.stats, null, 2) }] });
          }
          if (uri === 'overclaw://task-board/inbox') {
            return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(board.inbox, null, 2) }] });
          }
          return err(-32002, `Unknown resource URI: ${uri}`);
        }

        default:
          return err(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      console.error(`[MCP] dispatch error in "${method}": ${e.message}`);
      return err(-32603, 'Internal error', e.message);
    }
  }

  // ── SSE session management ────────────────────────────────────────────────

  /**
   * Attach a new SSE client (MCP 2024-11-05 transport).
   * Returns sessionId.
   */
  attachSse(res) {
    const sessionId = crypto.randomBytes(8).toString('hex');
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 20_000);
    this._sseSessions.set(sessionId, { res, keepAlive });
    res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `/mcp/message?sessionId=${sessionId}` })}\n\n`);
    return sessionId;
  }

  detachSse(sessionId) {
    const s = this._sseSessions.get(sessionId);
    if (s) { clearInterval(s.keepAlive); this._sseSessions.delete(sessionId); }
  }

  /** Send a JSON-RPC response over an SSE session. */
  sendSse(sessionId, data) {
    const s = this._sseSessions.get(sessionId);
    if (!s) return false;
    try {
      s.res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      this.detachSse(sessionId);
      return false;
    }
  }
}

// ── guard ──────────────────────────────────────────────────────────────────
function vaultReady(srv) {
  return !!(srv.vaultReader);
}

module.exports = McpServer;
