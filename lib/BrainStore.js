'use strict';

/**
 * BrainStore.js
 *
 * Centralized document database for the AI Brain.
 * Replaces the Git/vault-sync distributed model.
 *
 * Storage: SQLite (better-sqlite3) — single brain.db file
 * Features:
 *   - ACID transactional writes
 *   - Full version history (full snapshot per write)
 *   - FTS5 full-text search across all documents
 *   - Hierarchical path structure (MD files, browsable)
 *
 * All paths are relative to vault root, e.g.:
 *   "03 - Agents/Coordination/Task Board.md"
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  path        TEXT    PRIMARY KEY,
  content     TEXT    NOT NULL DEFAULT '',
  metadata    TEXT,                         -- JSON frontmatter/tags
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  size_bytes  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS document_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  saved_at    INTEGER NOT NULL,
  saved_by    TEXT,
  change_note TEXT,
  UNIQUE(path, version)
);

CREATE INDEX IF NOT EXISTS idx_dv_path    ON document_versions(path);
CREATE INDEX IF NOT EXISTS idx_dv_recent  ON document_versions(saved_at DESC);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT    PRIMARY KEY,          -- uuid or slug
  username    TEXT    NOT NULL UNIQUE,
  password_hash TEXT  NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'viewer',  -- 'admin' | 'editor' | 'viewer'
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token       TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS idx_us_user    ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_us_expiry  ON user_sessions(expires_at);

-- FTS5 full-text search (content= keeps content in documents table only)
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  path,
  content,
  content=documents,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS fts_after_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_after_update AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, path, content) VALUES ('delete', old.rowid, old.path, old.content);
  INSERT INTO documents_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_after_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, path, content) VALUES ('delete', old.rowid, old.path, old.content);
END;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract YAML/markdown frontmatter as a plain object (best-effort, no deps) */
function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const meta = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = val;
  }
  return meta;
}

/** Normalise path: strip leading slash, normalise separators */
function normPath(p) {
  return path.normalize(p).replace(/^\/+/, '').replace(/\\/g, '/');
}

