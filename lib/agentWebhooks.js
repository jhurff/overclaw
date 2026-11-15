'use strict';

// Per-agent assignment pings. Each Grok Bot agent owns a webhook-triggered
// routine; OverClaw POSTs to it when a task is assigned so the agent wakes and
// picks the task up. URLs and sender keys live in data/agent-webhooks.json
// (gitignored, chmod 600) and are never returned in full by the API.
//
// Hardening (CodeQL js/request-forgery, prototype-polluting-assignment,
// polynomial-redos):
// - agent keys must match AGENT_KEY_RE and are never __proto__/constructor/prototype;
//   records live in a Map, never in a plain object keyed by user input.
// - webhook targets must be https on port 443 (or an explicit public port) and
//   must resolve only to public addresses. The connection is pinned to the
//   address that passed the check (no DNS rebinding), and redirects are not followed.
// - paste parsing uses indexOf, not a backtracking regex.

const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const net = require('net');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'agent-webhooks.json');
const AGENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie']);
const MAX_FIELD = 4096;
const TIMEOUT_MS = 8000;

// Addresses a webhook may never reach: private, loopback, link-local (incl.
// cloud metadata 169.254.169.254 / fd00:ec2::254), CGNAT/Tailscale, multicast,
// reserved and documentation ranges.
// Separate lists: a single BlockList matches IPv4 against IPv4-mapped IPv6 subnets.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => BLOCKED_V4.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
].forEach(([a, p]) => BLOCKED_V6.addSubnet(a, p, 'ipv6'));

function isBlockedAddress(addr) {
  const fam = net.isIP(String(addr || ''));
  if (!fam) return true;
  if (fam === 6) {
    // IPv4-mapped / compatible forms: judge by the embedded IPv4 address.
    const lower = addr.toLowerCase();
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (dotted) return isBlockedAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isBlockedAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    if (lower.startsWith('::ffff:')) return true;
    return BLOCKED_V6.check(addr, 'ipv6');
  }
  return BLOCKED_V4.check(addr, 'ipv4');
}

/** Normalize and validate an agent key. Returns '' when unsafe. */
function normKey(k) {
  const key = String(k == null ? '' : k).trim().toLowerCase();
  if (!AGENT_KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) return '';
  return key;
}

/** Sync URL checks shared by set() and notify(). Throws on a disallowed target. */
function parseTarget(url) {
  let u;
  try { u = new URL(String(url || '').slice(0, MAX_FIELD)); } catch { throw new Error('valid webhook URL required'); }
  if (u.protocol !== 'https:') throw new Error('webhook URL must be https');
  if (u.username || u.password) throw new Error('webhook URL must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('valid webhook URL required');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    throw new Error('webhook host must be a public address');
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('webhook host must be a public address');
  } else if (!host.includes('.')) {
    throw new Error('webhook host must be a public address');
  }
  return { u, host };
}

/** Resolve host and require every address to be public. Returns the vetted addresses. */
async function resolvePublic(host, lookupImpl) {
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('webhook host must be a public address');
    return [{ address: host, family: net.isIP(host) }];
  }
  const lookup = lookupImpl || ((h) => dns.promises.lookup(h, { all: true, verbatim: true }));
  let addrs;
  try { addrs = await lookup(host); } catch { throw new Error('webhook host did not resolve'); }
  if (!Array.isArray(addrs) || !addrs.length) throw new Error('webhook host did not resolve');
  if (addrs.some(a => isBlockedAddress(a && a.address))) throw new Error('webhook host resolves to a private address');
  return addrs;
}

/** Forgive pastes: "Authorization: Bearer x", "Bearer x", or a key in the header box. */
function parseHeaderAndSecret(header, secret) {
  let hdr = String(header == null ? '' : header).slice(0, MAX_FIELD).trim();
  let sec = String(secret == null ? '' : secret).slice(0, MAX_FIELD).trim();
  const colon = hdr.indexOf(':');
  if (colon > 0) {
    const name = hdr.slice(0, colon).trim();
    const value = hdr.slice(colon + 1).trim();
    if (HEADER_RE.test(name) && value) {
      hdr = name;
      if (!sec) sec = value;
    }
  }
  const lower = hdr.toLowerCase();
  const looksLikeKey = lower.startsWith('crsr_') || (lower.startsWith('bearer') && /\s/.test(hdr.charAt(6)));
  if ((hdr && !HEADER_RE.test(hdr)) || looksLikeKey) {
    if (!sec) sec = hdr;
    hdr = '';
  }
  if (!hdr) hdr = 'Authorization';
  if (sec.toLowerCase().startsWith('bearer') && /\s/.test(sec.charAt(6))) sec = sec.slice(7).trim();
  if (!HEADER_RE.test(hdr)) throw new Error('header name is invalid');
  if (RESERVED_HEADERS.has(hdr.toLowerCase())) throw new Error('header name is reserved');
  if (/[\r\n]/.test(sec)) throw new Error('key must be a single line');
  return { header: hdr, secret: sec };
}

