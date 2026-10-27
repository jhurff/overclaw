#!/usr/bin/env node
'use strict';

/**
 * import-vault.js
 *
 * One-time migration: import all .md files from ~/My-AI-Brain into brain.db
 *
 * Usage:
 *   node scripts/import-vault.js [--vault /path/to/vault] [--db /path/to/brain.db] [--dry-run]
 *
 * Skips:
 *   - .obsidian/ directory
 *   - node_modules/
 *   - .git/
 *   - Non-.md files
 *   - Files > 5MB
 */

const path   = require('path');
const fs     = require('fs');

const BrainStore = require('../lib/BrainStore');

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argIdx = (flag) => args.indexOf(flag);
const argVal = (flag) => { const i = argIdx(flag); return i !== -1 ? args[i + 1] : null; };

const vaultPath = argVal('--vault') || process.env.VAULT_PATH || path.join(process.env.HOME, 'My-AI-Brain');
const dbPath    = argVal('--db')    || path.join(__dirname, '..', 'data', 'brain.db');
const dryRun    = args.includes('--dry-run');
const force     = args.includes('--force');  // reimport even if db already has docs

// ── Helpers ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

function* walkMd(dir, vaultRoot) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(full, vaultRoot);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = path.relative(vaultRoot, full).replace(/\\/g, '/');
      yield { full, rel };
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== AI Brain Vault Import ===');
  console.log(`Vault:  ${vaultPath}`);
  console.log(`DB:     ${dbPath}`);
  console.log(`Mode:   ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  if (!fs.existsSync(vaultPath)) {
    console.error(`ERROR: Vault path not found: ${vaultPath}`);
    process.exit(1);
  }

  // Collect files
  console.log('Scanning vault...');
  const files = [];
  let skippedTooBig = 0;
  for (const { full, rel } of walkMd(vaultPath, vaultPath)) {
    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_BYTES) {
      console.warn(`  SKIP (too large ${(stat.size/1024/1024).toFixed(1)}MB): ${rel}`);
      skippedTooBig++;
      continue;
    }
    files.push({ full, rel, mtime: stat.mtimeMs });
  }
  console.log(`Found ${files.length} .md files (${skippedTooBig} skipped — too large)\n`);

  if (dryRun) {
    console.log('DRY RUN — first 20 files that would be imported:');
    files.slice(0, 20).forEach(f => console.log(' ', f.rel));
    if (files.length > 20) console.log(`  ... and ${files.length - 20} more`);
    process.exit(0);
  }

  // Open DB
  const store = new BrainStore(dbPath);

  // Check existing
  const existing = store.stats().documents;
  if (existing > 0 && !force) {
    console.log(`DB already has ${existing} documents. Use --force to reimport.`);
    store.close();
    process.exit(0);
  }
  if (force && existing > 0) {
    console.log(`--force: overwriting ${existing} existing documents...`);
    store.db.exec('DELETE FROM document_versions; DELETE FROM documents;');
  }

  // Read files in batches and bulk import
  const BATCH = 200;
  let totalImported = 0, totalSkipped = 0;
  const startMs = Date.now();

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const docs = [];
    for (const { full, rel, mtime } of batch) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        docs.push({ path: rel, content, createdAt: mtime, updatedBy: 'vault-import' });
      } catch (e) {
        console.warn(`  SKIP (read error): ${rel} — ${e.message}`);
        totalSkipped++;
      }
    }
    const { imported, skipped } = store.bulkImport(docs);
    totalImported += imported;
    totalSkipped  += skipped;

    const pct = Math.round(((i + batch.length) / files.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${totalImported} imported, ${totalSkipped} skipped)  `);
  }

  console.log('');
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  const finalStats = store.stats();
  console.log(`\n=== Import Complete ===`);
  console.log(`Time:      ${elapsedSec}s`);
  console.log(`Imported:  ${totalImported}`);
  console.log(`Skipped:   ${totalSkipped}`);
  console.log(`DB docs:   ${finalStats.documents}`);
  console.log(`DB size:   ${(finalStats.db_file_bytes / 1024 / 1024).toFixed(1)}MB`);

  store.close();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
