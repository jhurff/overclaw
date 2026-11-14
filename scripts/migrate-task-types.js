'use strict';

/**
 * Write explicit task-type frontmatter into brain.db from the standing/project
 * inference. Dry-run unless --apply is passed. Does not touch the filesystem vault.
 *
 *   node scripts/migrate-task-types.js [--db path/to/brain.db] [--apply]
 *
 * Each applied update goes through BrainStore.putDoc, which snapshots the previous
 * document in document_versions the same way PUT /api/brain/doc does.
 */

const path = require('path');
const BrainStore = require('../lib/BrainStore');
const {
  classifyTask,
  parseFrontmatter,
  splitDocument,
  upsertFrontmatter,
  parseHeartbeatFilename,
  normalizeType,
  normalizeStandingStatus,
} = require('../lib/taskClassification');

const TASKS_DIR = '03 - Agents/Coordination/Tasks';
const HEARTBEAT_DIR = '08 - QA-and-Monitoring/Heartbeats';

function parseArgs(argv) {
  const out = { apply: false, db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('Unknown argument: ' + a);
  }
  return out;
}

function loadHeartbeats(store) {
  let rows = [];
  try {
    rows = store.listDir(HEARTBEAT_DIR, { recursive: true });
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    if (!row.path || !row.path.endsWith('.md')) continue;
    const doc = store.getDoc(row.path);
    if (!doc) continue;
    const rest = row.path.startsWith(HEARTBEAT_DIR + '/')
      ? row.path.slice(HEARTBEAT_DIR.length + 1)
      : path.posix.basename(row.path);
    const filename = rest.includes('/') ? rest.slice(rest.lastIndexOf('/') + 1) : rest;
    const relDir = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '';
    const meta = parseHeartbeatFilename(filename, relDir);
    const fm = parseFrontmatter(doc.content);
    const taskIds = new Set();
    const re = /TASK-[A-Z0-9]+-\d+/g;
    let m;
    while ((m = re.exec(doc.content || ''))) taskIds.add(m[0]);
    out.push({
      date: meta.date,
      job: fm.job || null,
      type: meta.type,
      filename,
      taskIds: [...taskIds],
    });
  }
  return out;
}

function planUpdate(doc, heartbeats) {
  const fm = parseFrontmatter(doc.content);
  const { body } = splitDocument(doc.content);
  const title = fm.title || '';
  const taskId = fm.task_id || path.posix.basename(doc.path, '.md');
  const info = classifyTask({
    taskId,
    title,
    frontmatter: fm,
    body,
    heartbeats,
  });

  const updates = {};
  const reasons = [];
  if (!normalizeType(fm.type)) {
    updates.type = info.type;
    reasons.push('type=' + info.type + ' (' + info.typeSource + ')');
  }
  if (info.type === 'standing' && !normalizeStandingStatus(fm.standing_status)) {
    updates.standing_status = info.standingStatus;
    reasons.push('standing_status=' + info.standingStatus);
  }
  if (info.type === 'standing' && info.cadence && !String(fm.cadence || '').trim()) {
    updates.cadence = info.cadence;
    reasons.push('cadence=' + info.cadence);
  }
  if (info.type === 'standing' && info.heartbeatJob && !String(fm.heartbeat_job || '').trim()) {
    updates.heartbeat_job = info.heartbeatJob;
    reasons.push('heartbeat_job=' + info.heartbeatJob);
  }

  return {
    path: doc.path,
    taskId,
    info,
    updates,
    reasons,
    changed: Object.keys(updates).length > 0,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/migrate-task-types.js [--db path/to/brain.db] [--apply]');
    console.log('Dry-run by default. --apply writes frontmatter via BrainStore.putDoc.');
    return;
  }
  const dbPath = path.resolve(args.db || process.env.BRAIN_DB_PATH || path.join(__dirname, '..', 'data', 'brain.db'));
  const store = new BrainStore(dbPath);
  try {
    const heartbeats = loadHeartbeats(store);
    const rows = store.listDir(TASKS_DIR, { recursive: false })
      .filter(r => r.type === 'file' && /^TASK-.*\.md$/i.test(r.name || ''));

    const plans = [];
    for (const row of rows) {
      const doc = store.getDoc(row.path);
      if (!doc) continue;
      plans.push({ doc, plan: planUpdate(doc, heartbeats) });
    }

    const mode = args.apply ? 'APPLY' : 'DRY RUN';
    console.log('Task type migration (' + mode + ')');
    console.log('db: ' + dbPath);
    console.log('tasks: ' + plans.length + '    heartbeats scanned: ' + heartbeats.length);
    console.log('');

    let wouldChange = 0;
    let changed = 0;
    let unchanged = 0;
    for (const { doc, plan } of plans) {
      if (!plan.changed) {
        unchanged++;
        console.log('  keep  ' + plan.taskId + '  type=' + (plan.info.type) + ' (' + plan.info.typeSource + ')');
        continue;
      }
      wouldChange++;
      const label = args.apply ? 'write' : 'plan ';
      console.log('  ' + label + '  ' + plan.taskId + '  ' + plan.reasons.join('  '));
      if (args.apply) {
        const next = upsertFrontmatter(doc.content, plan.updates);
        store.putDoc(doc.path, next, {
          updatedBy: 'migrate-task-types',
          changeNote: 'set task type from inference: ' + plan.reasons.join(', '),
        });
        changed++;
      }
    }

    console.log('');
    if (args.apply) {
      console.log('Updated ' + changed + ' task document' + (changed === 1 ? '' : 's') + '. Unchanged ' + unchanged + '.');
    } else {
      console.log('Would update ' + wouldChange + ' task document' + (wouldChange === 1 ? '' : 's') + '. Unchanged ' + unchanged + '.');
      console.log('Re-run with --apply to write frontmatter and document_versions.');
    }
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = { planUpdate, loadHeartbeats, parseArgs };
