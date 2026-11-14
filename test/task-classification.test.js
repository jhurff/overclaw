'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTask,
  extractProgressDates,
  inferCadenceFromDates,
} = require('../lib/taskClassification');

const NOW = '2026-11-14T18:00:00Z';

function notesOn(days) {
  return days.map(d => `## 📝 Progress Note — ${d}\n\nchecked\n`).join('\n');
}

test('explicit type wins over a standing title', () => {
  const info = classifyTask({
    taskId: 'TASK-20261023-001',
    title: 'daily swarm security watch',
    frontmatter: { type: 'project' },
    body: '',
    now: NOW,
  });
  assert.equal(info.type, 'project');
  assert.equal(info.typeSource, 'explicit');
  assert.equal(info.standingStatus, null);
});

test('TASK-20261023-001 daily swarm security watch infers standing from the title', () => {
  const info = classifyTask({
    taskId: 'TASK-20261023-001',
    title: 'daily swarm security watch',
    frontmatter: {},
    body: notesOn(['2026-11-14']),
    now: NOW,
  });
  assert.equal(info.type, 'standing');
  assert.equal(info.typeSource, 'inferred:title');
  assert.equal(info.cadence, 'daily');
  assert.equal(info.standingStatus, 'active');
  assert.equal(info.lastRun, '2026-11-14');
});

test('TASK-20261021-001 daily GCP spend check infers standing and goes inactive when the last run is old', () => {
  const info = classifyTask({
    taskId: 'TASK-20261021-001',
    title: 'daily GCP spend check',
    frontmatter: {},
    body: notesOn(['2026-11-01']),
    now: NOW,
  });
  assert.equal(info.type, 'standing');
  assert.equal(info.typeSource, 'inferred:title');
  assert.equal(info.standingStatus, 'inactive');
});

test('TASK-20261023-003 stays a project when it is done', () => {
  const info = classifyTask({
    taskId: 'TASK-20261023-003',
    title: 'Publish the November release notes',
    frontmatter: { status: 'done' },
    body: '## Summary\n\nShipped.\n',
    now: NOW,
  });
  assert.equal(info.type, 'project');
  assert.equal(info.typeSource, 'default');
});

test('cadence frontmatter infers standing ahead of the title', () => {
  const info = classifyTask({
    title: 'one-off cleanup',
    frontmatter: { cadence: 'weekly' },
    body: '',
    now: NOW,
  });
  assert.equal(info.typeSource, 'inferred:cadence');
  assert.equal(info.cadence, 'weekly');
  assert.equal(info.standingStatus, 'inactive');
});

test('explicit standing_status scheduled is kept', () => {
  const info = classifyTask({
    title: 'monthly license sweep',
    frontmatter: { type: 'standing', standing_status: 'scheduled', cadence: 'monthly' },
    body: '',
    now: NOW,
  });
  assert.equal(info.typeSource, 'explicit');
  assert.equal(info.standingStatus, 'scheduled');
});

test('heartbeat mention infers standing', () => {
  const info = classifyTask({
    taskId: 'TASK-20261023-001',
    title: 'security routine',
    frontmatter: {},
    body: '',
    heartbeats: [{
      date: '2026-11-14T09:00',
      job: 'swarm-security-watch',
      type: 'swarm security watch',
      filename: '2026-11-14-09-00-swarm-security-watch.md',
      taskIds: ['TASK-20261023-001'],
    }],
    now: NOW,
  });
  assert.equal(info.typeSource, 'inferred:heartbeat');
  assert.equal(info.standingStatus, 'active');
  assert.equal(info.heartbeatJob, 'swarm-security-watch');
});

test('three evenly spaced progress notes infer a daily cadence', () => {
  const dates = extractProgressDates(notesOn(['2026-11-12', '2026-11-13', '2026-11-14']));
  assert.deepEqual(dates, ['2026-11-12', '2026-11-13', '2026-11-14']);
  assert.equal(inferCadenceFromDates(dates), 'daily');
  const info = classifyTask({
    title: 'routine pass',
    frontmatter: {},
    body: notesOn(['2026-11-12', '2026-11-13', '2026-11-14']),
    now: NOW,
  });
  assert.equal(info.typeSource, 'inferred:progress-notes');
  assert.equal(info.cadence, 'daily');
  assert.equal(info.standingStatus, 'active');
});

test('irregular dates do not infer standing from progress notes', () => {
  const body = notesOn(['2026-01-02', '2026-03-18', '2026-11-01']);
  assert.equal(inferCadenceFromDates(extractProgressDates(body)), null);
  const info = classifyTask({ title: 'follow up with vendor', frontmatter: {}, body, now: NOW });
  assert.equal(info.type, 'project');
});
