#!/usr/bin/env node
'use strict';
/**
 * seed-demo.js
 * Creates a fresh demo brain.db with realistic sample data.
 * Run before starting the demo server:  node scripts/seed-demo.js
 *
 * Wipes data/brain.db and rebuilds from starter-brain/ + synthetic events.
 */

const path    = require('path');
const fs      = require('fs');
const BrainStore = require('../lib/BrainStore');

// ── SAFETY GUARDS ─────────────────────────────────────────────────────────────────
// This script WIPES the target DB. It must NEVER run against the live instance.
//
// Required: DEMO_MODE=true must be set in the environment.
// Optional: BRAIN_DB_PATH must point somewhere other than the default live path.
//
// The script will refuse to run if:
//   1. DEMO_MODE !== 'true'
//   2. BRAIN_DB_PATH resolves to the known live DB location
//   3. BRAIN_DB_PATH is not set (falls back to live default)

if (process.env.DEMO_MODE !== 'true') {
  console.error('\n❌ ABORTED: DEMO_MODE=true is required to run this script.');
  console.error('   This script wipes the target brain.db. Set DEMO_MODE=true explicitly.');
  process.exit(1);
}

if (!process.env.BRAIN_DB_PATH) {
  console.error('\n❌ ABORTED: BRAIN_DB_PATH must be set explicitly.');
  console.error('   Refusing to default to the live data/brain.db.');
  process.exit(1);
}

const DB_PATH = path.resolve(process.env.BRAIN_DB_PATH);

// Known live DB paths — hard-coded block list
const BLOCKED_PATHS = [
  path.resolve(path.join(__dirname, '..', 'data', 'brain.db')),
  path.resolve(path.join(process.env.HOME || '', 'repos', 'overclaw', 'data', 'brain.db')),
];

if (BLOCKED_PATHS.includes(DB_PATH)) {
  console.error('\n❌ ABORTED: BRAIN_DB_PATH resolves to the live instance DB:');
  console.error('  ', DB_PATH);
  console.error('   Set BRAIN_DB_PATH to a demo-specific path (e.g. /tmp/demo-brain.db).');
  process.exit(1);
}

console.log('✅ Safety checks passed.');
console.log('   DEMO_MODE :', process.env.DEMO_MODE);
console.log('   DB_PATH   :', DB_PATH);
const STARTER_DIR = path.join(__dirname, '..', 'starter-brain');

// ── Wipe existing demo DB (safe — guards above confirmed NOT the live DB) ──
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('Wiped existing demo brain.db');
}

const db = new BrainStore(DB_PATH);
console.log('Created fresh brain.db');

// ── Create demo admin user ────────────────────────────────────────────────────
const bcrypt = require('bcrypt');
const hash   = bcrypt.hashSync(process.env.DEMO_PASSWORD || 'demo', 10);
db.db.prepare(
  `INSERT INTO users(username, password_hash, role, created_at, last_login)
   VALUES ('demo', ?, 'admin', ?, NULL)`
).run(hash, Date.now());
console.log('Created demo user (username: demo)');

// ── Import starter-brain docs ─────────────────────────────────────────────────
let imported = 0;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian']);

function* walkMd(dir, root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMd(full, root);
    else if (entry.name.endsWith('.md')) yield path.relative(root, full);
  }
}

if (fs.existsSync(STARTER_DIR)) {
  for (const rel of walkMd(STARTER_DIR, STARTER_DIR)) {
    const content = fs.readFileSync(path.join(STARTER_DIR, rel), 'utf-8');
    db.putDoc(rel, content, { updatedBy: 'seed', changeNote: 'Demo seed' });
    imported++;
  }
  console.log(`Imported ${imported} docs from starter-brain/`);
} else {
  console.log('No starter-brain/ dir — seeding synthetic docs');
}

// ── Seed synthetic demo documents ─────────────────────────────────────────────
const NOW = Date.now();
const H   = 3600000;

