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
    this.vaultReader = vaultReader;
    this.vaultPath   = vaultPath;
    this.boardPath   = path.join(vaultPath, '03 - Agents', 'Coordination', 'Task Board.md');
    this.tasksDir    = path.join(vaultPath, '03 - Agents', 'Coordination', 'Tasks');
    this.notifsDir   = path.join(vaultPath, '03 - Agents', 'Notifications');
    this.clawBridge  = clawBridge;
    this.brainStore  = brainStore;  // BrainStore instance (document DB)

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

  async _reassignTask({ taskId, toAgent, agent, reason }) {
    const VALID = ['spike', 'lex', 'bill', 'steve', 'luther', 'jimmy'];
    const id   = taskId.trim().toUpperCase();
    const to   = (toAgent || '').toLowerCase();
    const from = (agent  || '').toLowerCase();
    if (!VALID.includes(to))   throw new Error(`Invalid toAgent "${to}". Must be one of: ${VALID.join(', ')}`);
    if (!VALID.includes(from)) throw new Error(`Invalid agent "${from}". Must be one of: ${VALID.join(', ')}`);
    if (!reason || !reason.trim()) throw new Error('reason is required');

    // Permission: non-Spike callers can only reassign tasks assigned to themselves
    if (from !== 'spike') {
      const board = await this.vaultReader.getTaskBoard();
      const active = [
        ...(board.inbox      || []),
        ...(board.inProgress || []),
        ...(board.blocked    || []),
      ];
      const entry = active.find(t => {
        const raw      = (t.id || t.taskId || '');
        const stripped = raw.replace(/\[([^\]]+)\]\([^)]+\)/, '$1').trim();
        return stripped.toUpperCase().includes(id) || id.includes(stripped.toUpperCase());
      });
      const currentAgent = ((entry || {}).agent || (entry || {}).assignedTo || '').toLowerCase();
      if (currentAgent !== from) {
        throw new Error(
          `Permission denied: ${from} can only reassign tasks assigned to themselves. ` +
          `Task ${id} is assigned to "${currentAgent || 'unknown'}".`
        );
      }
    }

    let raw = await fs.readFile(this.boardPath, 'utf-8');
    const { content: updated, fromSection } = reassignAgentOnRow(raw, id, to);
    await fs.writeFile(this.boardPath, updated, 'utf-8');

    const dt = today();
    await this._appendToTask(id, from,
      `## 🔁 Reassigned ${from} → ${to} (${dt}, by ${from})\n\n**Reason:** ${reason}\n`);
    await this._updateTaskFrontmatter(id, { assigned_to: to });

    // Notify new agent (skip jimmy — no notification folder)
    let notified = false;
    if (to !== 'jimmy') {
      try {
        await this._writeNotification(to, id, id, fromSection);
        notified = true;
      } catch (ne) { console.warn('[MCP] reassign notification failed:', ne.message); }
    }

    const synced = await this._vaultSync(`task: reassign ${id} ${from}→${to} — ${reason.slice(0, 60)}`);

    // Wake Spike via ClawBridge if available and toAgent is spike
    let woke = null;
    if (to === 'spike' && this.clawBridge) {
      try {
        await this.clawBridge.wakeAgent(`📋 Task reassigned to you: ${id}. Check Task Board.`);
        woke = 'sent';
      } catch (we) { console.warn('[MCP] Spike wake (non-fatal):', we.message); woke = 'failed'; }
    }

    return {
      ok: true, taskId: id, fromAgent: from, toAgent: to,
      fromSection, notified, synced: synced.ok, wake: woke,
      message: `${id} reassigned from ${from} to ${to} (section: ${fromSection})`,
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

  async _draftTask({ title, description, assigned_to, priority, deadline, tags, approval_status, source_agent, done_criteria }) {
    if (!title || !description || !assigned_to || !source_agent) {
      throw new Error('title, description, assigned_to, and source_agent are required');
    }
    const agent       = (source_agent || 'agent').toLowerCase();
    const datePart    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const requestsDir = path.join(this.tasksDir, 'Requests');
    await fs.mkdir(requestsDir, { recursive: true });

    // Find next sequence number to avoid filename collisions
    let existing = [];
    try { existing = await fs.readdir(requestsDir); } catch {}
    const prefix  = `DRAFT-${agent}-${datePart}`;
    const numUsed = existing.filter(f => f.startsWith(prefix) && f.endsWith('.md')).length;
    const seq      = numUsed + 1;
    const filename = `${prefix}-${seq}.md`;
    const filepath = path.join(requestsDir, filename);

    const tagsArr    = Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(s => s.trim()) : []);
    const tagsBlock  = tagsArr.length ? `[${tagsArr.join(', ')}]` : '[]';
    const deadStr    = deadline || '—';
    const approvalStr = (approval_status === 'pre-approved') ? 'pre-approved' : 'pending';
    const priorStr    = (priority || 'medium').toLowerCase();

    // Format done_criteria as a checklist
    let criteriaLines;
    if (done_criteria) {
      criteriaLines = done_criteria.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => l.startsWith('- ') ? l : `- [ ] ${l}`);
    } else {
      criteriaLines = ['- [ ] (to be defined by Spike at mint time)'];
    }
    const criteriaStr = criteriaLines.join('\n');

    const nowET = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
    });
    const isoDate = new Date().toISOString().slice(0, 10);

    const content = `---
title: "${title.replace(/"/g, '\\"')}"
assigned_to: ${assigned_to.toLowerCase()}
priority: ${priorStr}
deadline: ${deadStr}
tags: ${tagsBlock}
approval_status: ${approvalStr}
source_agent: ${agent}
Minted task ID: —
created: ${isoDate}
---

# DRAFT — ${title}

## Summary
${description}

## Done Criteria
${criteriaStr}

---
*Drafted via MCP by ${agent} on ${nowET} ET*
`;

    await fs.writeFile(filepath, content, 'utf-8');
    const synced = await this._vaultSync(
      `draft: ${agent} proposes "${title.slice(0, 50)}" (${approvalStr}) → ${filename}`
    );

    return {
      ok:             true,
      draftFile:      filename,
      assignedTo:     assigned_to.toLowerCase(),
      approvalStatus: approvalStr,
      synced:         synced.ok,
      message:        `Draft created: ${filename}. Spike will mint a task ID within 24h.`,
      note:           approvalStr === 'pre-approved'
        ? 'Pre-approved — Spike mints the task ID on the next heartbeat.'
        : 'Pending — Jimmy must approve before Spike mints the task ID.',
    };
  }

  // ── private helpers ───────────────────────────────────────────────────────

  /** Update YAML frontmatter fields in a task .md file (no-op if file missing or no frontmatter). */
  async _updateTaskFrontmatter(taskId, updates) {
    const fp = path.join(this.tasksDir, `${taskId}.md`);
    let content;
    try { content = await fs.readFile(fp, 'utf-8'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) return; // no frontmatter — skip silently
    let fm = fmMatch[1];
    const body = fmMatch[2];
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp(`^(${key}:\\s*).*$`, 'm');
      fm = re.test(fm) ? fm.replace(re, `$1${value}`) : fm + `\n${key}: ${value}`;
    }
    await fs.writeFile(fp, `---\n${fm}\n---\n${body}`, 'utf-8');
  }

  /** Write a Tier-2 notification .md for any agent. */
  async _writeNotification(toAgent, taskId, taskTitle, fromSection) {
    const name  = AGENT_DISPLAY[(toAgent || '').toLowerCase()] || toAgent;
    const now   = new Date();
    const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
    const dir   = path.join(this.notifsDir, name);
    await fs.mkdir(dir, { recursive: true });
    const body = [
      '---',
      'type: task-assigned',
      `taskId: ${taskId}`,
      `assignedAt: ${now.toISOString()}`,
      `fromSection: ${fromSection}`,
      '---', '',
      `# Task Assignment: ${taskId}`, '',
      `You have been assigned **${taskId}** from the Task Board.`, '',
      `**Title:** ${taskTitle}`,
      `**Assigned at:** ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`, '',
      'Check the Task Board for full details.', '',
    ].join('\n');
    await fs.writeFile(path.join(dir, `${stamp}-task-assigned.md`), body, 'utf-8');
  }

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
          // Brain tools don't require vault; check separately
          const isBrainTool = ['brain_read','brain_write','brain_search','brain_list','brain_history','brain_move'].includes((params.name || ''));
          if (!isBrainTool && !vaultReady(this)) return err(-32603, 'Vault not available');
          if (isBrainTool && !this.brainStore) return err(-32603, 'BrainStore not available');
          const { name, arguments: args = {} } = params;
          // Attach agent name from request context if available
          const agentName = req.headers?.['x-agent-name'] || 'agent';
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
            case 'brain_read':    result = this._brainRead(args);                         break;
            case 'brain_write':   result = this._brainWrite(args, agentName);             break;
            case 'brain_search':  result = this._brainSearch(args);                       break;
            case 'brain_list':    result = this._brainList(args);                         break;
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

  _brainRead({ path: docPath }) {
    if (!docPath) throw new Error('path required');
    const doc = this.brainStore.getDoc(docPath);
    if (!doc) throw new Error(`Document not found: ${docPath}`);
    return { path: doc.path, content: doc.content, updated_at: doc.updated_at, updated_by: doc.updated_by };
  }

  _brainWrite({ path: docPath, content, change_note }, agentName) {
    if (!docPath) throw new Error('path required');
    if (typeof content !== 'string') throw new Error('content required');
    const result = this.brainStore.putDoc(docPath, content, {
      updatedBy: agentName || 'agent',
      changeNote: change_note || null
    });
    return { ok: true, path: docPath, ...result };
  }

  _brainSearch({ query, dir = '', limit = 20 }) {
    if (!query) throw new Error('query required');
    const results = this.brainStore.search(query, { limit, dir });
    return { query, count: results.length, results };
  }

  _brainList({ dir = '', recursive = false }) {
    const items = this.brainStore.listDir(dir, { recursive });
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
function vaultReady(srv) {
  return !!(srv.vaultReader);
}

module.exports = McpServer;
