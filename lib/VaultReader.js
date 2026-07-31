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
   * Columns vary — we try to detect them by position and content.
   *
   * Common layouts:
   *   | Task ID | Title | Agent | Priority | Deadline | Created |
   *   | Task ID | Title | Assigned To | Priority | Started | Blocked Since |
   */
  _parseTaskRow(cells, status) {
    if (!cells[0]) return null;

    const rawId   = cells[0] || '';
    const taskId  = extractTaskId(rawId) || stripBold(rawId);
    const link    = extractLink(rawId);

    if (!taskId) return null;

    // Try to find title in cells[1]; strip bold, strip markdown links
    const rawTitle = cells[1] || '';
    const title    = stripBold(rawTitle.replace(/\[(.+?)\]\(.+?\)/g, '$1'));

    // Remaining cells: heuristic assignment
    const agent    = stripBold(cells[2] || '');
    const priority = stripBold(cells[3] || '');
    const col4     = stripBold(cells[4] || '');  // deadline or started
    const col5     = stripBold(cells[5] || '');  // created or blocked-since

    return {
      taskId,
      title,
      agent,
      priority,
      deadline:   status === 'inProgress' || status === 'blocked' ? col5 : col4,
      created:    status === 'inProgress' || status === 'blocked' ? col4 : col5,
      status,
      link,
    };
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
  // Internal helpers
  // -------------------------------------------------------------------------

  async _readVaultFile(relPath) {
    const abs = path.join(this.vaultPath, relPath);
    return fs.readFile(abs, 'utf-8');
  }
}

module.exports = VaultReader;