/** Return parent directory path for a doc path */
function parentDir(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

// ---------------------------------------------------------------------------
// BrainStore class
// ---------------------------------------------------------------------------

class BrainStore {
  /**
   * @param {string} dbPath  Absolute path to brain.db file
   */
  constructor(dbPath) {
    if (!dbPath) throw new Error('BrainStore: dbPath required');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db     = new Database(dbPath);
    this.dbPath = dbPath;
    this._applySchema();

    // Prepared statements cache
    this._stmts = {};
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  _applySchema() {
    this.db.exec(SCHEMA);
  }

  // ── Statement cache ──────────────────────────────────────────────────────

  _stmt(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /**
   * Read a document by path.
   * Returns { path, content, metadata, created_at, updated_at, updated_by, size_bytes }
   * or null if not found.
   */
  getDoc(docPath) {
    const p = normPath(docPath);
    const row = this._stmt('getDoc',
      'SELECT * FROM documents WHERE path = ?'
    ).get(p);
    if (!row) return null;
    if (row.metadata) {
      try { row.metadata = JSON.parse(row.metadata); } catch { row.metadata = {}; }
    }
    return row;
  }

  /**
   * Write (create or update) a document.
   * Automatically saves old version before overwriting.
   * Returns { created: bool, version: number }
   */
  putDoc(docPath, content, { updatedBy = 'unknown', changeNote = null } = {}) {
    const p     = normPath(docPath);
    const now   = Date.now();
    const meta  = parseFrontmatter(content);
    const bytes = Buffer.byteLength(content, 'utf8');

    return this.db.transaction(() => {
      const existing = this._stmt('getDocForPut',
        'SELECT content FROM documents WHERE path = ?'
      ).get(p);

      let version = 1;
      if (existing) {
        // Get next version number
        const vrow = this._stmt('maxVersion',
          'SELECT COALESCE(MAX(version), 0) AS v FROM document_versions WHERE path = ?'
        ).get(p);
        version = vrow.v + 1;

        // Save old content as a version snapshot
        this._stmt('insertVersion',
          `INSERT INTO document_versions(path, version, content, saved_at, saved_by, change_note)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(p, version - 1 === 0 ? 1 : version - 1, existing.content, now, updatedBy, changeNote);

        // Actually check what the last saved version was — re-query to be safe
        const actualMax = this._stmt('maxVersion2',
          'SELECT COALESCE(MAX(version), 0) AS v FROM document_versions WHERE path = ?'
        ).get(p);
        version = actualMax.v + 1;

        this._stmt('updateDoc',
          `UPDATE documents SET content=?, metadata=?, updated_at=?, updated_by=?, size_bytes=?
           WHERE path=?`
        ).run(content, JSON.stringify(meta), now, updatedBy, bytes, p);

        return { created: false, version };
      } else {
        // New document
        this._stmt('insertDoc',
          `INSERT INTO documents(path, content, metadata, created_at, updated_at, updated_by, size_bytes)
           VALUES (?,?,?,?,?,?,?)`
        ).run(p, content, JSON.stringify(meta), now, now, updatedBy, bytes);

        return { created: true, version: 1 };
      }
    })();
  }

  /**
   * Delete a document (and its version history).
   */
  deleteDoc(docPath) {
    const p = normPath(docPath);
    return this.db.transaction(() => {
      this._stmt('deleteVersions',
        'DELETE FROM document_versions WHERE path = ?'
      ).run(p);
      const res = this._stmt('deleteDoc2',
        'DELETE FROM documents WHERE path = ?'
      ).run(p);
      return { deleted: res.changes > 0 };
    })();
  }

  /**
   * Move/rename a document.
   */
  moveDoc(oldPath, newPath, { updatedBy = 'unknown' } = {}) {
    const op  = normPath(oldPath);
    const np  = normPath(newPath);
    const now = Date.now();
    return this.db.transaction(() => {
      const doc = this._stmt('getDocMove',
        'SELECT * FROM documents WHERE path = ?'
      ).get(op);
      if (!doc) throw new Error(`Document not found: ${op}`);

      // Insert at new path
      this._stmt('insertDocMove',
        `INSERT OR REPLACE INTO documents(path, content, metadata, created_at, updated_at, updated_by, size_bytes)
         VALUES (?,?,?,?,?,?,?)`
      ).run(np, doc.content, doc.metadata, doc.created_at, now, updatedBy, doc.size_bytes);

      // Move version history
      this._stmt('moveVersions',
        'UPDATE document_versions SET path = ? WHERE path = ?'
      ).run(np, op);

      // Delete old
      this._stmt('deleteOldDoc',
        'DELETE FROM documents WHERE path = ?'
      ).run(op);

      return { moved: true, from: op, to: np };
    })();
  }

  // ── Directory listing ────────────────────────────────────────────────────

  /**
   * List all documents under a directory prefix.
   * dir = '' means root (all documents).
   * Returns array of { path, updated_at, updated_by, size_bytes }
   */
  listDir(dir = '', { recursive = false } = {}) {
    const prefix = dir ? normPath(dir) + '/' : '';
    const rows = this._stmt('listDir',
      `SELECT path, updated_at, updated_by, size_bytes
       FROM documents
       WHERE path LIKE ? ESCAPE '\\'
       ORDER BY path ASC`
    ).all(prefix.replace(/[%_\\]/g, '\\$&') + '%');

    if (recursive) return rows;

    // Non-recursive: return direct children only (files) + virtual dir entries
    const seen = new Set();
    const result = [];
    for (const row of rows) {
      const rel = row.path.slice(prefix.length);
      const slash = rel.indexOf('/');
      if (slash === -1) {
        // Direct file child
        result.push({ ...row, type: 'file', name: rel });
      } else {
        // Subdirectory — emit once
        const dirName = rel.slice(0, slash);
        if (!seen.has(dirName)) {
          seen.add(dirName);
          result.push({ path: prefix + dirName, type: 'dir', name: dirName });
        }
      }
    }
    return result;
  }

  /**
   * Get the full directory tree as a nested object.
   * Each node: { name, path, type: 'dir'|'file', children? }
   */
  getTree(dir = '') {
    const prefix = dir ? normPath(dir) + '/' : '';
    const rows = this._stmt('treeRows',
      `SELECT path FROM documents
       WHERE path LIKE ? ESCAPE '\\'
       ORDER BY path ASC`
    ).all(prefix.replace(/[%_\\]/g, '\\$&') + '%');

    const root = { name: dir || '(root)', path: dir, type: 'dir', children: [] };
    const dirMap = new Map();
    dirMap.set(dir, root);

    const ensureDir = (dirPath) => {
      if (dirMap.has(dirPath)) return dirMap.get(dirPath);
      const parts   = dirPath.split('/');
      const name    = parts[parts.length - 1];
      const parent  = parts.slice(0, -1).join('/');
      const parentNode = ensureDir(parent);
      const node = { name, path: dirPath, type: 'dir', children: [] };
      parentNode.children.push(node);
      dirMap.set(dirPath, node);
      return node;
    };

    for (const { path: docPath } of rows) {
      const rel   = docPath.slice(prefix.length);
      const parts = rel.split('/');
      const file  = parts[parts.length - 1];
      const dirParts = parts.slice(0, -1);
      const dirPath  = prefix + dirParts.join('/');
      const parentNode = dirParts.length === 0 ? root : ensureDir(dirPath.replace(/\/$/, ''));
      parentNode.children.push({ name: file, path: docPath, type: 'file' });
    }

    return root;
  }

  // ── Full-text search ─────────────────────────────────────────────────────

  /**
   * Search documents using FTS5.
   * Returns array of { path, snippet, rank }
   */
  search(query, { limit = 20, dir = '' } = {}) {
    if (!query || !query.trim()) return [];
    const prefix = dir ? normPath(dir) + '/' : '';

    try {
      let sql = `
        SELECT d.path,
               snippet(documents_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet,
               rank
        FROM documents_fts
        JOIN documents d ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
      `;
      const params = [query];
      if (prefix) {
        sql += ` AND d.path LIKE ? ESCAPE '\\'`;
        params.push(prefix.replace(/[%_\\]/g, '\\$&') + '%');
      }
      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      return this.db.prepare(sql).all(...params);
    } catch (e) {
      // FTS query syntax error — fall back to LIKE
      const like = '%' + query.replace(/[%_\\]/g, '\\$&') + '%';
      return this._stmt('fallbackSearch',
        `SELECT path, substr(content, 1, 200) AS snippet, 0 AS rank
         FROM documents WHERE content LIKE ? ESCAPE '\\' LIMIT ?`
      ).all(like, limit);
    }
  }

  // ── Version history ──────────────────────────────────────────────────────

  /**
   * Get version list for a document.
   * Returns array of { id, version, saved_at, saved_by, change_note, size_bytes }
   */
  getHistory(docPath, { limit = 50 } = {}) {
    const p = normPath(docPath);
    return this._stmt('getHistory',
      `SELECT id, version, saved_at, saved_by, change_note,
              length(content) AS size_bytes
       FROM document_versions
       WHERE path = ?
       ORDER BY version DESC
       LIMIT ?`
    ).all(p, limit);
  }

  /**
   * Get a specific version's content.
   */
  getVersion(docPath, version) {
    const p = normPath(docPath);
    return this._stmt('getVersion',
      'SELECT * FROM document_versions WHERE path = ? AND version = ?'
    ).get(p, version);
  }

  /**
   * Restore a document to a previous version.
   */
  restoreVersion(docPath, version, { updatedBy = 'unknown' } = {}) {
    const p   = normPath(docPath);
    const ver = this.getVersion(p, version);
    if (!ver) throw new Error(`Version ${version} not found for ${p}`);
    return this.putDoc(p, ver.content, {
      updatedBy,
      changeNote: `Restored from version ${version}`
    });
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  stats() {
    const docCount     = this._stmt('countDocs',  'SELECT COUNT(*) AS c FROM documents').get().c;
    const verCount     = this._stmt('countVers',  'SELECT COUNT(*) AS c FROM document_versions').get().c;
    const totalBytes   = this._stmt('totalBytes', 'SELECT COALESCE(SUM(size_bytes),0) AS b FROM documents').get().b;
    const latestUpdate = this._stmt('latestUpd',  'SELECT MAX(updated_at) AS t FROM documents').get().t;
    const dbStat       = fs.statSync(this.dbPath);

    return {
      documents:     docCount,
      versions:      verCount,
      total_bytes:   totalBytes,
      db_file_bytes: dbStat.size,
      last_updated:  latestUpdate
    };
  }

  // ── Auth — Users ─────────────────────────────────────────────────────────

  /**
   * Create a user. password must be pre-hashed with bcrypt.
   */
  createUser({ id, username, passwordHash, role = 'editor' }) {
    const now = Date.now();
    this._stmt('createUser',
      `INSERT INTO users(id, username, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, username, passwordHash, role, now);
    return { id, username, role };
  }

  getUserByUsername(username) {
    return this._stmt('getUserByName',
      'SELECT * FROM users WHERE username = ?'
    ).get(username);
  }

  getUserById(id) {
    return this._stmt('getUserById',
      'SELECT * FROM users WHERE id = ?'
    ).get(id);
  }

  updateLastLogin(userId) {
    this._stmt('updateLastLogin',
      'UPDATE users SET last_login = ? WHERE id = ?'
    ).run(Date.now(), userId);
  }

  // ── Auth — Sessions ──────────────────────────────────────────────────────

  createSession({ token, userId, ip = null, ttlMs = 30 * 24 * 60 * 60 * 1000 }) {
    const now = Date.now();
    this._stmt('createSession',
      `INSERT INTO user_sessions(token, user_id, created_at, expires_at, ip)
       VALUES (?, ?, ?, ?, ?)`
    ).run(token, userId, now, now + ttlMs, ip);
  }

  getSession(token) {
    const row = this._stmt('getSession',
      `SELECT s.*, u.username, u.role
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    ).get(token, Date.now());
    return row || null;
  }

  deleteSession(token) {
    this._stmt('deleteSession',
      'DELETE FROM user_sessions WHERE token = ?'
    ).run(token);
  }

  purgeExpiredSessions() {
    const res = this._stmt('purgeExpired',
      'DELETE FROM user_sessions WHERE expires_at <= ?'
    ).run(Date.now());
    return res.changes;
  }

  // ── Batch import ─────────────────────────────────────────────────────────

  /**
   * Bulk-import an array of { path, content, updatedBy?, createdAt? }.
   * Uses a single transaction for speed.
   * Returns { imported, skipped } counts.
   */
  bulkImport(docs) {
    let imported = 0, skipped = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO documents(path, content, metadata, created_at, updated_at, updated_by, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const importTx = this.db.transaction((items) => {
      for (const doc of items) {
        try {
          const p     = normPath(doc.path);
          const meta  = parseFrontmatter(doc.content);
          const now   = doc.createdAt || Date.now();
          const bytes = Buffer.byteLength(doc.content, 'utf8');
          const res   = insert.run(p, doc.content, JSON.stringify(meta), now, now, doc.updatedBy || 'import', bytes);
          if (res.changes > 0) imported++; else skipped++;
        } catch (e) {
          skipped++;
        }
      }
    });
    importTx(docs);
    return { imported, skipped };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close() {
    this.db.close();
  }
}

module.exports = BrainStore;
