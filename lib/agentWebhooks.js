'use strict';

// Per-agent assignment pings. Each Grok Bot agent owns a webhook-triggered
// routine; OverClaw POSTs to it when a task is assigned so the agent wakes and
// picks the task up. URLs and sender keys live in data/agent-webhooks.json
// (gitignored, chmod 600) and are never returned in full by the API.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'agent-webhooks.json');

function normKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

class AgentWebhooks {
  constructor(filePath) {
    this.filePath = filePath || process.env.AGENT_WEBHOOKS_PATH || DEFAULT_PATH;
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return d && typeof d.agents === 'object' ? d : { agents: {} };
    } catch {
      return { agents: {} };
    }
  }

  _write(d) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(d, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
  }

  list() {
    const d = this._read();
    const out = {};
    for (const [k, v] of Object.entries(d.agents)) {
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
    return this._read().agents[normKey(agentKey)] || null;
  }

  set(agentKey, { url, secret, header }) {
    const key = normKey(agentKey);
    if (!key) throw new Error('agent key required');
    let u;
    try { u = new URL(String(url || '')); } catch { throw new Error('valid webhook URL required'); }
    if (u.protocol !== 'https:') throw new Error('webhook URL must be https');
    let hdr = String(header || '').trim();
    let sec = secret ? String(secret).trim() : '';
    // Forgive pastes: "Authorization: Bearer x", "Bearer x", or a key in the header box.
    const m = hdr.match(/^([A-Za-z0-9-]{1,64})\s*:\s*(.+)$/);
    if (m) { hdr = m[1]; if (!sec) sec = m[2].trim(); }
    if (hdr && !/^[A-Za-z0-9-]{1,64}$/.test(hdr) || /^(bearer\s|crsr_)/i.test(hdr)) {
      if (!sec) sec = hdr;
      hdr = '';
    }
    if (!hdr) hdr = 'Authorization';
    sec = sec.replace(/^bearer\s+/i, '');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(hdr)) throw new Error('header name is invalid');
    const d = this._read();
    const prev = d.agents[key] || {};
    d.agents[key] = {
      url: u.toString(),
      // Keep the stored secret when the form leaves it blank.
      secret: sec || (prev.secret || ''),
      header: hdr,
      lastStatus: prev.lastStatus || null,
      lastAt: prev.lastAt || null,
    };
    this._write(d);
    return this.list()[key];
  }

  remove(agentKey) {
    const d = this._read();
    delete d.agents[normKey(agentKey)];
    this._write(d);
  }

  _record(key, status) {
    const d = this._read();
    if (!d.agents[key]) return;
    d.agents[key].lastStatus = status;
    d.agents[key].lastAt = new Date().toISOString();
    this._write(d);
  }

  /**
   * POST the assignment to the agent's webhook. Never throws.
   * @returns {Promise<{sent:boolean,status?:number,error?:string,skipped?:string}>}
   */
  async notify(agentKey, payload, fetchImpl) {
    const key = normKey(agentKey);
    const hook = this.get(key);
    if (!hook || !hook.url) return { sent: false, skipped: 'no webhook configured' };
    const headers = { 'Content-Type': 'application/json' };
    if (hook.secret) {
      headers[hook.header] = hook.header.toLowerCase() === 'authorization'
        ? 'Bearer ' + hook.secret
        : hook.secret;
    }
    const doFetch = fetchImpl || fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await doFetch(hook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(Object.assign({ source: 'overclaw', event: 'task.assigned', agent: key }, payload)),
        signal: ctrl.signal,
      });
      this._record(key, r.status);
      return { sent: r.ok, status: r.status };
    } catch (e) {
      this._record(key, 'error');
      return { sent: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
    } finally {
      clearTimeout(t);
    }
  }
}

module.exports = AgentWebhooks;
