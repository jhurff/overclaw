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

test("notifyAssignment pings the owner and Gunny, and does not double-ping Gunny", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oc-wh-")), "hooks.json");
  const w = new AgentWebhooks(f);
  w.set("luther", { url: "https://hooks.example/luther", secret: "luth" });
  w.set("gunny", { url: "https://hooks.example/gunny", secret: "gunn" });
  const sent = [];
  const fake = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  const payload = { taskId: "TASK-1", title: "A task", fromSection: "inProgress" };
  const r = await w.notifyAssignment("luther", payload, fake);
  assert.equal(r.ping.sent, true);
  assert.equal(r.cosPing.sent, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "https://hooks.example/luther");
  assert.equal(sent[0].body.agent, "luther");
  assert.equal(sent[0].body.taskId, "TASK-1");
  assert.equal(sent[0].body.fromSection, "inProgress");
  assert.equal(sent[0].body.event, "task.assigned");
  assert.equal(sent[1].url, "https://hooks.example/gunny");
  // CoS payload is the same plus the new agent and fromSection
  assert.equal(sent[1].body.agent, "luther");
  assert.equal(sent[1].body.taskId, "TASK-1");
  assert.equal(sent[1].body.fromSection, "inProgress");
  assert.equal(sent[1].body.title, "A task");

  sent.length = 0;
  const g = await w.notifyAssignment("gunny", payload, fake);
  assert.equal(g.ping.sent, true);
  assert.equal(g.cosPing.skipped, "same as owner");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://hooks.example/gunny");
  assert.equal(sent[0].body.agent, "gunny");
});

test("notifyAssignment skipOwner still pings Gunny", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oc-wh-")), "hooks.json");
  const w = new AgentWebhooks(f);
  w.set("gunny", { url: "https://hooks.example/gunny", secret: "gunn" });
  const sent = [];
  const fake = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  const r = await w.notifyAssignment("jimmy", { taskId: "TASK-2", fromSection: "inbox" }, fake, { skipOwner: true });
  assert.equal(r.ping.skipped, "operator");
  assert.equal(r.cosPing.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.agent, "jimmy");
  assert.equal(sent[0].body.fromSection, "inbox");
});
