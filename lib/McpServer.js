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
 * Tools (12):
 *   get_my_tasks              — tasks assigned to an agent, by section
 *   get_task_board            — full board snapshot
 *   get_task                  — read a task file
 *   claim_task                — inbox → in_progress
 *   complete_task             — in_progress/blocked/inbox → done
 *   block_task                — in_progress/inbox → blocked
 *   reassign_task             — change assigned agent (any active section)
 *   add_task_note             — append progress note to task file
 *   list_agents               — agent registry
 *   get_notifications         — unread notification files for an agent
 *   mark_notification_handled — rename notification file to HANDLED-*
 *   draft_task                — create a DRAFT file for Spike to mint with a formal task ID
 */

const path     = require('path');
const fs       = require('fs').promises;
const crypto   = require('crypto');
const { execFile } = require('child_process');

// Brain document paths
const BRAIN_TASK_BOARD   = '03 - Agents/Coordination/Task Board.md';
const BRAIN_TASKS_DIR    = '03 - Agents/Coordination/Tasks';
const BRAIN_NOTIFS_DIR   = '03 - Agents/Notifications';
const BRAIN_AGENT_REG    = '03 - Agents/Agent Registry.md';

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

/**
 * Update the agent column (col[2]) of a task row in any active (non-Done) section.
 * Returns { content: updatedString, fromSection: 'inbox'|'in_progress'|'blocked' }.
 */
