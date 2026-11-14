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

test('a task id inside a heartbeat does not infer standing', () => {
  const info = classifyTask({
    taskId: 'TASK-20261011-004',
    title: 'GigOrder checkout',
    frontmatter: {},
    body: '',
    heartbeats: [{
      date: '2026-11-14T09:00',
      job: 'swarm-security-watch',
      type: 'swarm security watch',
      filename: '2026-11-14-09-00-swarm-security-watch.md',
      taskIds: ['TASK-20261011-004'],
      content: 'Checked TASK-20261011-004 for agent north',
    }],
    now: NOW,
  });
  assert.equal(info.type, 'project');
  assert.equal(info.typeSource, 'default');
});

test('heartbeat_job infers standing only when it matches a heartbeat job or file', () => {
  const heartbeats = [{
    date: '2026-11-14T09:00',
    job: 'swarm-security-watch',
    type: 'swarm security watch',
    filename: '2026-11-14-09-00-swarm-security-watch.md',
    taskIds: [],
  }];
  const matched = classifyTask({
    taskId: 'TASK-20261023-001',
    title: 'security routine',
    frontmatter: { heartbeat_job: 'swarm-security-watch' },
    body: '',
    heartbeats,
    now: NOW,
  });
  assert.equal(matched.typeSource, 'inferred:heartbeat');
  assert.equal(matched.standingStatus, 'active');
  assert.equal(matched.heartbeatJob, 'swarm-security-watch');

  const unmatched = classifyTask({
    title: 'security routine',
    frontmatter: { heartbeat_job: 'some-other-job' },
    body: '',
    heartbeats,
    now: NOW,
  });
  assert.equal(unmatched.type, 'project');
});

test('five daily notes plus an operational hint infer standing; fewer notes do not', () => {
  const five = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
  const dates = extractProgressDates(notesOn(five));
  assert.deepEqual(dates, five);
  assert.equal(inferCadenceFromDates(dates), 'daily');
  assert.equal(inferCadenceFromDates(['2026-11-12', '2026-11-13', '2026-11-14']), null);
  const hinted = classifyTask({
    title: 'Swarm + host security watch',
    frontmatter: {},
    body: notesOn(five),
    now: NOW,
  });
  assert.equal(hinted.typeSource, 'inferred:progress-notes');
  assert.equal(hinted.cadence, 'daily');
  assert.equal(hinted.standingStatus, 'active');

  const shortRun = classifyTask({
    title: 'Swarm + host security watch',
    frontmatter: {},
    body: notesOn(['2026-11-12', '2026-11-13', '2026-11-14']),
    now: NOW,
  });
  assert.equal(shortRun.type, 'project');

  const noHint = classifyTask({
    title: 'GigOrder checkout',
    frontmatter: {},
    body: notesOn(five),
    now: NOW,
  });
  assert.equal(noHint.type, 'project');
});

test('done and cancelled tasks stay project even when the title looks operational', () => {
  const titled = {
    title: 'GCP daily spend report',
    frontmatter: { status: 'done' },
    body: '',
    now: NOW,
  };
  assert.equal(classifyTask(titled).type, 'project');
  assert.equal(classifyTask({
    title: 'daily swarm security watch',
    frontmatter: { status: 'cancelled' },
    now: NOW,
  }).type, 'project');
  assert.equal(classifyTask({
    title: 'daily swarm security watch',
    frontmatter: {},
    section: 'done',
    now: NOW,
  }).type, 'project');
  assert.equal(classifyTask({
    title: 'GCP daily spend report',
    frontmatter: { type: 'standing', standing_status: 'active' },
    section: 'done',
    now: NOW,
  }).typeSource, 'explicit');
});

test('prod false positives stay project; the two daily routines stay standing', () => {
  const noise = [{
    date: '2026-11-14T09:00',
    job: 'morning-digest',
    type: 'morning digest',
    filename: '2026-11-14-09-00-morning-digest.md',
    taskIds: [
      'TASK-20261011-004',
      'TASK-20261008-001',
      'TASK-20261029-001',
      'TASK-20260701-004',
      'TASK-20261023-001',
      'TASK-20261021-001',
    ],
  }];
  const projects = [
    ['TASK-20261011-004', 'GigOrder checkout'],
    ['TASK-20261008-001', 'BJB one-step claim signup'],
    ['TASK-20261029-001', 'Retire Bitwarden'],
    ['TASK-20260701-004', 'BKS Migration'],
  ];
  for (const [taskId, title] of projects) {
    const info = classifyTask({
      taskId,
      title,
      frontmatter: { status: 'inProgress' },
      body: notesOn(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']),
      heartbeats: noise,
      section: 'inProgress',
      now: NOW,
    });
    assert.equal(info.type, 'project', title);
    assert.notEqual(info.typeSource, 'inferred:heartbeat', title);
  }

  const security = classifyTask({
    taskId: 'TASK-20261023-001',
    title: 'Swarm + host security watch',
    frontmatter: {},
    body: notesOn(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']),
    heartbeats: noise,
    section: 'inProgress',
    now: NOW,
  });
  assert.equal(security.type, 'standing');
  assert.equal(security.typeSource, 'inferred:progress-notes');

  const spend = classifyTask({
    taskId: 'TASK-20261021-001',
    title: 'GCP daily spend report',
    frontmatter: {},
    body: '',
    heartbeats: noise,
    section: 'inProgress',
    now: NOW,
  });
  assert.equal(spend.type, 'standing');
  assert.equal(spend.typeSource, 'inferred:title');
});

test('irregular dates do not infer standing from progress notes', () => {
  const body = notesOn(['2026-01-02', '2026-03-18', '2026-11-01']);
  assert.equal(inferCadenceFromDates(extractProgressDates(body)), null);
  const info = classifyTask({ title: 'follow up with vendor', frontmatter: {}, body, now: NOW });
  assert.equal(info.type, 'project');
});
