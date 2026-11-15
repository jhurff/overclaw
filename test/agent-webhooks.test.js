'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentWebhooks = require('../lib/agentWebhooks');

test('stores webhook, masks secret, posts with bearer header', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wh-')), 'hooks.json');
  const w = new AgentWebhooks(f);
  assert.throws(() => w.set('luther', { url: 'http://x.test/h' }), /https/);
  w.set('Luther', { url: 'https://hooks.example/abc', secret: 's3cret' });
  const listed = w.list();
  assert.equal(listed.luther.hasSecret, true);
  assert.equal(JSON.stringify(listed).includes('s3cret'), false);
  assert.equal((fs.statSync(f).mode & 0o777), 0o600);
  let seen;
  const r = await w.notify('luther', { taskId: 'TASK-1' }, async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200 }; });
  assert.equal(r.sent, true);
  assert.equal(seen.opts.headers.Authorization, 'Bearer s3cret');
  assert.equal(JSON.parse(seen.opts.body).taskId, 'TASK-1');
  w.set('luther', { url: 'https://hooks.example/abc', secret: '' });
  assert.equal(w.get('luther').secret, 's3cret');
  assert.deepEqual(await w.notify('peter', {}), { sent: false, skipped: 'no webhook configured' });
});

test('forgives key pasted into header box or with Bearer prefix', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wh-')), 'hooks.json');
  const w = new AgentWebhooks(f);
  w.set('gunny', { url: 'https://h.example/x', header: 'Bearer crsr_abc123' });
  assert.deepEqual([w.get('gunny').header, w.get('gunny').secret], ['Authorization', 'crsr_abc123']);
  w.set('gunny', { url: 'https://h.example/x', header: 'crsr_zzz' });
  assert.equal(w.get('gunny').secret, 'crsr_zzz');
  w.set('gunny', { url: 'https://h.example/x', header: 'Authorization: Bearer crsr_q' });
  assert.equal(w.get('gunny').secret, 'crsr_q');
  w.set('gunny', { url: 'https://h.example/x', secret: 'Bearer crsr_s', header: 'Authorization' });
  assert.equal(w.get('gunny').secret, 'crsr_s');
});