/** POST via node:https, pinned to a vetted address. Resolves {ok,status}. */
function pinnedPost(u, addrs, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const pick = addrs[0];
    const req = https.request({
      protocol: 'https:',
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
      servername: net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname,
      // Connect only to the address that passed the public-IP check.
      lookup: (hostname, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: pick.address, family: pick.family }]);
        else cb(null, pick.address, pick.family);
      },
      signal,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

class AgentWebhooks {
  /**
   * @param {string} [filePath]
   * @param {{lookup?: Function}} [opts] lookup(host) => [{address,family}] (tests)
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath || process.env.AGENT_WEBHOOKS_PATH || DEFAULT_PATH;
    this.lookup = opts.lookup || null;
  }

  /** @returns {Map<string, object>} */
  _read() {
    const agents = new Map();
    try {
      const d = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const src = d && d.agents && typeof d.agents === 'object' ? d.agents : {};
      for (const k of Object.keys(src)) {
        const key = normKey(k);
        const v = src[k];
        if (key && key === k && v && typeof v === 'object') {
          agents.set(key, {
            url: typeof v.url === 'string' ? v.url : '',
            secret: typeof v.secret === 'string' ? v.secret : '',
            header: typeof v.header === 'string' ? v.header : 'Authorization',
            lastStatus: v.lastStatus == null ? null : v.lastStatus,
            lastAt: typeof v.lastAt === 'string' ? v.lastAt : null,
          });
        }
      }
    } catch { /* missing or unreadable: empty */ }
    return agents;
  }

  /** @param {Map<string, object>} agents */
  _write(agents) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const out = { agents: Object.fromEntries(agents) };
    fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
  }

  list() {
    const out = Object.create(null);
    for (const [k, v] of this._read()) {
      let host = '';
      try { host = new URL(v.url).host; } catch { /* ignore */ }
      out[k] = {
        configured: !!v.url,
        host,
        hasSecret: !!v.secret,
        header: v.header || 'Authorization',
        lastStatus: v.lastStatus || null,
        lastAt: v.lastAt || null,
      };
    }
    return out;
  }

  get(agentKey) {
    const key = normKey(agentKey);
    if (!key) return null;
    return this._read().get(key) || null;
  }

  set(agentKey, { url, secret, header } = {}) {
    const key = normKey(agentKey);
    if (!key) throw new Error('agent key is invalid');
    const { u } = parseTarget(url);
    const parsed = parseHeaderAndSecret(header, secret);
    const agents = this._read();
    const prev = agents.get(key) || {};
    agents.set(key, {
      url: u.toString(),
      // Keep the stored secret when the form leaves it blank.
      secret: parsed.secret || (prev.secret || ''),
      header: parsed.header,
      lastStatus: prev.lastStatus || null,
      lastAt: prev.lastAt || null,
    });
    this._write(agents);
    return this.list()[key];
  }

  remove(agentKey) {
    const key = normKey(agentKey);
    if (!key) return;
    const agents = this._read();
    if (agents.delete(key)) this._write(agents);
  }

  _record(key, status) {
    const agents = this._read();
    const rec = agents.get(key);
    if (!rec) return;
    rec.lastStatus = status;
    rec.lastAt = new Date().toISOString();
    this._write(agents);
  }

  /**
   * POST the assignment to the agent's webhook. Never throws.
   * @param {string} agentKey
   * @param {object} payload
   * @param {Function} [fetchImpl] test seam: (url, opts) => {ok,status}; the
   *   public-address check still runs first.
   * @returns {Promise<{sent:boolean,status?:number,error?:string,skipped?:string}>}
   */
  async notify(agentKey, payload, fetchImpl) {
    const key = normKey(agentKey);
    if (!key) return { sent: false, skipped: 'invalid agent key' };
    const hook = this.get(key);
    if (!hook || !hook.url) return { sent: false, skipped: 'no webhook configured' };
    let target;
    let addrs;
    try {
      target = parseTarget(hook.url);
      addrs = await resolvePublic(target.host, this.lookup);
    } catch (e) {
      this._record(key, 'blocked');
      return { sent: false, error: e.message };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (hook.secret && HEADER_RE.test(hook.header) && !/[\r\n]/.test(hook.secret)) {
      headers[hook.header] = hook.header.toLowerCase() === 'authorization'
        ? 'Bearer ' + hook.secret
        : hook.secret;
    }
    const body = JSON.stringify(Object.assign({}, payload || {}, { source: 'overclaw', agent: key },
      payload && payload.event ? {} : { event: 'task.assigned' }));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = fetchImpl
        ? await fetchImpl(target.u.toString(), { method: 'POST', headers, body, redirect: 'manual', signal: ctrl.signal })
        : await pinnedPost(target.u, addrs, headers, body, ctrl.signal);
      this._record(key, r.status);
      return { sent: !!r.ok, status: r.status };
    } catch (e) {
      this._record(key, 'error');
      return { sent: false, error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
    } finally {
      clearTimeout(t);
    }
  }
}

AgentWebhooks.normKey = normKey;
AgentWebhooks.isBlockedAddress = isBlockedAddress;
AgentWebhooks.parseHeaderAndSecret = parseHeaderAndSecret;
module.exports = AgentWebhooks;
