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
git clone https://github.com/jhurff/overclaw.git
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

OverClaw reads from an Obsidian vault that serves as the shared memory and
coordination layer for your agent swarm.  All paths are relative to `VAULT_PATH`.

The full recommended vault layout (see `starter-brain/` for a ready-to-use template):

```
VAULT_PATH/
├── 00 - Home/
│   ├── README.md                  # Vault index and orientation
│   ├── VAULT-INDEX.md             # Map of all folders and their purpose
│   └── ONBOARDING.md              # How to wire a new agent into the swarm
│
├── 01 - Prompts/                  # Reusable prompt templates for agents
│
├── 02 - Projects/                 # One subfolder per active project
│   └── <project-name>/
│       ├── README.md              # What it is, current status
│       ├── BRIEF.md               # Original ask, goals, constraints
│       └── LOG.md                 # Running notes as work progresses
│
├── 03 - Agents/                   # ⬅ OverClaw reads this section
│   ├── Agent Registry.md          # Agent roster table (name, status, role, machine)
│   ├── AGENT-IDENTITY.md          # Why identity files matter; how to fill them in
│   ├── Notifications/             # ⬅ OverClaw reads this section
│   │   └── <AgentName>/           # Per-agent inbox — notification .md files dropped here
│   └── Coordination/
│       ├── README.md              # Routing rules and handoff patterns
│       ├── Task Board.md          # ⬅ OverClaw reads this — Kanban (Inbox / In Progress / Blocked / Done)
│       └── Tasks/
│           ├── TASK-XXXX.md       # Individual task files
│           └── Requests/          # DRAFT task requests awaiting approval
│
├── 04 - Models-and-Tools/         # Notes on AI models, APIs, and integrations
│
├── 05 - Research/                 # Reference material and background notes
│
├── 06 - Loops/                    # Recurring workflows, heartbeat specs, automation patterns
│
├── 07 - Weekly-Reviews/           # Weekly swarm summaries (YYYY-WNN.md)
│
├── 08 - QA-and-Monitoring/        # ⬅ OverClaw reads this section
│   ├── ATLAS/
│   │   └── atlas.json             # ⬅ OverClaw reads this — blind-spot map
│   └── Heartbeats/
│       ├── <Machine-A>/           # ⬅ OverClaw reads this — heartbeat .md files per machine
│       ├── <Machine-B>/
│       └── <Machine-B>/<SubAgent>/
│
├── _Templates/                    # Blank templates: BOOTSTRAP, SOUL, AGENTS, MEMORY, USER, task
└── _Archive/                      # Completed projects and retired files
```

> **OverClaw reads:** `03 - Agents/Agent Registry.md`, `03 - Agents/Notifications/`,
> `03 - Agents/Coordination/Task Board.md`, `08 - QA-and-Monitoring/ATLAS/atlas.json`,
> and `08 - QA-and-Monitoring/Heartbeats/`.  The remaining folders are for agent and
> human use and do not affect the dashboard.

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
