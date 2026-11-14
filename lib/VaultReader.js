'use strict';

/**
 * VaultReader.js
 *
 * Reads and parses data from an Obsidian vault used as the coordination layer
 * for a multi-agent AI swarm.  All I/O is read-only — this module never writes
 * to the vault.
 *
 * Supported vault layout (all paths relative to vaultPath):
 *   03 - Agents/Coordination/Task Board.md   — swarm task board
 *   03 - Agents/Agent Registry.md            — agent roster
 *   08 - QA-and-Monitoring/Heartbeats/       — per-machine heartbeat logs
 */

const fs   = require('fs').promises;
const path = require('path');
const {
  classifyTask,
  applyTaskTypes,
  parseFrontmatter: parseFmBlock,
  splitDocument,
  parseHeartbeatFilename: parseHbName,
  taskDocRel,
} = require('./taskClassification');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip markdown bold markers: **text** → text */
function stripBold(str) {
  return (str || '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
}

/**
 * Parse a markdown table body — skips the separator row (`|---|`).
 * Returns an array of arrays of cell strings.
 */
function parseMarkdownTable(lines) {
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Skip separator rows  e.g.  | --- | :---: |
    if (/^\|[\s\-:]+\|/.test(trimmed)) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(c => c.trim());
    rows.push(cells);
  }
  return rows;
}

/**
 * Extract the first TASK-XXXXXXXX-NNN style ID from a string.
 * Handles markdown links: [TASK-...](url)
 */
function extractTaskId(str) {
  const m = str.match(/TASK-[A-Z0-9]+-\d+/);
  return m ? m[0] : null;
}

/**
 * Extract the href from a markdown link — returns null if not a link.
 */
