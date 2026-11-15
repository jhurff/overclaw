'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentWebhooks = require('../lib/agentWebhooks');

// Public address stub so tests never touch real DNS.
const publicLookup = async () => [{ address: '34.225.159.174', family: 4 }];
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wh-')), 'hooks.json');

test('stores webhook, masks secret, posts with bearer header', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wh-')), 'hooks.json');
  const w = new AgentWebhooks(f, { lookup: publicLookup });
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
  const w = new AgentWebhooks(f, { lookup: publicLookup });
  w.set('gunny', { url: 'https://h.example/x', header: 'Bearer crsr_abc123' });
  assert.deepEqual([w.get('gunny').header, w.get('gunny').secret], ['Authorization', 'crsr_abc123']);
  w.set('gunny', { url: 'https://h.example/x', header: 'crsr_zzz' });
  assert.equal(w.get('gunny').secret, 'crsr_zzz');
  w.set('gunny', { url: 'https://h.example/x', header: 'Authorization: Bearer crsr_q' });
  assert.equal(w.get('gunny').secret, 'crsr_q');
  w.set('gunny', { url: 'https://h.example/x', secret: 'Bearer crsr_s', header: 'Authorization' });
  assert.equal(w.get('gunny').secret, 'crsr_s');
});

test('webhook targets must be public https hosts (CodeQL js/request-forgery)', async () => {
  const w = new AgentWebhooks(tmpFile(), { lookup: publicLookup });
  for (const url of [
    'http://hooks.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x',
    'https://192.168.68.42:8355/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x',
    'https://[fd00:ec2::254]/x', 'https://[::ffff:127.0.0.1]/x', 'https://100.91.70.71/x',
    'https://metadata.google.internal/x', 'https://intranet/x', 'https://u:p@hooks.example/x',
    'file:///etc/passwd', 'not a url',
  ]) {
    assert.throws(() => w.set('luther', { url, secret: 'k' }), /https|public|valid|credentials/, url);
  }
  w.set('luther', { url: 'https://api2.cursor.sh/hooks/abc', secret: 'k' });
  assert.equal(w.list().luther.host, 'api2.cursor.sh');

  // DNS that points a public-looking name at a private or metadata address is refused before any request.
  for (const address of ['10.0.0.5', '169.254.169.254', '127.0.0.1', '::1', 'fd00:ec2::254', '100.100.100.100']) {
    const evil = new AgentWebhooks(w.filePath, { lookup: async () => [{ address: '34.1.1.1', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] });
    let called = false;
    const r = await evil.notify('luther', { taskId: 'T' }, async () => { called = true; return { ok: true, status: 200 }; });
    assert.equal(called, false, address);
    assert.equal(r.sent, false);
    assert.match(r.error, /private/);
  }
  const dead = new AgentWebhooks(w.filePath, { lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual(await dead.notify('luther', {}, async () => ({ ok: true, status: 200 })), { sent: false, error: 'webhook host did not resolve' });

  // A public resolution still sends, with redirects disabled.
  let seen;
  const ok = await w.notify('luther', { event: 'test', taskId: null }, async (url, opts) => { seen = { url, opts }; return { ok: true, status: 202 }; });
  assert.deepEqual(ok, { sent: true, status: 202 });
  assert.equal(seen.opts.redirect, 'manual');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.event, 'test');
  assert.equal(body.source, 'overclaw');
  assert.equal(body.agent, 'luther');
});

test('isBlockedAddress covers private, loopback, link-local, metadata and mapped forms', () => {
  const blocked = ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
    '::ffff:10.0.0.1', '::ffff:7f00:1', '', 'nope'];
  for (const a of blocked) assert.equal(AgentWebhooks.isBlockedAddress(a), true, a);
  for (const a of ['34.225.159.174', '8.8.8.8', '172.66.147.243', '2606:4700::6810:84e5']) {
    assert.equal(AgentWebhooks.isBlockedAddress(a), false, a);
  }
});

test('agent keys cannot pollute prototypes (CodeQL prototype-polluting-assignment)', async () => {
  const f = tmpFile();
  const w = new AgentWebhooks(f, { lookup: publicLookup });
  for (const k of ['__proto__', 'constructor', 'prototype', '../x', 'a b', '', 'x'.repeat(65)]) {
    assert.throws(() => w.set(k, { url: 'https://hooks.example/x', secret: 'k' }), /agent key/, k);
    assert.equal(w.get(k), null);
    w.remove(k);
  }
  assert.equal(AgentWebhooks.normKey('Gunny'), 'gunny');
  assert.equal(AgentWebhooks.normKey('__proto__'), '');
  assert.deepEqual(await w.notify('__proto__', {}), { sent: false, skipped: 'invalid agent key' });
  // A tampered file with dangerous keys is ignored on read and dropped on the next write.
  fs.writeFileSync(f, '{"agents":{"__proto__":{"url":"https://evil.example/","polluted":true},"constructor":{"url":"https://evil.example/"},"gunny":{"url":"https://hooks.example/g","secret":"k","header":"Authorization"}}}');
  assert.deepEqual(Object.keys(w.list()), ['gunny']);
  assert.equal(Object.getPrototypeOf(w.list()), null);
  w.set('peter', { url: 'https://hooks.example/p', secret: 'k2' });
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).url, undefined);
  const raw = fs.readFileSync(f, 'utf8');
  assert.equal(raw.includes('evil.example'), false);
  assert.deepEqual(Object.keys(JSON.parse(raw).agents).sort(), ['gunny', 'peter']);
});

test('header paste parsing is linear time and keeps PR #26 behavior (CodeQL polynomial-redos)', () => {
  const p = AgentWebhooks.parseHeaderAndSecret;
  assert.deepEqual(p('Authorization: Bearer crsr_x', ''), { header: 'Authorization', secret: 'crsr_x' });
  assert.deepEqual(p('X-Api-Key: abc', ''), { header: 'X-Api-Key', secret: 'abc' });
  assert.deepEqual(p('Bearer crsr_abc', ''), { header: 'Authorization', secret: 'crsr_abc' });
  assert.deepEqual(p('crsr_zzz', ''), { header: 'Authorization', secret: 'crsr_zzz' });
  assert.deepEqual(p('not a header!', ''), { header: 'Authorization', secret: 'not a header!' });
  assert.deepEqual(p('', 'Bearer   crsr_s'), { header: 'Authorization', secret: 'crsr_s' });
  assert.deepEqual(p('X-Key', 'k'), { header: 'X-Key', secret: 'k' });
  assert.deepEqual(p('Authorization: Bearer typed', 'fromkeybox'), { header: 'Authorization', secret: 'fromkeybox' });
  assert.throws(() => p('Host', 'k'), /reserved/);
  assert.throws(() => p('', 'a\r\nX-Evil: 1'), /single line/);
  const t0 = Date.now();
  for (const evil of ['-:' + ' '.repeat(200000), '-:' + ' '.repeat(200000) + 'x', 'a'.repeat(200000) + ':', 'Bearer' + ' '.repeat(200000)]) {
    p(evil, '');
    p('', evil);
  }
  assert.ok(Date.now() - t0 < 500, 'parsing hostile input took ' + (Date.now() - t0) + 'ms');
});