const DEMO_DOCS = [
  {
    path: 'README.md',
    content: `# OverClaw Demo — AI Agent Swarm Dashboard

Welcome to the **OverClaw** live demo at [overclaw.trythesite.org](https://overclaw.trythesite.org).

This demo resets every 24 hours with fresh sample data.

---

## What Is OverClaw?

OverClaw is an AI agent swarm oversight dashboard. It gives you:

- 🌐 **Swarm Overview** — real-time agent health, heartbeats, task pipeline
- 🧠 **AI Brain** — shared document database for all agents (3,000+ docs)
- 📋 **Task Board** — Kanban-style coordination across agents
- 📡 **Activity Feed** — unified event stream (reads, writes, heartbeats)
- 🤖 **Agent Management** — zone-aware onboarding, MCP snippets
- 🔌 **MCP Server** — Model Context Protocol endpoint for AI agent connections

## Demo Credentials

| Field    | Value  |
|----------|--------|
| Username | \`demo\` |
| Password | \`demo\` |

> ⚠️ This is a read/write demo — changes you make will be wiped at midnight UTC.

## Live Swarm Agents

| Agent | Role | Zone |
|-------|------|------|
| **Spike** 🦞 | Chief of Staff, sys ops | localhost |
| **Steve** 📈 | SEO & marketing intel | localnet |
| **Lex** 💻 | Web dev & engineering | localnet |
| **Bill** 🐟 | Here2Fish ops | localnet |
| **Luther** 🤖 | Research & analysis | private WAN |

---

*Demo resets daily. [Learn more about OverClaw →](https://github.com/jhurff/overclaw)*
`,
    agent: 'seed',
  },
  {
    path: '03 - Agents/Agent Registry.md',
    content: `# Agent Registry

| Nickname | Agent | Type | Machine | Account / Identity | Primary Role | Status | Registered |
|----------|-------|------|---------|--------------------|--------------|--------|------------|
| **Spike** | Spike — H2FClanker2 | OpenClaw | H2FClanker2 (192.168.68.42, Ubuntu 26.04) | jhurff | **Chief of Staff**, Personal Assistant, Content publishing, system ops, cross-agent coordination | 🟢 Active | 2026-06-18 |
| **Steve** | Claude Cowork — BrightMove MBP | Claude Cowork | MacBook Pro (192.168.68.21, macOS) | jimmy@brightmove.com | Intelligence & Monitoring — SEO/AEO tracking, daily traffic reports, marketing intelligence | 🟢 Active | 2026-06-08 |
| **Lex** | Cursor — BrightMove MBP | Cursor | MacBook Pro (192.168.68.21, macOS) | here2fishinc@gmail.com | Engineering — web dev, data analysis, scripting | 🟢 Active | 2026-06-18 |
| **Bill** | OpenAI ChatGPT — H2FClanker1 | ChatGPT | H2FClanker1 (192.168.68.43, Windows) | jhurff@gmail.com | Here2Fish Operations — daily brief, Gmail triage, coordination | 🟢 Active | 2026-06-10 |
| **Luther** | Grok Bot — Luther | Grok Bot | Cloud (Tailscale) | jhurff@gmail.com | Research, analysis, fractional CTO pipeline | 🟢 Active | 2026-09-01 |
`,
    agent: 'seed',
  },
  {
    path: '03 - Agents/Coordination/Task Board.md',
    content: `---
title: Task Board
last_updated: ${new Date().toISOString().slice(0, 10)}
---

# Task Board

## 📥 Inbox

| Task ID | Title | Assigned To | Priority | Deadline |
|---------|-------|-------------|----------|----------|
| TASK-042 | Audit FTM website SEO gaps | Steve | high | 2026-11-01 |
| TASK-043 | Update BoatJobBoard job listings | Bill | medium | 2026-11-03 |

## 🔄 In Progress

| Task ID | Title | Assigned To | Started | Notes |
|---------|-------|-------------|---------|-------|
| TASK-038 | Build OverClaw demo environment | Spike | 2026-10-28 | Demo site at overclaw.trythesite.org |
| TASK-039 | DMARC policy tighten FTMarine | Spike | 2026-10-25 | Raise pct to 100, then p=reject |
| TASK-040 | FTM homepage hero copy refresh | Lex | 2026-10-26 | Waiting on Jimmy's photo assets |

## ✅ Done (Recent)

| Task ID | Title | Assigned To | Completed |
|---------|-------|-------------|-----------|
| TASK-035 | Brain WYSIWYG editor (Toast UI) | Spike | 2026-10-28 |
| TASK-036 | Network zone config + agent onboarding | Spike | 2026-10-28 |
| TASK-037 | Unified activity feed | Spike | 2026-10-28 |

## 🔴 Blocked

| Task ID | Title | Assigned To | Blocker |
|---------|-------|-------------|---------|
| TASK-034 | Google Postmaster Tools verify FTMarine | Spike | Domain already claimed by unknown Google account |
`,
    agent: 'seed',
  },
  {
    path: '04 - Models-and-Tools/OverClaw-Brain-DB.md',
    content: `# OverClaw Brain DB

The Brain DB is a SQLite-backed document store powering all agent knowledge.

## Access

| Method | Details |
|--------|---------|
| Browser | \`/brain\` — WYSIWYG editor |
| REST API | \`GET/PUT /api/brain/doc?path=\` |
| MCP tools | \`brain_read\`, \`brain_write\`, \`brain_search\`, \`brain_list\` |

## MCP Tool Reference

\`\`\`json
brain_read   ({ path })              → { content, updated_at, updated_by }
brain_write  ({ path, content })     → { ok, version }
brain_search ({ query, dir, limit }) → { results: [{path, snippet}] }
brain_list   ({ dir, recursive })    → { items: [{path, type}] }
brain_history({ path, limit })       → { history: [{version, saved_at, saved_by}] }
\`\`\`

## Stats

- **Documents:** ~3,000
- **Format:** Markdown
- **History:** Full version history per document
- **Auth:** Session cookie (browser) or Bearer token (agents)
`,
    agent: 'seed',
  },
  {
    path: '08 - QA-and-Monitoring/ATLAS/atlas-overview.md',
    content: `# GAP ATLAS — Blind Spot Map

The GAP ATLAS tracks known failure regions across the agent swarm.

## Active Regions

| Region | Weight | Description |
|--------|--------|-------------|
| \`cross-machine-constraint\` | 0.85 | jimmy@brightmove.com Outlook/M365 only accessible from BrightMove-MBP |
| \`credential-missing\` | 0.80 | External API / OAuth / missing Bitwarden item |
| \`config-drift\` | 0.70 | Model errors, allowlist failures, silent job drift |
| \`platform-unavailable\` | 0.65 | OAuth expired, connector missing, API down |
| \`permissions-gap\` | 0.60 | sudo required, system-level ops, elevated mode off |
| \`scope-underspecified\` | 0.50 | Vague task, no output spec, no acceptance criteria |

## Flagging Protocol

When a task lands in a region with weight ≥ 0.5:
1. State: \`⚠️ GAP CHECK: Task lands in blind spot \`<region>\` (weight: X.X)\`
2. Quote the \`flagBehavior\` verbatim
3. Do not guess. Do not attempt workarounds.
4. Ask for human intervention or name the specific fix needed.
`,
    agent: 'seed',
  },
];