function extractLink(str) {
  const m = str.match(/\[.*?\]\((.*?)\)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// VaultReader class
// ---------------------------------------------------------------------------

class VaultReader {
  /**
   * @param {string} vaultPath  Absolute path to the Obsidian vault root (filesystem fallback).
   * @param {{ brainStore?: object }} [options]
   *   brainStore — BrainStore instance. When it is open, every read and write
   *   uses brain.db. The vault directory is used only if the database is unavailable.
   */
  constructor(vaultPath, options = {}) {
    if (!vaultPath || typeof vaultPath !== 'string') {
      throw new Error('VaultReader: vaultPath must be a non-empty string');
    }
    this.vaultPath = vaultPath;
    this.brainStore = options.brainStore || null;
    this.lastSyncAt = null;
    this.syncInProgress = false;
    this.gitSyncEnabled = false;
  }

  /** Attach a BrainStore after construction (index.js creates the DB second). */
  setBrainStore(brainStore) {
    this.brainStore = brainStore || null;
  }

  /**
   * True when brain.db can be queried. A closed or missing database is unavailable
   * and callers fall back to the vault directory.
   */
  _brainUsable() {
    if (!this.brainStore || typeof this.brainStore.getDoc !== 'function') return false;
    try {
      this.brainStore.stats();
      return true;
    } catch {
      return false;
    }
  }

  _normRel(relPath) {
    return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  // -------------------------------------------------------------------------
  // Vault git sync — disabled. brain.db is the source of truth.
  // -------------------------------------------------------------------------

  /**
   * Git pull is disabled. The swarm no longer syncs the vault checkout.
   * @returns {{ ok: true, skipped: true, disabled: true, message: string }}
   */
  async sync() {
    return {
      ok: true,
      skipped: true,
      disabled: true,
      message: 'git pull disabled; brain.db is the source of truth',
      lastSyncAt: this.lastSyncAt,
      source: this._brainUsable() ? 'brain' : 'filesystem',
    };
  }

  // -------------------------------------------------------------------------
  // Availability check
  // -------------------------------------------------------------------------

  /**
   * Test whether the vault directory is readable.
   * @returns {{ available: boolean, path: string, error?: string }}
   */
  async isAvailable() {
    if (this._brainUsable()) {
      return {
        available: true,
        path: this.brainStore.dbPath,
        source: 'brain',
      };
    }
    try {
      await fs.access(this.vaultPath);
      const stat = await fs.stat(this.vaultPath);
      if (!stat.isDirectory()) {
        return { available: false, path: this.vaultPath, source: 'filesystem', error: 'Vault path is not a directory' };
      }
      return { available: true, path: this.vaultPath, source: 'filesystem' };
    } catch (err) {
      return { available: false, path: this.vaultPath, source: 'filesystem', error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // GAP ATLAS
  // -------------------------------------------------------------------------

  /**
   * Read and parse the GAP ATLAS blind-spot map.
   * Returns an empty atlas shell if the file doesn't exist yet.
   * @returns {{ version: number, updated: string|null, description: string, regions: object[], gaps: object[] }}
   */
  async getAtlas() {
    const rel = path.join('08 - QA-and-Monitoring', 'ATLAS', 'atlas.json');
    try {
      const text = await this._readVaultFile(rel);
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { version: 1, updated: null, description: '', regions: [], gaps: [] };
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Task Board
  // -------------------------------------------------------------------------

  /**
   * Parse the Task Board markdown file.
   *
   * @returns {{
   *   inbox:      object[],
   *   inProgress: object[],
   *   blocked:    object[],
   *   done:       object[],
   *   notes:      string[],
   *   stats:      object
   * }}
   */
  async getTaskBoard() {
    const rel  = path.join('03 - Agents', 'Coordination', 'Task Board.md');
    const text = await this._readVaultFile(rel);

    const result = {
      inbox:      [],
      inProgress: [],
      parked:     [],
      blocked:    [],
      done:       [],
      notes:      [],
      stats:      {},
      source:     this._brainUsable() ? 'brain' : 'filesystem',
    };

    // ---- Split into sections by ## headings --------------------------------
    const sectionMap = {}; // heading text → array of lines
    let currentSection = '__preamble__';
    sectionMap[currentSection] = [];

    for (const line of text.split('\n')) {
      const hMatch = line.match(/^##\s+(.+)/);
      if (hMatch) {
        currentSection = hMatch[1].trim();
        sectionMap[currentSection] = [];
      } else {
        sectionMap[currentSection].push(line);
      }
    }

    // ---- Parse each kanban section -----------------------------------------
    const sectionAliases = {
      inbox:      ['inbox', '📥 inbox'],
      inProgress: ['in progress', '🔄 in progress', 'in-progress'],
      parked:     ['parked', '⏸ parked', '⏸️ parked'],
      blocked:    ['blocked', '🚫 blocked', '⛔ blocked'],
      done:       ['done', '✅ done', 'done (recent)', '✅ done (recent)'],
    };

    for (const [heading, lines] of Object.entries(sectionMap)) {
      const headingLower = heading.toLowerCase();
      let targetKey = null;
      for (const [key, aliases] of Object.entries(sectionAliases)) {
        if (aliases.some(a => headingLower.includes(a))) {
          targetKey = key;
          break;
        }
      }
      if (!targetKey) continue;

      const tableRows = parseMarkdownTable(lines);
      // Skip the header row (first non-separator row)
      const dataRows = tableRows.slice(1);

      for (const cells of dataRows) {
        if (!cells || cells.length === 0) continue;
        const task = this._parseTaskRow(cells, targetKey);
        if (task) result[targetKey].push(task);
      }
    }

    // ---- Stats / notes section ---------------------------------------------
    for (const [heading, lines] of Object.entries(sectionMap)) {
      const hl = heading.toLowerCase();
      if (hl.includes('stat') || hl.includes('note') || hl.includes('board')) {
        result.notes.push(...lines.filter(l => l.trim().length > 0));
      }
    }

    // Classify standing vs project from each task note (and heartbeat ties).
    // Standing tasks are removed from every workflow column, including In Progress.
    const heartbeats = await this.heartbeatIndex();
    const allTasks = [
      ...result.inbox, ...result.inProgress, ...result.parked, ...result.blocked, ...result.done,
    ];
    await Promise.all(allTasks.map(async (task) => {
      const docPath = taskDocRel(task);
      task._docPath = docPath;
      task._doc = '';
      if (!docPath) return;
      try { task._doc = await this._readVaultFile(docPath); }
      catch { task._doc = ''; }
    }));

    applyTaskTypes(result, (task) => {
      const content = task._doc || '';
      const docPath = task._docPath || null;
      delete task._doc;
      delete task._docPath;
      const { meta, body } = splitDocument(content);
      const clean = v => v ? String(v).replace(/^["']|["']$/g, '').trim() : '';
      if (meta.short_name) task.shortName = clean(meta.short_name);
      if (meta.description) task.description = clean(meta.description);
      if (!task.title && meta.title) task.title = clean(meta.title);
      if (docPath) task.docPath = docPath;
      return classifyTask({
        taskId: task.taskId,
        title: task.title || meta.title || '',
        frontmatter: meta,
        body,
        heartbeats,
        section: task.status,
      });
    });

    return result;
  }

  /**
   * Parse a single task table row into a structured object.
   *
   * Actual column layouts per section (from Task Board.md):
   *   Inbox:      Task ID | Title | Assigned To | Priority | Deadline | Created
   *   In Progress: Task ID | Title | Agent | Started | Deadline
   *   Blocked:    Task ID | Title | Agent | Blocked Since | Reason
   *   Done:       Task ID | Title | Agent | Completed | Output
   */
  _parseTaskRow(cells, status) {
    if (!cells[0]) return null;

    const rawId  = cells[0] || '';
    const taskId = extractTaskId(rawId) || stripBold(rawId);
    const link   = extractLink(rawId);

    if (!taskId) return null;
    // Skip placeholder rows like "| — | — | — | — | — |"
    if (/^[\s\-–—|]+$/.test(taskId)) return null;

    // Title is always cells[1]
    const rawTitle = cells[1] || '';
    const title    = stripBold(rawTitle.replace(/\[(.+?)\]\(.+?\)/g, '$1'));

    // Agent / assigned-to is always cells[2]
    const agent = stripBold(cells[2] || '');

    // Remaining columns differ by section
    let priority = '';
    let created  = '';
    let deadline = '';
    let reason   = '';   // blocked: why + what action is needed
    let output   = '';   // done: output/result notes

    if (status === 'inbox') {
      // | Assigned To | Priority | Deadline | Created |
      priority = stripBold(cells[3] || '');
      deadline = stripBold(cells[4] || '');
      created  = stripBold(cells[5] || '');
    } else if (status === 'inProgress') {
      // | Agent | Started | Deadline |
      created  = stripBold(cells[3] || '');  // Started date
      deadline = stripBold(cells[4] || '');
    } else if (status === 'blocked' || status === 'parked') {
      // Blocked: | Agent | Blocked Since | Reason |
      // Parked:  | Agent | Parked Since  | Note |
      created  = stripBold(cells[3] || '');
      reason   = stripBold(cells[4] || '');
    } else if (status === 'done') {
      // | Agent | Completed | Output |
      created  = stripBold(cells[3] || '');  // Completed date
      output   = stripBold(cells[4] || '');  // Output / result notes
    }

    return { taskId, title, agent, priority, deadline, created, reason, output, status, link };
  }

  // -------------------------------------------------------------------------
  // Agent Registry
  // -------------------------------------------------------------------------

  /**
   * Parse the Agent Registry markdown file.
   * Looks for the Active Agents table (columns: Nickname | Agent | Type | Machine | Account | Role | Status | Registered).
   *
   * @returns {object[]}  Array of agent objects.
   */
  async getAgentRegistry() {
    const rel  = path.join('03 - Agents', 'Agent Registry.md');
    const text = await this._readVaultFile(rel);

    const agents = [];
    const lines  = text.split('\n');

    // Find the table — look for a header row containing "Nickname" or "Agent"
    let inTable   = false;
    let headerRow = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed.startsWith('|')) {
        if (inTable) break; // end of table
        continue;
      }

      // Separator row
      if (/^\|[\s\-:|]+\|/.test(trimmed)) continue;

      const cells = trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(c => c.trim());

      if (!inTable) {
        // Check if this looks like the agents header
        const cellsLower = cells.map(c => c.toLowerCase());
        if (cellsLower.some(c => c.includes('nickname') || c.includes('agent'))) {
          inTable   = true;
          headerRow = cells.map(c => c.toLowerCase().replace(/\s+/g, '_'));
        }
        continue;
      }

      // Data row
      if (cells.every(c => c === '' || c === '-' || c === 'N/A')) continue;

      const agent = {};
      headerRow.forEach((key, i) => {
        agent[key] = stripBold(cells[i] || '');
      });
      agents.push(agent);
    }

    return agents;
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Task Files — individual task read + update
  // -------------------------------------------------------------------------

  /**
   * Read an individual task .md file and return parsed frontmatter fields.
   * @param {string} taskRelPath  e.g. "03 - Agents/Coordination/Tasks/TASK-xxx.md"
   */
  async getTaskFile(taskRelPath) {
    const norm = path.normalize(taskRelPath).replace(/\\/g, '/');
    if (!norm.startsWith('03 - Agents/') || !norm.endsWith('.md')) {
      throw new Error('getTaskFile: path not in allowed scope');
    }
    const text = await this._readVaultFile(norm);
    const fm   = this._parseFrontmatter(text) || {};
    let body = text;
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      if (end !== -1) body = text.slice(end + 4).trimStart();
    }
    const clean = v => v ? String(v).replace(/^["']|["']$/g, '').trim() : null;
    const heartbeats = await this.heartbeatIndex();
    const info = classifyTask({
      taskId: clean(fm.task_id || fm.taskId) || path.basename(norm, '.md'),
      title: clean(fm.title) || '',
      frontmatter: fm,
      body,
      heartbeats,
    });
    return {
      relPath:      norm,
      taskId:       clean(fm.task_id  || fm.taskId),
      shortName:    clean(fm.short_name),
      title:        clean(fm.title),
      status:       clean(fm.status),
      assignedTo:   clean(fm.assigned_to),
      priority:     clean(fm.priority),
      deadline:     clean(fm.deadline),
      description:  clean(fm.description),
      type:         info.type,
      typeSource:   info.typeSource,
      standingStatus: info.standingStatus,
      standing_status: info.standingStatus,
      cadence:      info.cadence,
      heartbeatJob: info.heartbeatJob,
      heartbeat_job: info.heartbeatJob,
      lastRun:      info.lastRun,
      rawFrontmatter: fm,
      bodyPreview:  body.slice(0, 1500),
    };
  }

  /**
   * Update frontmatter fields of an individual task file.
   * Allowed fields: short_name, title, priority, deadline, assigned_to, description, status
   */
  async updateTaskFile(taskRelPath, updates) {
    const norm = path.normalize(taskRelPath).replace(/\\/g, '/');
    if (!norm.startsWith('03 - Agents/') || !norm.endsWith('.md')) {
      throw new Error('updateTaskFile: path not in allowed scope');
    }
    const { assertTaskFields, upsertFrontmatter } = require('./taskClassification');
    assertTaskFields({
      type: updates.type,
      standing_status: updates.standing_status,
      cadence: updates.cadence,
    });
    const text = await this._readVaultFile(norm);

    const ALLOWED = [
      'short_name', 'title', 'priority', 'deadline', 'assigned_to', 'description', 'status',
      'type', 'standing_status', 'cadence', 'heartbeat_job',
    ];
    const patch = {};
    for (const field of ALLOWED) {
      if (!(field in updates)) continue;
      patch[field] = String(updates[field] == null ? '' : updates[field]).trim();
    }
    const next = upsertFrontmatter(text, patch);
    const written = await this._writeVaultFile(norm, next, {
      updatedBy: 'overclaw',
      changeNote: 'update task frontmatter',
    });
    return { ok: true, via: this._brainUsable() ? 'brain' : 'filesystem', version: written && written.version };
  }


  // Heartbeats
  // -------------------------------------------------------------------------

  /**
   * Scan heartbeat directories and return parsed entries.
   *
   * @param {{ machine?: string, limit?: number, includeHandled?: boolean }} opts
   * @returns {object[]}  Sorted newest-first.
   */
  async getHeartbeats(opts = {}) {
    const { machine = null, limit = 200, includeHandled = true } = opts;

    let entries = [];
    try {
      entries = await this._listHeartbeatEntries();
    } catch (err) {
      return [];
    }

    // Filter by machine if requested
    if (machine) {
      entries = entries.filter(e => e.machine === machine);
    }

    // Filter handled if requested
    if (!includeHandled) {
      entries = entries.filter(e => !e.isHandled);
    }

    // Sort newest-first
    entries.sort((a, b) => {
      if (b.date && a.date) return b.date.localeCompare(a.date);
      if (b.date) return 1;   // b has date, a does not → dated entry first
      if (a.date) return -1;  // a has date, b does not → dated entry first
      return b.filename.localeCompare(a.filename);
    });

    return limit ? entries.slice(0, limit) : entries;
  }

  /**
   * Heartbeat markdown under 08 - QA-and-Monitoring/Heartbeats/.
   * Reads brain.db when it is open; otherwise walks the vault directory.
   * Every entry has docPath (vault-relative) for content reads.
   */
  async _listHeartbeatEntries() {
    const rootRel = '08 - QA-and-Monitoring/Heartbeats';
    if (this._brainUsable()) {
      let rows = [];
      try {
        rows = this.brainStore.listDir(rootRel, { recursive: true });
      } catch {
        return [];
      }
      return rows
        .filter(r => r.path && r.path.endsWith('.md'))
        .map(r => {
          const relFromRoot = r.path.slice(rootRel.length + 1);
          const slash = relFromRoot.lastIndexOf('/');
          const relDir = slash === -1 ? '' : relFromRoot.slice(0, slash);
          const filename = slash === -1 ? relFromRoot : relFromRoot.slice(slash + 1);
          const parsed = this._parseHeartbeatFilename(filename, relDir);
          return {
            ...parsed,
            filename,
            relPath: relFromRoot,
            docPath: r.path.replace(/\\/g, '/'),
            absPath: r.path,
            source: 'brain',
          };
        });
    }

    const heartbeatRoot = path.join(this.vaultPath, '08 - QA-and-Monitoring', 'Heartbeats');
    try {
      const entries = await this._scanHeartbeatDir(heartbeatRoot, '');
      return entries.map(e => ({
        ...e,
        docPath: rootRel + '/' + String(e.relPath).split(path.sep).join('/'),
        source: 'filesystem',
      }));
    } catch {
      return [];
    }
  }

  /** Read a heartbeat entry from brain.db or the vault file. */
  async _readEntry(entry) {
    if (entry && entry.docPath) return this._readVaultFile(entry.docPath);
    return fs.readFile(entry.absPath, 'utf8');
  }

  /**
   * Compact heartbeat index for standing-task classification:
   * { date, job, type, filename, taskIds }.
   */
  async heartbeatIndex() {
    const entries = await this._listHeartbeatEntries();
    const out = [];
    await Promise.all(entries.map(async (entry) => {
      let content = '';
      try { content = await this._readEntry(entry); } catch { content = ''; }
      const fm = this._parseFrontmatter(content) || {};
      const taskIds = new Set();
      const re = /TASK-[A-Z0-9]+-\d+/g;
      let m;
      while ((m = re.exec(content))) taskIds.add(m[0]);
      out.push({
        date: entry.date,
        job: fm.job || null,
        type: entry.type,
        filename: entry.filename,
        taskIds: [...taskIds],
      });
    }));
    return out;
  }

  /**
   * Recursively scan a heartbeat subdirectory.
   * @param {string} rootDir   Absolute path to the Heartbeats root.
   * @param {string} relDir    Relative path from root (used to determine machine).
   */
  async _scanHeartbeatDir(rootDir, relDir) {
    const absDir  = path.join(rootDir, relDir);
    const entries = [];

    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return entries;
    }

    for (const dirent of dirents) {
      const name    = dirent.name;
      const relPath = relDir ? path.join(relDir, name) : name;

      if (dirent.isDirectory()) {
        const sub = await this._scanHeartbeatDir(rootDir, relPath);
        entries.push(...sub);
      } else if (dirent.isFile() && name.endsWith('.md')) {
        const parsed = this._parseHeartbeatFilename(name, relDir);
        entries.push({
          ...parsed,
          filename:  name,
          relPath,
          absPath:   path.join(absDir, name),
        });
      }
    }

    return entries;
  }

  /**
   * Extract metadata from a heartbeat filename and its parent directory path.
   *
   * Filename patterns:
   *   YYYY-MM-DD-HH-MM-<type>.md
   *   YYYY-MM-DD-<type>.md
   *   NEEDS-ATTENTION-YYYY-MM-DD-HH-MM-<type>.md
   *   HANDLED-YYYY-MM-DD-HH-MM-<type>.md
   */
  _parseHeartbeatFilename(filename, relDir) {
    return parseHbName(filename, relDir);
  }

  // -------------------------------------------------------------------------
  // Alerts — unified unresolved-issue list
  // -------------------------------------------------------------------------

  /**
   * Parse YAML-style frontmatter from a markdown file's content.
   * Returns null if no frontmatter block found.
   */
  _parseFrontmatter(content) {
    if (!content || !content.startsWith('---')) return null;
    const end = content.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = content.slice(3, end).trim();
    const result = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      // Strip surrounding quotes
      result[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return result;
  }

  /**
   * Return all unresolved issues as a unified alert list.
   *
   * Two sources:
   *   1. NEEDS-ATTENTION-* heartbeat files (not HANDLED) — always included
   *      regardless of the sort/limit used by getHeartbeats().
   *   2. Regular heartbeat files written within the last `recentDays` days
   *      whose frontmatter has a non-empty `errors` field or a failing `status`
   *      or `delivery_status`.
   *
   * @param {{ recentDays?: number }} opts
   * @returns {Promise<object[]>}  Sorted: NEEDS-ATTENTION first, then newest-first.
   */
  async getAlerts(opts = {}) {
    const { recentDays = 7 } = opts;

    let allEntries = [];
    try {
      allEntries = await this._listHeartbeatEntries();
    } catch {
      return [];
    }

    const alerts = [];
    const seenPaths = new Set();

    // 1. All unhandled NEEDS-ATTENTION files (no limit — these were being lost
    //    when their names don't start with a date and sort to the bottom of the
    //    general 200-entry window).
    for (const entry of allEntries) {
      if (entry.isAlert && !entry.isHandled) {
        // Try to read a one-line issue summary from frontmatter
        let summary = null;
        try {
          const content = await this._readEntry(entry);
          const fm = this._parseFrontmatter(content);
          summary = (fm && (fm.issue || fm.summary || fm.title)) || null;
        } catch { /* ok — summary stays null */ }
        alerts.push({ ...entry, alertSource: 'needs-attention', alertDetail: summary });
        seenPaths.add(entry.absPath);
      }
    }

    // 2. Recent regular heartbeat files with errors in frontmatter.
    //    De-duplicated by job+machine: only the LATEST run per (machine, type) pair
    //    is considered.  If the latest run is clean — or manually marked resolved:true —
    //    older errors for that job are suppressed (treated as resolved).
    //
    //    Manual resolution: add `resolved: "true"` (plus optional `resolved_at` /
    //    `resolved_by`) to a heartbeat file's frontmatter.  The primary agent does this
    //    when the operator reports a fix made directly on another host, before the next
    //    scheduled run has a chance to produce a clean result.
    const cutoffDate = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const recent = allEntries.filter(
      e => !e.isAlert && !e.isHandled && e.date && e.date.slice(0, 10) >= cutoffDate
    );

    // Read frontmatter once per file; build a map of the LATEST entry per (machine|type).
    const latestByGroup = new Map(); // key → { entry, fm }
    for (const entry of recent) {
      if (seenPaths.has(entry.absPath)) continue;
      let fm = null;
      let content = null;
      try {
        content = await this._readEntry(entry);
        fm = this._parseFrontmatter(content) || {};
      } catch { continue; }

      const key = `${entry.machine}|${entry.type}`;
      const existing = latestByGroup.get(key);
      if (!existing || (entry.date || '') > (existing.entry.date || '')) {
        latestByGroup.set(key, { entry, fm, content });
      }
    }

    // Emit an alert only when the LATEST run for a group still has an active error.
    for (const { entry, fm, content } of latestByGroup.values()) {
      if (seenPaths.has(entry.absPath)) continue;

      // Two resolution conventions:
      //   1. resolved:true + resolved_at/resolved_by  — set by the primary agent for direct fixes
      //   2. resolution_status:dispatched/closed      — set by the /resolve form workflow
      const resStatus   = (fm.resolution_status || '').toLowerCase().trim();
      const resolvedFlag = (fm.resolved || '').toLowerCase() === 'true'
        || resStatus === 'dispatched';
      // closed = definitively fixed at source → suppress the row entirely
      const suppressFlag = resStatus === 'closed';

      const errVal    = (fm.errors || '').replace(/^["']+|["']+$/g, '').trim();
      const statVal   = (fm.status || '').toLowerCase();
      const dlStatVal = (fm.delivery_status || '').toLowerCase();

      // A heartbeat is explicitly successful when status is success/ok AND
      // delivery_status (if present) is also success/ok.  In that case a
      // non-empty `errors` field is treated as informational documentation
      // (non-blocking warnings) rather than a hard error — do NOT emit HB-ERROR.
      const statusIsSuccess   = /^(success|ok)$/.test(statVal);
      const deliveryIsSuccess = !dlStatVal || /^(success|ok|n\/a)$/.test(dlStatVal);
      const explicitlySuccessful = statusIsSuccess && deliveryIsSuccess;

      const hasError = (!explicitlySuccessful && errVal && errVal !== '' && errVal !== 'none')
        || /fail|error/.test(statVal)
        || /fail|error/.test(dlStatVal);

      // Nothing to surface: clean run, or definitively closed
      if (!hasError || suppressFlag) continue;

      const detail = errVal
        || (statVal   ? `status: ${fm.status}` : '')
        || (dlStatVal ? `delivery: ${fm.delivery_status}` : '');

      // Resolve metadata: prefer explicit resolved_* fields, fall back to resolution_* fields
      const resolvedAt = fm.resolved_at || fm.resolution_dispatched_at || null;
      const resolvedBy = fm.resolved_by
        || (resStatus === 'dispatched' && fm.resolution_agent
              ? `Dispatched to ${fm.resolution_agent}` : null)
        || null;

      // Resolution note: frontmatter field takes priority; fall back to parsing the
      // markdown body for an "Instructions from <operator>:" blockquote (older files
      // written before resolution_note was added to the frontmatter).
      let resolutionNote = fm.resolution_note || null;
      if (!resolutionNote && content && resolvedFlag) {
        const instanceConfig = require('./instanceConfig');
        const nameAlts = instanceConfig.operatorNames().map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const noteMatch = content.match(
          new RegExp('\\*\\*Instructions from (?:' + nameAlts + '):\\*\\*\\s*\\n+((?:[ \\t]*>[ \\t]*.+\\n?)+)')
        );
        if (noteMatch) {
          resolutionNote = noteMatch[1]
            .split('\n')
            .map(l => l.replace(/^[ \t]*>[ \t]?/, '').trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 300);
        }
      }

      // resolvedFlag=true  → keep in list as pending verification (amber)
      // resolvedFlag=false → active error, needs attention (red)
      alerts.push({
        ...entry,
        alertSource:      'heartbeat-error',
        isResolved:       resolvedFlag,
        resolvedAt,
        resolvedBy,
        resolutionNote:   resolutionNote || null,
        resolutionStatus: resStatus || null,
        alertDetail: detail.length > 200 ? detail.slice(0, 200) + '…' : detail,
      });
    }

    // Sort: NEEDS-ATTENTION first, then active errors, then pending-verification, newest-first within each tier
    alerts.sort((a, b) => {
      const aNa  = a.alertSource === 'needs-attention' ? 0 : 1;
      const bNa  = b.alertSource === 'needs-attention' ? 0 : 1;
      if (aNa !== bNa) return aNa - bNa;
      // Resolved/pending items sink below active alerts within the same source tier
      const aRes = a.isResolved ? 1 : 0;
      const bRes = b.isResolved ? 1 : 0;
      if (aRes !== bRes) return aRes - bRes;
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return a.filename.localeCompare(b.filename);
    });

    return alerts.slice(0, 30);
  }

  // -------------------------------------------------------------------------
  // Arbitrary .md file access (security-checked)
  // -------------------------------------------------------------------------

  /**
   * Close (suppress) active heartbeat-error alerts for a given machine + job.
   *
   * Called by monitors when they detect a recovery (FAILED → OK).  Finds the
   * most-recent heartbeat file for the machine/job combination whose
   * frontmatter still shows an active error (resolution_status not already
   * "closed") and stamps it with `resolution_status: closed` so VaultReader's
   * getAlerts() suppresses it immediately — no waiting for the next cron run.
   *
   * @param {string} machine   Machine subdirectory name, e.g. "Server-1", "OpenClaw"
   * @param {string} jobName   Job identifier — tolerates dashes, underscores, spaces;
   *                           matched against the `job` frontmatter field first,
   *                           then against the filename-derived `type` field.
   * @param {object} [opts]
   * @param {string} [opts.note]   Short resolution note appended to file.
   * @param {string} [opts.closedBy]  Attribution string (default: "auto-recovery").
   * @returns {Promise<{closed: number, files: string[]}>}
   */
  async closeHeartbeatAlerts(machine, jobName, opts = {}) {
    const { note = 'Source recovered — auto-closed on recovery detection.', closedBy = 'auto-recovery' } = opts;

    let allEntries = [];
    try {
      allEntries = await this._listHeartbeatEntries();
    } catch {
      return { closed: 0, files: [] };
    }

    // Normalize jobName for flexible matching
    const normalizeJob = s => (s || '').toLowerCase().replace(/[-_ ]+/g, ' ').trim();
    const targetJob = normalizeJob(jobName);
    const targetMachine = (machine || '').toLowerCase();

    // Find candidates: regular (non-alert, non-handled) heartbeat files for this
    // machine + job that are not already closed.
    const candidates = [];
    for (const entry of allEntries) {
      if (entry.isAlert || entry.isHandled) continue;
      if (entry.machine.toLowerCase() !== targetMachine) continue;

      let fm = null;
      let content = null;
      try {
        content = await this._readEntry(entry);
        fm = this._parseFrontmatter(content) || {};
      } catch { continue; }

      // Already closed — skip
      const resStatus = (fm.resolution_status || '').toLowerCase().trim();
      if (resStatus === 'closed') continue;

      // Match by frontmatter `job` field first, then filename-derived type
      const fmJob = normalizeJob(fm.job || '');
      const typeJob = normalizeJob(entry.type || '');
      if (fmJob !== targetJob && typeJob !== targetJob) continue;

      candidates.push({ entry, fm, content });
    }

    if (candidates.length === 0) return { closed: 0, files: [] };

    // Sort newest-first, patch all with active errors
    candidates.sort((a, b) => (b.entry.date || '').localeCompare(a.entry.date || ''));

    const now = new Date();
    const nowISO = now.toISOString();
    const nowET  = now.toLocaleString('en-US', { timeZone: 'America/New_York',
                                                  dateStyle: 'medium', timeStyle: 'short' });

    const closed = [];
    for (const { entry, fm, content } of candidates) {
      // Only patch files that actually have an active error surfaced in feed logic
      const errVal    = (fm.errors || '').replace(/^["']+|["']+$/g, '').trim();
      const statVal   = (fm.status || '').toLowerCase();
      const dlStatVal = (fm.delivery_status || '').toLowerCase();
      const statusIsSuccess   = /^(success|ok)$/.test(statVal);
      const deliveryIsSuccess = !dlStatVal || /^(success|ok|n\/a)$/.test(dlStatVal);
      const hasError = (!(statusIsSuccess && deliveryIsSuccess) && errVal && errVal !== '' && errVal !== 'none')
        || /fail|error/.test(statVal)
        || /fail|error/.test(dlStatVal);
      if (!hasError) continue;

      // Patch frontmatter: add resolution_status + resolution_closed_at
      let fmLines = [];
      let body    = content;
      if (content.startsWith('---')) {
        const end = content.indexOf('\n---', 3);
        if (end !== -1) {
          fmLines = content.slice(3, end).trim().split('\n');
          body    = content.slice(end + 4).trimStart();
        }
      }
      const fmKeep = fmLines.filter(l =>
        !l.startsWith('resolution_status:') &&
        !l.startsWith('resolution_closed_at:') &&
        !l.startsWith('resolution_closed_by:')
      );
      fmKeep.push(`resolution_status: closed`);
      fmKeep.push(`resolution_closed_at: ${nowISO}`);
      fmKeep.push(`resolution_closed_by: ${closedBy}`);
      const newFm = '---\n' + fmKeep.join('\n') + '\n---';

      const histEntry = [
        '',
        `### Auto-closed — ${nowET}`,
        `**Closed by:** ${closedBy}  `,
        `**Note:** ${note}`,
        '',
      ].join('\n');
      let newBody;
      if (body.includes('## 🔧 Resolution History')) {
        newBody = body.trimEnd() + '\n' + histEntry;
      } else {
        newBody = body.trimEnd() + '\n\n---\n\n## 🔧 Resolution History\n' + histEntry;
      }
      const target = entry.docPath || entry.relPath;
      await this._writeVaultFile(target, newFm + '\n\n' + newBody, {
        updatedBy: closedBy || 'overclaw',
        changeNote: 'resolution_status: closed',
      });
      closed.push(entry.relPath);
    }

    return { closed: closed.length, files: closed };
  }

  /**
   * Read any .md file from the vault.
   * Security: path must resolve inside vaultPath; only .md files allowed.
   * @param {string} relPath  Path relative to vault root (may contain spaces/special chars)
   * @returns {Promise<string>}  File contents as UTF-8 string
   */
  async getFile(relPath) {
    if (!relPath || typeof relPath !== 'string') throw new Error('relPath required');
    const rel = this._normRel(relPath);
    if (rel.includes('..')) throw new Error('Path traversal denied');
    if (path.posix.extname(rel).toLowerCase() !== '.md') throw new Error('Only .md files allowed');
    return this._readVaultFile(rel);
  }

  /**
   * List a vault directory. Returns dirs + .md files only.
   * Empty relPath = vault root.
   */
  async listDir(relPath) {
    const rel = this._normRel(relPath || '');
    if (rel.includes('..')) throw new Error('Path traversal denied');
    if (this._brainUsable()) {
      const rows = this.brainStore.listDir(rel, { recursive: false });
      const entries = [];
      for (const row of rows) {
        if (row.type === 'dir') {
          entries.push({ name: row.name, type: 'dir', path: row.path });
        } else if (row.type === 'file' && String(row.name || '').endsWith('.md')) {
          entries.push({ name: row.name, type: 'file', path: row.path });
        }
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      let readme = null;
      for (const v of ['README.md', 'readme.md', 'Readme.md', 'Home.md']) {
        const candidate = rel ? rel + '/' + v : v;
        if (this.brainStore.getDoc(candidate)) { readme = candidate; break; }
      }
      return {
        type: 'directory',
        path: rel,
        name: rel ? path.posix.basename(rel) : 'Vault Root',
        entries,
        readme,
        source: 'brain',
      };
    }
    const vaultAbs = path.resolve(this.vaultPath);
    const abs = rel ? path.resolve(vaultAbs, rel) : vaultAbs;
    if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
      throw new Error('Path traversal denied');
    }
    const rawEntries = await fs.readdir(abs, { withFileTypes: true });
    const entries = [];
    for (const e of rawEntries) {
      if (e.name.startsWith('.')) continue;
      const entryRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        entries.push({ name: e.name, type: 'dir', path: entryRel });
      } else if (e.name.endsWith('.md')) {
        entries.push({ name: e.name, type: 'file', path: entryRel });
      }
    }
    // Dirs first, then files, both alpha
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    // Auto-detect README
    let readme = null;
    for (const v of ['README.md', 'readme.md', 'Readme.md', 'Home.md']) {
      try {
        await fs.access(path.join(abs, v));
        readme = relPath ? relPath + '/' + v : v;
        break;
      } catch {}
    }
    return {
      type: 'directory',
      path: relPath || '',
      name: relPath ? path.basename(relPath) : 'Vault Root',
      entries,
      readme,
    };
  }

  // -------------------------------------------------------------------------
  // Vault graph builder
  // -------------------------------------------------------------------------

  /**
   * Build a node/edge graph of all .md files and their wiki/md links.
   * Results are cached for 5 minutes.
   * @returns {{ nodes: object[], edges: object[], scannedAt: string, totalFiles: number }}
   */
  async buildGraph() {
    if (this._brainUsable()) {
      const graph = this.brainStore.buildGraph();
      graph.source = 'brain';
      return graph;
    }
    // 5-minute cache
    if (this._graphCache && (Date.now() - this._graphCacheAt < 5 * 60 * 1000)) {
      return this._graphCache;
    }

    const vaultAbs = path.resolve(this.vaultPath);

    // Recursively collect all .md files
    async function scanDir(dir, relBase) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // skip hidden
        const fullPath = path.join(dir, e.name);
        const relPath  = relBase ? relBase + '/' + e.name : e.name;
        if (e.isDirectory()) {
          files = files.concat(await scanDir(fullPath, relPath));
        } else if (e.name.endsWith('.md')) {
          files.push({ abs: fullPath, rel: relPath });
        }
      }
      return files;
    }

    const files = await scanDir(vaultAbs, '');

    // Build a name→relPath map for wiki link resolution
    const nameMap = {}; // lowercased basename (without .md) → relPath
    for (const f of files) {
      const base = path.basename(f.rel, '.md').toLowerCase();
      nameMap[base] = f.rel;
    }

    // Parse each file for links
    const nodeMap = {}; // relPath → { id, name, dir, links: Set }
    for (const f of files) {
      const topDir = f.rel.split('/')[0] || 'root';
      nodeMap[f.rel] = {
        id:    f.rel,
        name:  path.basename(f.rel, '.md'),
        dir:   topDir,
        links: new Set(),
      };
    }

    // Extract links from each file
    for (const f of files) {
      let content;
      try { content = await fs.readFile(f.abs, 'utf8'); } catch { continue; }
      const node    = nodeMap[f.rel];
      const fileDir = path.dirname(f.rel); // for resolving relative links

      // [[WikiLink]] and [[WikiLink|Display]]
      const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let m;
      while ((m = wikiRe.exec(content)) !== null) {
        const linkName = m[1].trim().toLowerCase();
        const target   = nameMap[linkName];
        if (target && target !== f.rel) node.links.add(target);
      }

      // [text](relative.md) links
      const mdLinkRe = /\[(?:[^\]]*)]\(([^)]+\.md)\)/g;
      while ((m = mdLinkRe.exec(content)) !== null) {
        const href = m[1].split('#')[0].trim(); // strip anchors
        if (href.startsWith('http')) continue;
        const base     = fileDir === '.' ? href : fileDir + '/' + href;
        const resolved = path.normalize(base).replace(/\\/g, '/');
        if (nodeMap[resolved] && resolved !== f.rel) node.links.add(resolved);
      }

      // `backtick.md` references — agents often cite vault files in code spans
      // Only resolves when the basename exactly matches a known vault file
      const btRe = /`([^`\n]*\.md)`/g;
      while ((m = btRe.exec(content)) !== null) {
        const baseName = path.basename(m[1].trim(), '.md').toLowerCase();
        const target   = nameMap[baseName];
        if (target && target !== f.rel) node.links.add(target);
      }
    }

    // Build output
    const nodes  = [];
    const edges  = [];
    const edgeSet = new Set();

    for (const [id, node] of Object.entries(nodeMap)) {
      nodes.push({
        id,
        name:   node.name,
        dir:    node.dir,
        degree: node.links.size,
      });
      for (const target of node.links) {
        const key = id < target ? `${id}\u2192${target}` : `${target}\u2192${id}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: id, target });
        }
      }
    }

    const result = {
      nodes,
      edges,
      scannedAt:  new Date().toISOString(),
      totalFiles: files.length,
    };

    this._graphCache   = result;
    this._graphCacheAt = Date.now();

    return result;
  }

  // -------------------------------------------------------------------------
  // Raw file access (whitelisted)
  // -------------------------------------------------------------------------

  /**
   * Read an arbitrary vault file.  For security, only .md files under
   * 03 - Agents/ and 08 - QA-and-Monitoring/ are permitted.
   *
   * @param {string} relPath  Path relative to vault root.
   * @returns {string}        File contents as UTF-8 string.
   */
  async getRawFile(relPath) {
    // Security whitelist
    const normalized = path.normalize(relPath);
    const allowed    =
      normalized.startsWith('03 - Agents') ||
      normalized.startsWith('08 - QA-and-Monitoring');

    if (!allowed || !normalized.endsWith('.md')) {
      throw new Error(`VaultReader.getRawFile: path not in whitelist: ${relPath}`);
    }

    return this._readVaultFile(normalized);
  }

  // -------------------------------------------------------------------------
  // Activity Heatmap
  // -------------------------------------------------------------------------

  /**
   * Return 7-day vault commit activity grouped by agent and date.
   * Agents are identified by author name patterns in git log.
   *
   * @returns {{ days: string[], agents: { name: string, color: string, counts: number[] }[], raw: object }}
   */
  async getActivityHeatmap() {
    // Build list of last 7 calendar dates (YYYY-MM-DD), oldest first
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    const since = new Date();
    since.setDate(since.getDate() - 8);
    const sinceStr = since.toISOString().slice(0, 10);

    let lines = '';
    if (this._brainUsable()) {
      lines = this._brainActivityLines(since.getTime());
    } else {
      const { execFile } = require('child_process');
      lines = await new Promise((resolve) => {
        execFile(
          'git',
          ['-C', this.vaultPath, 'log',
           `--since=${sinceStr}`,
           '--pretty=format:%ad|%an',
           '--date=format:%Y-%m-%d'],
          { timeout: 10000 },
          (err, stdout) => resolve(err ? '' : stdout)
        );
      });
    }

    // Color palette — stable per nickname, fallback by index for new agents
    const COLOR_PALETTE = [
      '#f97316', '#3b82f6', '#a855f7', '#10b981', '#eab308',
      '#ec4899', '#14b8a6', '#6366f1', '#84cc16', '#f43f5e',
    ];
    const instCfg = (() => { try { return require('./instanceConfig').readInstanceConfig(); } catch { return {}; } })();
    const KNOWN_COLORS = instCfg.agentColors || {};
    const EXTRA_PATTERNS_MAP = instCfg.gitAuthorPatterns || {};

    // Build agentDefs dynamically from vault registry (only Active agents)
    let agentDefs = [];
    try {
      const registryAgents = await this.getAgentRegistry();
      agentDefs = registryAgents
        .filter(a => (a.status || '').includes('Active'))
        .map((a, i) => {
          const nick  = (a.nickname || '').trim();
          const lc    = nick.toLowerCase();
          const color = KNOWN_COLORS[lc] || COLOR_PALETTE[i % COLOR_PALETTE.length];
          const pat   = EXTRA_PATTERNS_MAP[lc]
            ? new RegExp(EXTRA_PATTERNS_MAP[lc], 'i')
            : new RegExp(nick.replace(/[-[\]/{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
          return { name: nick, pattern: pat, color };
        });
    } catch {}

    // Fallback if vault registry unavailable
    if (!agentDefs.length) {
      const fallbacks = instCfg.heatmapFallbackAgents || [];
      agentDefs = fallbacks.map(f => ({
        name: f.name,
        pattern: new RegExp(f.pattern || String(f.name).replace(/[-[\]/{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i'),
        color: f.color || '#6b7280',
      }));
    }

    // Count commits per agent per day
    const counts = {}; // agentName -> { date -> count }
    for (const def of agentDefs) counts[def.name] = {};

    for (const line of lines.split('\n')) {
      const [date, author] = line.split('|');
      if (!date || !author) continue;
      if (!days.includes(date)) continue;
      for (const def of agentDefs) {
        if (def.pattern.test(author)) {
          counts[def.name][date] = (counts[def.name][date] || 0) + 1;
          break;
        }
      }
    }

    // Shape into arrays aligned with days[]
    const agents = agentDefs.map(def => ({
      name:   def.name,
      color:  def.color,
      counts: days.map(d => counts[def.name][d] || 0),
    }));

    return { days, agents };
  }

  // -------------------------------------------------------------------------
  // Agent work-log fallback
  // -------------------------------------------------------------------------

  /**
   * Return the date string of the most recent dated .md file in any vault directory.
   * Used as a "last seen" fallback for agents that write work logs
   * to 03 - Agents/<dir>/ instead of the heartbeat directory.
   *
   * @param {string} relDir  Relative vault path, e.g. '03 - Agents/Cursor'
   * @returns {string|null}  'YYYY-MM-DD' string, or null if none found
   */
  _brainActivityLines(sinceMs) {
    let events = [];
    try {
      events = this.brainStore.listActivitySince(sinceMs).filter(e => e.op === 'write');
    } catch { events = []; }
    if (!events.length) {
      try {
        events = this.brainStore.listDocsUpdatedSince(sinceMs).map(d => ({
          agent: d.updated_by || 'unknown',
          ts: d.updated_at,
        }));
      } catch { events = []; }
    }
    return events.map(e => {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      return day + '|' + (e.agent || 'unknown');
    }).join('\n');
  }

  async getLatestEntryDate(relDir) {
    const rel = this._normRel(relDir);
    if (this._brainUsable()) {
      try {
        const rows = this.brainStore.listDir(rel, { recursive: false });
        const dated = rows
          .filter(r => r.type === 'file' && r.name && r.name.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(r.name))
          .map(r => r.name)
          .sort()
          .reverse();
        if (!dated.length) return null;
        const match = dated[0].match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    }
    const dir = path.join(this.vaultPath, rel);
    try {
      const files = await fs.readdir(dir);
      const dated = files
        .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(f))
        .sort()
        .reverse();
      if (!dated.length) return null;
      const match = dated[0].match(/^(\d{4}-\d{2}-\d{2})/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * Return all notification files for a given agent.
   * Stored in: 03 - Agents/Notifications/<agentName>/
   * Files prefixed with HANDLED- are already acknowledged.
   *
   * @param {string} agentName   e.g. 'North', 'West'
   * @returns {object[]}         Sorted newest-first.
   */
  async getNotifications(agentName) {
    const safeName = String(agentName || '').replace(/[\\/]/g, '');
    const dirRel = '03 - Agents/Notifications/' + safeName;
    if (this._brainUsable()) {
      try {
        const rows = this.brainStore.listDir(dirRel, { recursive: false })
          .filter(r => r.type === 'file' && r.name && r.name.endsWith('.md'));
        const results = [];
        for (const row of rows) {
          const isHandled = row.name.startsWith('HANDLED-');
          let content = null;
          try { content = (this.brainStore.getDoc(row.path) || {}).content || null; } catch { content = null; }
          const taskIdMatch = row.name.match(/TASK-[A-Z0-9]+-\d+/);
          const dateMatch = row.name.match(/^(?:HANDLED-)?(?:NEEDS-ATTENTION-)?(?:NEEDS-ATTENTION_)?(\d{4}-\d{2}-\d{2})/);
          results.push({
            filename: row.name,
            relPath: row.path,
            isHandled,
            taskId: taskIdMatch ? taskIdMatch[0] : null,
            date: dateMatch ? dateMatch[1] : null,
            content,
          });
        }
        return results.sort((a, b) => b.filename.localeCompare(a.filename));
      } catch {
        return [];
      }
    }
    const dir = path.join(this.vaultPath, '03 - Agents', 'Notifications', safeName);
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      const results = [];
      for (const d of dirents) {
        if (!d.isFile() || !d.name.endsWith('.md')) continue;
        const isHandled = d.name.startsWith('HANDLED-');
        let content = null;
        try { content = await fs.readFile(path.join(dir, d.name), 'utf-8'); } catch {}
        const taskIdMatch = d.name.match(/TASK-[A-Z0-9]+-\d+/);
        const dateMatch   = d.name.match(/^(?:HANDLED-)?(?:NEEDS-ATTENTION-)?(?:NEEDS-ATTENTION_)?(\d{4}-\d{2}-\d{2})/);
        results.push({
          filename:  d.name,
          relPath:   path.join('03 - Agents', 'Notifications', agentName, d.name),
          isHandled,
          taskId:    taskIdMatch ? taskIdMatch[0] : null,
          date:      dateMatch   ? dateMatch[1]   : null,
          content,
        });
      }
      return results.sort((a, b) => b.filename.localeCompare(a.filename));
    } catch {
      return []; // Directory doesn't exist yet — that's fine
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async _readVaultFile(relPath) {
    const rel = this._normRel(relPath);
    if (!rel || rel.includes('..')) {
      const err = new Error('Path traversal denied');
      err.code = 'EPERM';
      throw err;
    }
    if (this._brainUsable()) {
      try {
        const doc = this.brainStore.getDoc(rel);
        if (!doc) {
          const err = new Error('ENOENT: no brain document at ' + rel);
          err.code = 'ENOENT';
          throw err;
        }
        return doc.content;
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EPERM') throw err;
        // Database became unusable mid-read — fall through to the vault files.
      }
    }
    const abs = path.join(this.vaultPath, rel);
    return fs.readFile(abs, 'utf-8');
  }

  /**
   * Write a vault-relative document. Uses BrainStore.putDoc (version snapshot)
   * when brain.db is open. Filesystem write is only the fallback.
   */
  async _writeVaultFile(relPath, content, { updatedBy = 'overclaw', changeNote = null, forceFilesystem = false } = {}) {
    const rel = this._normRel(relPath);
    if (!rel || rel.includes('..')) throw new Error('Path traversal denied');
    if (!forceFilesystem && this._brainUsable()) {
      return this.brainStore.putDoc(rel, content, { updatedBy, changeNote });
    }
    const abs = path.join(this.vaultPath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { via: 'filesystem' };
  }
}

module.exports = VaultReader;
