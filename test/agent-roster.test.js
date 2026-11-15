'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRosterFromRegistry } = require('../lib/instanceConfig');

const rows = [
  { nickname: '[[#Gunny]]', official_title: 'Chief of Staff', platform: 'Grok Bot', status: '🟢 Active' },
  { nickname: '[[#Roger]]', official_title: 'UI Designer & Portal Dev', platform: 'Grok Bot', status: '🟢 Active' },
  { nickname: '[[#Steve]]', official_title: 'Intelligence', platform: 'Claude Cowork', status: '🟡 Quiet since 2026-10-27' },
  { nickname: 'Spike', official_title: 'CoS', platform: 'OpenClaw', status: 'Decommissioned 2026-10-29' },
  { nickname: '[[#Gunny]]', official_title: 'dup', platform: 'x', status: 'Active' },
];

test('registry rows become assignable agents; retired and dupes skipped', () => {
  const out = buildRosterFromRegistry(rows, [{ key: 'gunny', label: 'old', canWake: true }]);
  assert.deepEqual(out.map(a => a.key), ['gunny', 'roger', 'steve']);
  assert.equal(out[0].label, 'Gunny \u2014 Chief of Staff / Grok Bot');
  assert.equal(out[0].canWake, true);
  assert.equal(out[1].canWake, false);
});
