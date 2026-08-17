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
   * @param {string} vaultPath  Absolute path to the Obsidian vault root.
   */
  constructor(vaultPath) {
    if (!vaultPath || typeof vaultPath !== 'string') {
      throw new Error('VaultReader: vaultPath must be a non-empty string');
    }
    this.vaultPath = vaultPath;
    this.lastSyncAt = null;   // null = never pulled by OverClaw
    this.syncInProgress = false;
  }

  // -------------------------------------------------------------------------
  // Vault git sync
  // -------------------------------------------------------------------------

  /**
   * Run `git pull` inside the vault directory.
   * Safe to call concurrently — debounced if already in progress.
   * @returns {{ ok: boolean, stdout?: string, stderr?: string, error?: string, skipped?: boolean }}
   */
  async sync() {
    if (this.syncInProgress) {
      return { ok: true, skipped: true, message: 'sync already in progress' };
    }
    this.syncInProgress = true;
    try {
      const { execFile } = require('child_process');
      const result = await new Promise((resolve) => {
        execFile('git', ['-C', this.vaultPath, 'pull', '--ff-only', '--quiet'], { timeout: 30000 }, (err, stdout, stderr) => {
          resolve({ err, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
      if (result.err) {
        return { ok: false, error: result.err.message, stderr: result.stderr };
      }
      this.lastSyncAt = new Date().toISOString();
      return { ok: true, stdout: result.stdout, lastSyncAt: this.lastSyncAt };
    } finally {
      this.syncInProgress = false;
    }
  }

  // -------------------------------------------------------------------------
  // Availability check
  // -------------------------------------------------------------------------

  /**
   * Test whether the vault directory is readable.
   * @returns {{ available: boolean, path: string, error?: string }}
   */
  async isAvailable() {
    try {
      await fs.access(this.vaultPath);
      const stat = await fs.stat(this.vaultPath);
      if (!stat.isDirectory()) {
        return { available: false, path: this.vaultPath, error: 'Vault path is not a directory' };
      }
      return { available: true, path: this.vaultPath };
    } catch (err) {
      return { available: false, path: this.vaultPath, error: err.message };
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
      blocked:    [],
      done:       [],
      notes:      [],
      stats:      {},
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

    // Aggregate counts
    result.stats = {
      total:      result.inbox.length + result.inProgress.length + result.blocked.length + result.done.length,
      inbox:      result.inbox.length,
      inProgress: result.inProgress.length,
      blocked:    result.blocked.length,
      done:       result.done.length,
    };

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
    } else if (status === 'blocked') {
      // | Agent | Blocked Since | Reason |
      created  = stripBold(cells[3] || '');  // Blocked Since
      reason   = stripBold(cells[4] || '');  // Why blocked + action needed
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

    const heartbeatRoot = path.join(this.vaultPath, '08 - QA-and-Monitoring', 'Heartbeats');

    let entries = [];

    try {
      entries = await this._scanHeartbeatDir(heartbeatRoot, '');
    } catch (err) {
      // Heartbeats directory may not exist yet — return empty
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
    let name      = filename.replace(/\.md$/, '');
    let isAlert   = false;
    let isHandled = false;

    if (name.startsWith('NEEDS-ATTENTION-') || name.startsWith('NEEDS-ATTENTION_')) {
      isAlert = true;
      name    = name.replace(/^NEEDS-ATTENTION[-_]/, '');
    } else if (name.startsWith('HANDLED-') || name.startsWith('HANDLED_')) {
      isHandled = true;
      name      = name.replace(/^HANDLED[-_]/, '');
    }

    // Try to extract date/time from beginning of remaining name
    let date = null;
    let type = name;

    // YYYY-MM-DD-HH-MM-...
    const dtMatch = name.match(/^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})[-_]?(.*)$/);
    if (dtMatch) {
      // Normalize: 2025-01-15-09-30 → 2025-01-15T09:30
      date = dtMatch[1].replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/, '$1T$2:$3');
      type = dtMatch[2] || 'heartbeat';
    } else {
      // YYYY-MM-DD-...
      const dMatch = name.match(/^(\d{4}-\d{2}-\d{2})[-_]?(.*)$/);
      if (dMatch) {
        date = dMatch[1];
        type = dMatch[2] || 'heartbeat';
      }
    }

    // Determine machine from relDir path segments
    // e.g.  "BrightMove-MBP"  or  "H2FClanker1"  or  "BrightMove-MBP/Cursor"
    const parts   = relDir ? relDir.split(path.sep) : [];
    const machine = parts[0] || 'unknown';
    // Sub-agent (e.g. Cursor running on BrightMove-MBP)
    const subAgent = parts.length > 1 ? parts.slice(1).join('/') : null;

    return {
      machine,
      subAgent,
      date,
      type: type.replace(/[-_]/g, ' ').trim(),
      isAlert,
      isHandled,
    };
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
    const heartbeatRoot = path.join(this.vaultPath, '08 - QA-and-Monitoring', 'Heartbeats');

    let allEntries = [];
    try {
      allEntries = await this._scanHeartbeatDir(heartbeatRoot, '');
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
          const content = await fs.readFile(entry.absPath, 'utf8');
          const fm = this._parseFrontmatter(content);
          summary = (fm && (fm.issue || fm.summary || fm.title)) || null;
        } catch { /* ok — summary stays null */ }
        alerts.push({ ...entry, alertSource: 'needs-attention', alertDetail: summary });
        seenPaths.add(entry.absPath);
      }
    }

    // 2. Recent regular heartbeat files with errors in frontmatter
    const cutoffDate = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const recent = allEntries.filter(
      e => !e.isAlert && !e.isHandled && e.date && e.date.slice(0, 10) >= cutoffDate
    );

    for (const entry of recent) {
      if (seenPaths.has(entry.absPath)) continue;
      try {
        const content = await fs.readFile(entry.absPath, 'utf8');
        const fm = this._parseFrontmatter(content);
        if (!fm) continue;

        const errVal = (fm.errors || '').replace(/^["']+|["']+$/g, '').trim();
        const statVal = (fm.status || '').toLowerCase();
        const dlStatVal = (fm.delivery_status || '').toLowerCase();

        const hasError = (errVal && errVal !== '' && errVal !== 'none')
          || /fail|error/.test(statVal)
          || /fail|error/.test(dlStatVal);

        if (hasError) {
          const detail = errVal
            || (statVal   ? `status: ${fm.status}` : '')
            || (dlStatVal ? `delivery: ${fm.delivery_status}` : '');
          alerts.push({
            ...entry,
            alertSource: 'heartbeat-error',
            alertDetail: detail.length > 200 ? detail.slice(0, 200) + '…' : detail,
          });
        }
      } catch { /* skip unreadable files */ }
    }

    // Sort: NEEDS-ATTENTION first, then newest-first by date
    alerts.sort((a, b) => {
      const aNa = a.alertSource === 'needs-attention' ? 0 : 1;
      const bNa = b.alertSource === 'needs-attention' ? 0 : 1;
      if (aNa !== bNa) return aNa - bNa;
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
   * Read any .md file from the vault.
   * Security: path must resolve inside vaultPath; only .md files allowed.
   * @param {string} relPath  Path relative to vault root (may contain spaces/special chars)
   * @returns {Promise<string>}  File contents as UTF-8 string
   */
  async getFile(relPath) {
    if (!relPath || typeof relPath !== 'string') throw new Error('relPath required');
    const vaultAbs = path.resolve(this.vaultPath);
    const abs = path.resolve(vaultAbs, relPath);
    if (!abs.startsWith(vaultAbs + path.sep) && abs !== vaultAbs) {
      throw new Error('Path traversal denied');
    }
    if (path.extname(abs).toLowerCase() !== '.md') throw new Error('Only .md files allowed');
    return await fs.readFile(abs, 'utf8');
  }

  /**
   * List a vault directory. Returns dirs + .md files only.
   * Empty relPath = vault root.
   */
  async listDir(relPath) {
    const vaultAbs = path.resolve(this.vaultPath);
    const abs = relPath ? path.resolve(vaultAbs, relPath) : vaultAbs;
    if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
      throw new Error('Path traversal denied');
    }
    const rawEntries = await fs.readdir(abs, { withFileTypes: true });
    const entries = [];
    for (const e of rawEntries) {
      if (e.name.startsWith('.')) continue;
      const entryRel = relPath ? relPath + '/' + e.name : e.name;
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
    const { execFile } = require('child_process');

    // Build list of last 7 calendar dates (YYYY-MM-DD), oldest first
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    // Run git log for the past 8 days to cover timezone edge cases
    const since = new Date();
    since.setDate(since.getDate() - 8);
    const sinceStr = since.toISOString().slice(0, 10);

    const lines = await new Promise((resolve) => {
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

    // Agent name patterns → canonical name
    const agentDefs = [
      { name: 'Spike',  pattern: /spike/i,  color: '#f97316' },
      { name: 'Steve',  pattern: /steve/i,  color: '#3b82f6' },
      { name: 'Lex',    pattern: /lex|cursor/i, color: '#a855f7' },
      { name: 'Bill',   pattern: /bill|h2fclanker1/i, color: '#10b981' },
    ];

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
   * Used as a "last seen" fallback for agents (e.g. Lex) that write work logs
   * to 03 - Agents/<dir>/ instead of the heartbeat directory.
   *
   * @param {string} relDir  Relative vault path, e.g. '03 - Agents/Cursor'
   * @returns {string|null}  'YYYY-MM-DD' string, or null if none found
   */
  async getLatestEntryDate(relDir) {
    const dir = path.join(this.vaultPath, relDir);
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
   * @param {string} agentName   e.g. 'Spike', 'Steve'
   * @returns {object[]}         Sorted newest-first.
   */
  async getNotifications(agentName) {
    const dir = path.join(this.vaultPath, '03 - Agents', 'Notifications', agentName);
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
    const abs = path.join(this.vaultPath, relPath);
    return fs.readFile(abs, 'utf-8');
  }
}

module.exports = VaultReader;