for (const doc of DEMO_DOCS) {
  db.putDoc(doc.path, doc.content, { updatedBy: doc.agent || 'seed', changeNote: 'Demo seed' });
}
console.log(`Seeded ${DEMO_DOCS.length} synthetic docs`);

// ── Seed synthetic brain_activity events ─────────────────────────────────────
const AGENTS  = ['spike', 'steve', 'lex', 'bill', 'luther'];
const OPS     = ['read', 'read', 'read', 'write', 'search', 'list'];
const PATHS   = [
  '03 - Agents/Coordination/Task Board.md',
  '03 - Agents/Agent Registry.md',
  'README.md',
  '04 - Models-and-Tools/OverClaw-Brain-DB.md',
  '08 - QA-and-Monitoring/ATLAS/atlas-overview.md',
  '03 - Agents/Coordination/Tasks',
];

const actIns = db.db.prepare(
  `INSERT INTO brain_activity(agent, op, path, ok, ts) VALUES (?, ?, ?, 1, ?)`
);
const actTx = db.db.transaction(() => {
  // Seed 200 synthetic activity events spread over last 24h
  for (let i = 0; i < 200; i++) {
    const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
    const op    = OPS[Math.floor(Math.random() * OPS.length)];
    const p     = PATHS[Math.floor(Math.random() * PATHS.length)];
    const ts    = NOW - Math.floor(Math.random() * 24 * H);
    actIns.run(agent, op, p, ts);
  }
});
actTx();
console.log('Seeded 200 synthetic brain_activity events');

// ── Seed synthetic heartbeat docs ─────────────────────────────────────────────
const HB_AGENTS = [
  { name: 'Spike',  dir: 'H2FClanker2/OpenClaw',   machine: 'H2FClanker2' },
  { name: 'Steve',  dir: 'BrightMove-MBP',          machine: 'BrightMove-MBP' },
  { name: 'Lex',    dir: 'BrightMove-MBP/Cursor',   machine: 'BrightMove-MBP' },
  { name: 'Bill',   dir: 'H2FClanker1',              machine: 'H2FClanker1' },
  { name: 'Luther', dir: 'Grok-Bot',                 machine: 'Grok-Bot' },
];

for (const ag of HB_AGENTS) {
  // Write 3 recent heartbeats per agent
  for (let i = 0; i < 3; i++) {
    const ts   = new Date(NOW - i * 2 * H);
    const date = ts.toISOString().slice(0, 10);
    const time = ts.toISOString().slice(11, 16).replace(':', '-');
    const docPath = `08 - QA-and-Monitoring/Heartbeats/${ag.dir}/${date}-${time}-heartbeat.md`;
    const content = `---
machine: ${ag.machine}
agent: ${ag.name.toLowerCase()}
date: ${ts.toISOString()}
status: ok
---

# Heartbeat — ${ag.name} — ${ts.toISOString().slice(0, 16).replace('T', ' ')}

- Status: ✅ OK
- Tasks checked: ${Math.floor(Math.random() * 5)} in progress
- Brain: connected
`;
    db.putDoc(docPath, content, { updatedBy: ag.name.toLowerCase(), changeNote: 'Heartbeat' });
  }
}
console.log(`Seeded heartbeat docs for ${HB_AGENTS.length} agents`);

console.log('\n✅ Demo seed complete.');
console.log(`   DB: ${DB_PATH}`);
console.log(`   Docs: ${db.stats().documents}`);
console.log(`   Login: demo / ${process.env.DEMO_PASSWORD || 'demo'}`);