function reassignAgentOnRow(content, taskId, toAgent) {
  const lines = content.split('\n');
  const found = findRow(lines, taskId, 'inbox', 'progress', 'blocked');
  if (!found) {
    if (findRow(lines, taskId, 'done')) {
      throw new Error(`Task ${taskId} is Done — completed tasks cannot be reassigned`);
    }
    throw new Error(`Task ${taskId} not found in Inbox, In Progress, or Blocked`);
  }
  const { rowIdx, rowCells, sec } = found;
  rowCells[2] = toAgent;
  lines[rowIdx] = '| ' + rowCells.join(' | ') + ' |';
  const fromSection = sec.includes('progress') ? 'in_progress'
                    : sec.includes('blocked')  ? 'blocked'
                    :                            'inbox';
  return { content: lines.join('\n'), fromSection };
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

/** Move task row from In Progress, Blocked, or Inbox → Done. */
function moveToDone(content, taskId, agent, output) {
  const lines = content.split('\n');
  const found = findRow(lines, taskId, 'progress', 'blocked', 'inbox');
  if (!found) throw new Error(`Task ${taskId} not found in In Progress, Blocked, or Inbox`);
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
  constructor({ vaultReader, vaultPath, clawBridge = null, brainStore = null }) {
    this.vaultReader = vaultReader;  // DEPRECATED — kept for heartbeat/swarm routes only
    this.vaultPath   = vaultPath;    // DEPRECATED — kept for heartbeat/swarm routes only
    this.clawBridge  = clawBridge;
    this.brainStore  = brainStore;   // BrainStore instance (document DB) — primary store

    // SSE sessions: sessionId → { res, keepAlive }
    this._sseSessions = new Map();
  }

  // ── vault-sync ────────────────────────────────────────────────────────────

  // vault-sync removed — all writes now go through BrainStore (ACID, transactional)
  // Kept as no-op stub for any residual callers during transition
  _vaultSync(_message) {
    return Promise.resolve({ ok: true, stub: true });
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
      {
        name: 'reassign_task',
        description: [
          'Reassign a task to a different agent without changing its board section.',
          'Updates the board row, task file assigned_to, appends a reassignment note,',
          'and notifies the new agent. Spike can reassign any task; other agents can only reassign their own.',
          'Done tasks cannot be reassigned.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            taskId:  { type: 'string', description: 'Task ID to reassign, e.g. TASK-20261008-001' },
            toAgent: { type: 'string', description: 'Agent shortname to assign to: spike | lex | bill | steve | luther | jimmy' },
            agent:   { type: 'string', description: 'Your agent shortname (caller — used for permission check)' },
            reason:  { type: 'string', description: 'One-line reason for the reassignment (shown in task file + notification)' },
          },
          required: ['taskId', 'toAgent', 'agent', 'reason'],
        },
      },
      {
        name: 'draft_task',
        description: [
          'Create a task DRAFT file so Spike can review and mint a formal TASK-YYYYMMDD-NNN ID.',
          'Agents use this to propose work; Spike is the sole task-ID minter (via heartbeat).',
          'approval_status="pre-approved": Spike mints on next heartbeat without asking Jimmy.',
          'approval_status="pending": Jimmy must approve before Spike mints.',
          'Spike will mint the task ID within 24 hours.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            title:           { type: 'string',  description: 'Short task title (< 80 chars)' },
            description:     { type: 'string',  description: 'Full task description — what needs to be done and why' },
            assigned_to:     { type: 'string',  description: 'Target agent shortname: spike | lex | bill | steve | jimmy' },
            priority:        { type: 'string',  enum: ['critical', 'high', 'medium', 'low'], description: 'Task priority' },
            deadline:        { type: 'string',  description: 'ISO date deadline YYYY-MM-DD (optional)' },
            tags:            { type: 'array',   items: { type: 'string' }, description: 'Tag list, e.g. ["brightmove","aeo"]' },
            approval_status: { type: 'string',  enum: ['pre-approved', 'pending'], description: '"pre-approved" = Spike mints on next heartbeat; "pending" = needs Jimmy approval first' },
            source_agent:    { type: 'string',  description: 'Your agent shortname (the author of this draft)' },
            done_criteria:   { type: 'string',  description: 'What does done look like? Newline-separated acceptance criteria.' },
          },
          required: ['title', 'description', 'assigned_to', 'priority', 'source_agent'],
        },
      },

      // ── Brain tools ──────────────────────────────────────────────────────────
      {
        name: 'brain_read',
        description: 'Read a document from the AI Brain by its path. Returns content and metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Document path relative to vault root, e.g. "03 - Agents/Coordination/Task Board.md"' },
          },
          required: ['path'],
        },
      },
      {
        name: 'brain_write',
        description: 'Write or update a document in the AI Brain. Automatically saves a version snapshot before overwriting.',
        inputSchema: {
          type: 'object',
          properties: {
            path:        { type: 'string', description: 'Document path relative to vault root.' },
            content:     { type: 'string', description: 'Full markdown content to write.' },
            change_note: { type: 'string', description: 'Optional short description of what changed.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'brain_search',
        description: 'Full-text search across all documents in the AI Brain. Returns matching paths with snippets.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            dir:   { type: 'string', description: 'Optional directory prefix to restrict search.' },
            limit: { type: 'integer', description: 'Max results (default 20).' },
          },
          required: ['query'],
        },
      },
      {
        name: 'brain_list',
        description: 'List documents in a directory of the AI Brain. Returns files and subdirectories.',
        inputSchema: {
          type: 'object',
          properties: {
            dir:       { type: 'string', description: 'Directory path (empty string = root).' },
            recursive: { type: 'boolean', description: 'If true, return all descendants (default false).' },
          },
        },
      },
      {
        name: 'brain_history',
        description: 'Get version history for a document in the AI Brain.',
        inputSchema: {
          type: 'object',
          properties: {
            path:  { type: 'string', description: 'Document path.' },
            limit: { type: 'integer', description: 'Max versions to return (default 20).' },
          },
          required: ['path'],
        },
      },
      {
        name: 'brain_move',
        description: 'Move or rename a document in the AI Brain.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Current document path.' },
            to:   { type: 'string', description: 'New document path.' },
          },
          required: ['from', 'to'],
        },
      },
    ];
  }

  // ── tool handlers ─────────────────────────────────────────────────────────

  // ── Task board helpers (BrainStore-native) ──────────────────────────────────

  /** Read the Task Board from BrainStore, fall back to VaultReader if needed */
  async _readTaskBoard() {
    if (this.brainStore) {
      const doc = this.brainStore.getDoc(BRAIN_TASK_BOARD);
      if (doc) return doc.content;
    }
    // fallback
    if (this.vaultReader) return this.vaultReader.getFile('03 - Agents/Coordination/Task Board.md');
    throw new Error('No data store available');
  }

  /** Write Task Board back to BrainStore */
  async _writeTaskBoard(content, agent) {
    if (!this.brainStore) throw new Error('BrainStore not available');
    this.brainStore.putDoc(BRAIN_TASK_BOARD, content, { updatedBy: agent || 'mcp' });
  }

  /** Read a task doc from BrainStore */
  _readTaskDoc(taskId) {
    const p = `${BRAIN_TASKS_DIR}/${taskId}.md`;
    const doc = this.brainStore?.getDoc(p);
    return doc ? doc.content : null;
  }

  /** Write/append to a task doc in BrainStore */
  _writeTaskDoc(taskId, content, agent) {
    if (!this.brainStore) return;
    this.brainStore.putDoc(`${BRAIN_TASKS_DIR}/${taskId}.md`, content, { updatedBy: agent || 'mcp' });
  }

  async _getMyTasks({ agent, status = 'all' }) {
    const raw   = await this._readTaskBoard();
    const board = parseTaskBoard(raw);
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
    const raw   = await this._readTaskBoard();
    const board = parseTaskBoard(raw);
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
    const content = this._readTaskDoc(id);
    const raw     = await this._readTaskBoard();
    const board   = parseTaskBoard(raw);
    const allTasks = [
      ...(board.inbox      || []),
      ...(board.inProgress || []),
      ...(board.blocked    || []),
      ...(board.done       || []),
    ];
    const entry = allTasks.find(t => {
      const stripped = (t.taskId || '').replace(/\[([^\]]+)\]\([^)]+\)/, '$1').trim();
      return stripped.toUpperCase().includes(id) || id.includes(stripped.toUpperCase());
    });
    return { taskId: id, boardEntry: entry || null, content: content || '(task file not found)' };
  }

  async _claimTask({ taskId, agent }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    let raw   = await this._readTaskBoard();
    raw       = moveToInProgress(raw, id, al);
    await this._writeTaskBoard(raw, al);
    const existing = this._readTaskDoc(id);
    const note = `## 🚀 Claimed\n\n**Agent:** ${al}  \n**Date:** ${today()} — claimed via MCP and moved to In Progress.\n`;
    this._writeTaskDoc(id, existing ? existing.trimEnd() + '\n\n' + note
      : `# ${id}\n\n*Claimed by ${al}.*\n\n${note}`, al);
    return { ok: true, taskId: id, agent: al, status: 'in_progress', message: `${id} moved to In Progress, assigned to ${al}` };
  }

  async _completeTask({ taskId, agent, output }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    let raw   = await this._readTaskBoard();
    raw       = moveToDone(raw, id, al, output);
    await this._writeTaskBoard(raw, al);
    const existing = this._readTaskDoc(id);
    const note = `## ✅ Completed\n\n**Agent:** ${al}  \n**Date:** ${today()}  \n\n**Output:** ${output}\n`;
    this._writeTaskDoc(id, existing ? existing.trimEnd() + '\n\n' + note
      : `# ${id}\n\n${note}`, al);
    return { ok: true, taskId: id, agent: al, status: 'done', message: `${id} marked Done` };
  }

  async _blockTask({ taskId, agent, reason }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    let raw   = await this._readTaskBoard();
    raw       = moveToBlocked(raw, id, reason);
    await this._writeTaskBoard(raw, al);
    const existing = this._readTaskDoc(id);
    const note = `## 🔴 Blocked\n\n**Agent:** ${al}  \n**Date:** ${today()}  \n**Reason:** ${reason}\n`;
    this._writeTaskDoc(id, existing ? existing.trimEnd() + '\n\n' + note
      : `# ${id}\n\n${note}`, al);
    return { ok: true, taskId: id, agent: al, status: 'blocked', reason, message: `${id} moved to Blocked` };
  }

  async _reassignTask({ taskId, toAgent, agent, reason }) {
    const VALID = ['spike', 'lex', 'bill', 'steve', 'luther', 'jimmy'];
    const id   = taskId.trim().toUpperCase();
    const to   = (toAgent || '').toLowerCase();
    const from = (agent  || '').toLowerCase();
    if (!VALID.includes(to))   throw new Error(`Invalid toAgent "${to}". Must be one of: ${VALID.join(', ')}`);
    if (!VALID.includes(from)) throw new Error(`Invalid agent "${from}". Must be one of: ${VALID.join(', ')}`);
    if (!reason || !reason.trim()) throw new Error('reason is required');

    // Permission check for non-Spike callers
    if (from !== 'spike') {
      const raw   = await this._readTaskBoard();
      const board = parseTaskBoard(raw);
      const active = [...(board.inbox||[]), ...(board.inProgress||[]), ...(board.blocked||[])];
      const entry  = active.find(t => {
        const stripped = (t.taskId||'').replace(/\[([^\]]+)\]\([^)]+\)/,'$1').trim();
        return stripped.toUpperCase().includes(id) || id.includes(stripped.toUpperCase());
      });
      const currentAgent = ((entry||{}).agent||(entry||{}).assignedTo||'').toLowerCase();
      if (currentAgent !== from) {
        throw new Error(`Permission denied: ${from} can only reassign their own tasks. Task ${id} is assigned to "${currentAgent||'unknown'}".`);
      }
    }

    let raw = await this._readTaskBoard();
    const { content: updated, fromSection } = reassignAgentOnRow(raw, id, to);
    await this._writeTaskBoard(updated, from);

    const existing = this._readTaskDoc(id);
    const note = `## 🔁 Reassigned ${from} → ${to} (${today()}, by ${from})\n\n**Reason:** ${reason}\n`;
    this._writeTaskDoc(id, existing ? existing.trimEnd() + '\n\n' + note
      : `# ${id}\n\n${note}`, from);
    this._updateTaskFrontmatter(id, { assigned_to: to });

    // Notify new agent (skip jimmy)
    let notified = false;
    if (to !== 'jimmy') {
      try { await this._writeNotification(to, id, id, fromSection); notified = true; }
      catch (ne) { console.warn('[MCP] reassign notification failed:', ne.message); }
    }

    // Wake Spike via ClawBridge if applicable
    let woke = null;
    if (to === 'spike' && this.clawBridge) {
      try { await this.clawBridge.wakeAgent(`📋 Task reassigned to you: ${id}. Check Task Board.`); woke = 'sent'; }
      catch (we) { console.warn('[MCP] Spike wake (non-fatal):', we.message); woke = 'failed'; }
    }

    return { ok: true, taskId: id, fromAgent: from, toAgent: to, fromSection, notified, wake: woke,
             message: `${id} reassigned from ${from} to ${to} (section: ${fromSection})` };
  }

  async _addTaskNote({ taskId, agent, note }) {
    const id  = taskId.trim().toUpperCase();
    const al  = (agent || '').toLowerCase();
    const et  = nowET();
    const existing = this._readTaskDoc(id);
    const entry = `\n---\n\n## 📝 Progress Note — ${et} ET\n\n**From:** ${al}  \n\n${note}\n`;
    this._writeTaskDoc(id, existing ? existing.trimEnd() + entry
      : `# ${id}\n\n${entry}`, al);
    return { ok: true, taskId: id, agent: al, message: `Note appended to ${id}` };
  }

  async _listAgents() {
    // Try BrainStore first, fall back to VaultReader
    if (this.brainStore) {
      const doc = this.brainStore.getDoc(BRAIN_AGENT_REG);
      if (doc) return { agents: parseAgentRegistry(doc.content) };
    }
    if (this.vaultReader) {
      const agents = await this.vaultReader.getAgentRegistry();
      return { agents };
    }
    return { agents: [] };
  }

  async _getNotifications({ agent }) {
    const name   = AGENT_DISPLAY[(agent || '').toLowerCase()] || agent;
    const prefix = `${BRAIN_NOTIFS_DIR}/${name}/`;
    if (!this.brainStore) return { agent: name, unreadCount: 0, notifications: [] };
    const items = this.brainStore.listDir(prefix.slice(0, -1), { recursive: false })
      .filter(i => i.type === 'file' && !i.name.startsWith('HANDLED-') && i.name.endsWith('.md'));
    const notifications = items.map(i => {
      const doc = this.brainStore.getDoc(i.path);
      return { filename: i.name, preview: (doc?.content || '').slice(0, 800) };
    });
    return { agent: name, unreadCount: notifications.length, notifications };
  }

  async _markNotificationHandled({ agent, filename }) {
    const name   = AGENT_DISPLAY[(agent || '').toLowerCase()] || agent;
    const oldPath = `${BRAIN_NOTIFS_DIR}/${name}/${filename}`;
    const newName = filename.startsWith('HANDLED-') ? filename : `HANDLED-${filename}`;
    const newPath = `${BRAIN_NOTIFS_DIR}/${name}/${newName}`;
    if (!this.brainStore) throw new Error('BrainStore not available');
    if (oldPath === newPath) return { ok: true, agent: name, handled: newName };
    this.brainStore.moveDoc(oldPath, newPath, { updatedBy: agent || 'mcp' });
    return { ok: true, agent: name, handled: newName };
  }

  async _draftTask({ title, description, assigned_to, priority, deadline, tags, approval_status, source_agent, done_criteria }) {
    if (!title || !description || !assigned_to || !source_agent) {
      throw new Error('title, description, assigned_to, and source_agent are required');
    }
    if (!this.brainStore) throw new Error('BrainStore not available');
    const agent       = (source_agent || 'agent').toLowerCase();
    const datePart    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const requestsDir = BRAIN_TASKS_DIR + '/Requests';

    const existing = this.brainStore.listDir(requestsDir, { recursive: false })
      .filter(i => i.type === 'file' && i.name.startsWith('DRAFT-' + agent + '-' + datePart) && i.name.endsWith('.md'));
    const seq      = existing.length + 1;
    const filename = 'DRAFT-' + agent + '-' + datePart + '-' + seq + '.md';
    const docPath  = requestsDir + '/' + filename;

    const tagsArr    = Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(s => s.trim()) : []);
    const tagsBlock  = tagsArr.length ? '[' + tagsArr.join(', ') + ']' : '[]';
    const deadStr    = deadline || '—';
    const approvalStr = (approval_status === 'pre-approved') ? 'pre-approved' : 'pending';
    const priorStr    = (priority || 'medium').toLowerCase();

    let criteriaLines;
    if (done_criteria) {
      criteriaLines = done_criteria.split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => l.startsWith('- ') ? l : '- [ ] ' + l);
    } else {
      criteriaLines = ['- [ ] (to be defined by Spike at mint time)'];
    }

    const nowET2  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
    const isoDate = new Date().toISOString().slice(0, 10);
    const content = [
      '---',
      'title: "' + title.replace(/"/g, '\\"') + '"',
      'assigned_to: ' + assigned_to.toLowerCase(),
      'priority: ' + priorStr,
      'deadline: ' + deadStr,
      'tags: ' + tagsBlock,
      'approval_status: ' + approvalStr,
      'source_agent: ' + agent,
      'Minted task ID: —',
      'created: ' + isoDate,
      '---', '',
      '# DRAFT — ' + title, '',
      '## Summary', description, '',
      '## Done Criteria', criteriaLines.join('\n'), '',
      '---',
      '*Drafted via MCP by ' + agent + ' on ' + nowET2 + ' ET*', '',
    ].join('\n');

    this.brainStore.putDoc(docPath, content, { updatedBy: agent });
    return {
      ok:             true,
      draftFile:      filename,
      assignedTo:     assigned_to.toLowerCase(),
      approvalStatus: approvalStr,
      message:        'Draft created: ' + filename + '. Spike will mint a task ID within 24h.',
      note:           approvalStr === 'pre-approved'
        ? 'Pre-approved — Spike mints the task ID on the next heartbeat.'
        : 'Pending — Jimmy must approve before Spike mints the task ID.',
    };
  }

  // ── private helpers ────────────────────────────────────────────────────────

  /** Update YAML frontmatter fields in a task doc in BrainStore */
  _updateTaskFrontmatter(taskId, updates) {
    if (!this.brainStore) return;
    const docPath = BRAIN_TASKS_DIR + '/' + taskId + '.md';
    const doc = this.brainStore.getDoc(docPath);
    if (!doc) return;
    let content = doc.content;
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) return;
    let fm = fmMatch[1];
    const body = fmMatch[2];
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp('^(' + key + ':\\s*).*$', 'm');
      fm = re.test(fm) ? fm.replace(re, '$1' + value) : fm + '\n' + key + ': ' + value;
    }
    this.brainStore.putDoc(docPath, '---\n' + fm + '\n---\n' + body, { updatedBy: 'mcp' });
  }

  /** Write a notification doc for an agent into BrainStore */
  async _writeNotification(toAgent, taskId, taskTitle, fromSection) {
    if (!this.brainStore) return;
    const name  = AGENT_DISPLAY[(toAgent || '').toLowerCase()] || toAgent;
    const now   = new Date();
    const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
    const docPath = BRAIN_NOTIFS_DIR + '/' + name + '/' + stamp + '-task-assigned.md';
    const body = [
      '---', 'type: task-assigned',
      'taskId: ' + taskId,
      'assignedAt: ' + now.toISOString(),
      'fromSection: ' + fromSection,
      '---', '',
      '# Task Assignment: ' + taskId, '',
      'You have been assigned **' + taskId + '** from the Task Board.', '',
      '**Title:** ' + taskTitle,
      '**Assigned at:** ' + now.toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET', '',
      'Check the Task Board for full details.', '',
    ].join('\n');
    this.brainStore.putDoc(docPath, body, { updatedBy: 'mcp' });
  }

  async dispatch(msg, ctx = {}) {
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
          // Brain tools don't require vault; check separately
          const isBrainTool = ['brain_read','brain_write','brain_search','brain_list','brain_history','brain_move'].includes((params.name || ''));
          if (!isBrainTool && !vaultReady(this)) return err(-32603, 'Vault not available');
          if (isBrainTool && !this.brainStore) return err(-32603, 'BrainStore not available');
          const { name, arguments: args = {} } = params;
          // Attach agent name from request context if available
          const agentName = ctx.agentName || (params._agentName) || 'agent';
          let result;
          switch (name) {
            case 'get_my_tasks':              result = await this._getMyTasks(args);              break;
            case 'get_task_board':            result = await this._getTaskBoard(args);            break;
            case 'get_task':                  result = await this._getTask(args);                 break;
            case 'claim_task':                result = await this._claimTask(args);               break;
            case 'complete_task':             result = await this._completeTask(args);            break;
            case 'block_task':                result = await this._blockTask(args);               break;
            case 'reassign_task':             result = await this._reassignTask(args);            break;
            case 'add_task_note':             result = await this._addTaskNote(args);             break;
            case 'list_agents':               result = await this._listAgents(args);              break;
            case 'get_notifications':         result = await this._getNotifications(args);        break;
            case 'mark_notification_handled': result = await this._markNotificationHandled(args); break;
            case 'draft_task':                result = await this._draftTask(args);               break;
            case 'brain_read':    result = this._brainRead(args, agentName);              break;
            case 'brain_write':   result = this._brainWrite(args, agentName);             break;
            case 'brain_search':  result = this._brainSearch(args, agentName);            break;
            case 'brain_list':    result = this._brainList(args, agentName);              break;
            case 'brain_history': result = this._brainHistory(args);                      break;
            case 'brain_move':    result = this._brainMove(args, agentName);              break;
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
    res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sessionId}\n\n`);
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

  // ── Brain tool handlers ──────────────────────────────────────────────────────────

  _brainRead({ path: docPath }, agentName) {
    if (!docPath) throw new Error('path required');
    const doc = this.brainStore.getDoc(docPath);
    if (!doc) throw new Error(`Document not found: ${docPath}`);
    this.brainStore.logActivity(agentName || 'agent', 'read', docPath);
    return { path: doc.path, content: doc.content, updated_at: doc.updated_at, updated_by: doc.updated_by };
  }

  _brainWrite({ path: docPath, content, change_note }, agentName) {
    if (!docPath) throw new Error('path required');
    if (typeof content !== 'string') throw new Error('content required');
    const result = this.brainStore.putDoc(docPath, content, {
      updatedBy: agentName || 'agent',
      changeNote: change_note || null
    });
    this.brainStore.logActivity(agentName || 'agent', 'write', docPath);
    return { ok: true, path: docPath, ...result };
  }

  _brainSearch({ query, dir = '', limit = 20 }, agentName) {
    if (!query) throw new Error('query required');
    const results = this.brainStore.search(query, { limit, dir });
    this.brainStore.logActivity(agentName || 'agent', 'search', dir || null);
    return { query, count: results.length, results };
  }

  _brainList({ dir = '', recursive = false }, agentName) {
    const items = this.brainStore.listDir(dir, { recursive });
    this.brainStore.logActivity(agentName || 'agent', 'list', dir || null);
    return { dir, count: items.length, items };
  }

  _brainHistory({ path: docPath, limit = 20 }) {
    if (!docPath) throw new Error('path required');
    const history = this.brainStore.getHistory(docPath, { limit });
    return { path: docPath, versions: history.length, history };
  }

  _brainMove({ from, to }, agentName) {
    if (!from || !to) throw new Error('from and to required');
    return this.brainStore.moveDoc(from, to, { updatedBy: agentName || 'agent' });
  }

}

// ── guard ──────────────────────────────────────────────────────────────────
// ── guard ──────────────────────────────────────────────────────────
function vaultReady(srv) {
  return !!(srv.vaultReader || srv.brainStore);
}

// ── Markdown table helpers ─────────────────────────────────────────
function stripBold(s) { return (s||'').replace(/\*\*(.+?)\*\*/g,'$1').trim(); }
function extractTaskId(s) { const m=(s||'').match(/TASK-[A-Z0-9]+-\d+/); return m?m[0]:null; }
function extractLink(s) { const m=(s||'').match(/\[.*?\]\((.+?)\)/); return m?m[1]:null; }

function parseMarkdownTable(lines) {
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s\-:]+\|/.test(t)) continue; // separator
    const cells = t.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
    rows.push(cells);
  }
  return rows;
}

// ── Task Board parser (synchronous, from markdown string) ─────────────────────
function parseTaskBoard(text) {
  const result = { inbox: [], inProgress: [], blocked: [], done: [], stats: {} };
  const sectionMap = {};
  let cur = '__preamble__';
  sectionMap[cur] = [];
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^##\s+(.+)/);
    if (m) { cur = m[1].trim(); sectionMap[cur] = []; }
    else sectionMap[cur].push(line);
  }
  const aliases = {
    inbox:      ['inbox', '📥 inbox'],
    inProgress: ['in progress', '🔄 in progress', 'in-progress'],
    blocked:    ['blocked', '🚫 blocked', '⛔ blocked'],
    done:       ['done', '✅ done', 'done (recent)', '✅ done (recent)'],
  };
  for (const [heading, lines] of Object.entries(sectionMap)) {
    const hl = heading.toLowerCase();
    let key = null;
    for (const [k, arr] of Object.entries(aliases)) {
      if (arr.some(a => hl.includes(a))) { key = k; break; }
    }
    if (!key) continue;
    const rows = parseMarkdownTable(lines).slice(1); // skip header
    for (const cells of rows) {
      const t = parseTaskRow(cells, key);
      if (t) result[key].push(t);
    }
  }
  result.stats = {
    total:      result.inbox.length + result.inProgress.length + result.blocked.length + result.done.length,
    inbox:      result.inbox.length,
    inProgress: result.inProgress.length,
    blocked:    result.blocked.length,
    done:       result.done.length,
  };
  return result;
}

function parseTaskRow(cells, status) {
  if (!cells || !cells[0]) return null;
  const rawId  = cells[0] || '';
  const m      = rawId.match(/TASK-[A-Z0-9]+-\d+/);
  const taskId = m ? m[0] : rawId.replace(/\*\*(.+?)\*\*/g,'$1').trim();
  const link   = (rawId.match(/\[.*?\]\((.+?)\)/) || [])[1] || null;
  if (!taskId || /^[\s\-–—|]+$/.test(taskId)) return null;
  const title = (cells[1]||'').replace(/\*\*(.+?)\*\*/g,'$1').replace(/\[(.+?)\]\(.+?\)/g,'$1').trim();
  const agent = (cells[2]||'').replace(/\*\*(.+?)\*\*/g,'$1').trim();
  let priority='',created='',deadline='',reason='',output='';
  if (status==='inbox')      { priority=(cells[3]||'').trim(); deadline=(cells[4]||'').trim(); created=(cells[5]||'').trim(); }
  else if (status==='inProgress') { created=(cells[3]||'').trim(); deadline=(cells[4]||'').trim(); }
  else if (status==='blocked')    { created=(cells[3]||'').trim(); reason=(cells[4]||'').trim(); }
  else if (status==='done')       { created=(cells[3]||'').trim(); output=(cells[4]||'').trim(); }
  return { taskId, title, agent, priority, deadline, created, reason, output, status, link };
}

function parseAgentRegistry(text) {
  const agents = [];
  const lines  = (text || '').split('\n');
  let inTable = false, headerRow = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) { if (inTable) break; continue; }
    if (/^\|[\s\-:|]+\|/.test(t)) continue;
    const cells = t.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
    if (!inTable) {
      const cl = cells.map(c=>c.toLowerCase());
      if (cl.some(c=>c.includes('nickname')||c.includes('agent'))) {
        inTable = true;
        headerRow = cells.map(c=>c.toLowerCase().replace(/\s+/g,'_'));
      }
      continue;
    }
    if (cells.every(c=>c===''||c==='-'||c==='N/A')) continue;
    const agent = {};
    headerRow.forEach((k,i)=>{ agent[k]=(cells[i]||'').replace(/\*\*(.+?)\*\*/g,'$1').trim(); });
    agents.push(agent);
  }
  return agents;
}

module.exports = McpServer;
