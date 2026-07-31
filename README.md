# OverClaw — AI Swarm Oversight Dashboard

A read-only oversight webapp for multi-agent AI swarms.  OverClaw integrates
with an **Obsidian vault** as the shared coordination layer and optionally
connects to an **OpenClaw gateway** for live agent data.

Point it at the vault your swarm writes to and get a real-time view of every
task, agent, heartbeat, and alert — across all agents, regardless of the AI
tool they run on.

---

## Features

| Feature | Source |
|---|---|
| 📋 **Task Board** — Kanban view of all swarm tasks | Vault |
| 🤖 **Agent Roster** — Live registry with status badges | Vault |
| 📡 **Activity Feed** — Heartbeats from all machines, alert highlighting | Vault |
| 🌐 **Swarm Overview** — Single-page swarm snapshot with NEEDS-ATTENTION alerts | Vault |
| 💬 **Sessions** — Live OpenClaw sessions | OpenClaw gateway |
| ⏰ **Cron Jobs** — Scheduled jobs registered with OpenClaw | OpenClaw gateway |
| 🧠 **Skills** — Agent skill library | OpenClaw gateway |
| 🖥️ **Nodes** — Connected hardware nodes | OpenClaw gateway |
| ⚙️ **Config** — Agent configuration files | OpenClaw gateway |

Vault data is always available if the vault is readable.  OpenClaw gateway data
degrades gracefully if the gateway is offline.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-username/overclaw.git
cd overclaw

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env — set VAULT_PATH at minimum

# 4. Start
npm start
# Open http://localhost:8355
```

---

## Configuration

All configuration is via environment variables (or a `.env` file in the project
root).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8355` | HTTP port to listen on |
| `VAULT_PATH` | `~/My-AI-Brain` | Absolute path to your Obsidian vault |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | OpenClaw gateway WebSocket URL |
| `OPENCLAW_API_TOKEN` | *(none)* | API token for OpenClaw authentication |

The app starts and runs without `OPENCLAW_API_TOKEN` (vault-only mode).  OpenClaw
routes simply return an error card instead of crashing.

---

## Vault Structure

OverClaw reads the following files from your vault.  All paths are relative to
`VAULT_PATH`.

```
VAULT_PATH/
├── 03 - Agents/
│   ├── Agent Registry.md          # Agent roster table
│   └── Coordination/
│       └── Task Board.md          # Kanban task board (Inbox / In Progress / Blocked / Done)
└── 08 - QA-and-Monitoring/
    └── Heartbeats/
        ├── Machine-A/             # Heartbeat .md files for Machine A
        ├── Machine-B/             # Heartbeat .md files for Machine B
        └── Machine-B/
            └── SubAgent/          # Heartbeat files for a sub-agent on Machine B
```

### Task Board format

The task board is a markdown file with `## ` sections for each column
(`Inbox`, `In Progress`, `Blocked`, `Done`).  Each section contains a
markdown table with columns such as:

```markdown
## 📥 Inbox
| Task ID | Title | Agent | Priority | Deadline | Created |
|---|---|---|---|---|---|
| [TASK-ABCD1234-001](link) | Do the thing | AgentName | High | 2026-08-01 | 2026-07-30 |
```

### Heartbeat filenames

OverClaw parses the filename to extract date and event type:

```
YYYY-MM-DD-HH-MM-event-type.md          # dated heartbeat
NEEDS-ATTENTION-YYYY-MM-DD-HH-MM-*.md   # alert (shown in red)
HANDLED-YYYY-MM-DD-HH-MM-*.md           # resolved alert
```

---

## Architecture

OverClaw is a lightweight Express/EJS server.  It has two data sources:

1. **Vault** (`lib/VaultReader.js`) — reads the Obsidian markdown vault on
   disk.  No vault sync daemon is needed; every page request reads fresh
   files directly.  Works with any vault that is accessible on the local
   filesystem (local clone, NFS mount, etc.).

2. **OpenClaw gateway** (`lib/ClawBridge.js`) — connects via WebSocket to an
   OpenClaw gateway to retrieve live sessions, cron jobs, skills, and nodes.
   This is optional and specific to the OpenClaw agent runtime.

Static assets live in `public/`.  All views are EJS templates in `views/`.
Vault-specific data is never committed to git (`data/` is gitignored).

---

## License

MIT — see [LICENSE](./LICENSE).
