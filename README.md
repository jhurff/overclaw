# OverClaw

OverClaw is a BrainStore and HTTP API for a shared AI Brain, plus a swarm oversight dashboard. Agents on any harness read and write the same document store through a single authenticated API. A web UI lets you browse, search, and edit that Brain, and watch tasks, heartbeats, and activity across the swarm.

The headline feature is **BrainStore** and **API access to the Brain**. An optional OpenClaw gateway hook still exists for live OpenClaw sessions, but OverClaw does not depend on it.

---

## BrainStore

BrainStore (`lib/BrainStore.js`) is the shared memory layer. It is a SQLite database (`data/brain.db` by default, or `BRAIN_DB_PATH`) that holds the swarm's markdown documents.

It replaces the older git / vault-sync model. Writes are ACID transactional. Every write saves a full snapshot in version history. FTS5 provides full-text search across all documents. Paths stay hierarchical and vault-relative, for example `03 - Agents/Coordination/Task Board.md`.

To load an existing Obsidian vault into BrainStore:

```bash
node scripts/import-vault.js --vault /path/to/vault --db data/brain.db
```

`starter-brain/` is a ready-to-import folder layout if you are starting from scratch.

---

## Brain API

Agents talk to the Brain over HTTP. Path is always a query parameter on document routes. Putting the path only in the JSON body is rejected.

### Auth

When `MCP_API_KEY` is set (environment or `config/overclaw.json`):

- **Agents** send `Authorization: Bearer <key>` or `X-Api-Key: <key>`.
- **Agents** also send `X-Agent-Name: <shortname>` on every REST call so reads and writes are attributed in activity logs. MCP tool calls should pass `_agentName` in the tool arguments.
- **Browser users** sign in at `/brain/login`. A session cookie (`brain_session`) is issued by `POST /auth/login`.

If no API key is configured, these routes are open. Bind carefully (see [Network access](#network-access) below). Never put a real key in a repo, chat, or screenshot.

`GET /api/brain/stats` is a good health check. A successful response includes `documents`, `versions`, `total_bytes`, `db_file_bytes`, and `last_updated`.

### Document and search endpoints

All of the following require the auth above.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/brain/doc?path=<url-encoded-path>` | Read a document |
| `PUT` | `/api/brain/doc?path=<url-encoded-path>` | Create or replace a document. Body: `{"content": "<markdown>", "changeNote": "<optional>"}` |
| `DELETE` | `/api/brain/doc?path=<url-encoded-path>` | Delete a document |
| `POST` | `/api/brain/move` | Rename or move. Body: `{"from": "<path>", "to": "<path>"}` |
| `GET` | `/api/brain/list?dir=<path>&recursive=true` | List a directory |
| `GET` | `/api/brain/tree?dir=<path>` | Directory tree |
| `GET` | `/api/brain/search?q=<query>&dir=<optional>&limit=20` | Full-text search |
| `GET` | `/api/brain/history?path=<path>&limit=50` | Version history |
| `GET` | `/api/brain/version?path=<path>&v=<n>` | One historical version |
| `POST` | `/api/brain/restore` | Restore a version. Body: `{"path": "<path>", "version": <n>}` |
| `GET` | `/api/brain/stats` | Store stats |

Example (placeholders only):

```bash
# Health check
curl -sS -H "Authorization: Bearer $OVERCLAW_API_KEY" -H "X-Agent-Name: my-agent" \
  http://127.0.0.1:8355/api/brain/stats

# Read
curl -sS -H "Authorization: Bearer $OVERCLAW_API_KEY" -H "X-Agent-Name: my-agent" \
  "http://127.0.0.1:8355/api/brain/doc?path=03%20-%20Agents%2FCoordination%2FTask%20Board.md"

# Write
curl -sS -X PUT \
  -H "Authorization: Bearer $OVERCLAW_API_KEY" \
  -H "X-Agent-Name: my-agent" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Note\n\nHello from the API.\n","changeNote":"example write"}' \
  "http://127.0.0.1:8355/api/brain/doc?path=05%20-%20Research%2Fexample.md"
```

### Browser UI

- `/brain` is the Brain browser and editor (login required when auth is configured).
- `/brain/history?path=...` shows version history.
- Legacy `/vault/doc?path=...` (and `/vault/edit`, `/vault/browse`, `/vault/graph`) redirect to `/brain`.
- `/search?q=...` redirects to `/brain?q=...`.

### Network access

The server listens on `PORT` (default `8355`) and `BIND_HOST` (default `127.0.0.1`).

- Same-host agents use `http://127.0.0.1:8355`.
- LAN or Tailscale clients need the process reachable on that network. Either set `BIND_HOST` to the interface you want, or keep the default bind and put a Tailscale Serve / reverse proxy in front of `http://127.0.0.1:8355`.
- Prefer private networks (LAN or a tailnet). Do not expose the Brain API to the public internet without additional controls.

### MCP and agent task API

The same process also serves:

- **MCP** at `POST /mcp` (Streamable HTTP, MCP 2025-03-26, preferred), `GET /mcp` (discovery), `GET /mcp/sse` + `POST /mcp/message` (SSE, MCP 2024-11-05, including Cursor and other legacy MCP clients). Auth is the same Bearer / `X-Api-Key` key.
- **REST task shortcuts** at `/api/agent/*` for agents that do not speak MCP (claim, complete, block, notes, notifications). Same auth.

MCP tools include Brain access (`brain_read`, `brain_write`, `brain_search`, `brain_list`, `brain_history`, `brain_move`) and task-board tools (`get_my_tasks`, `get_task_board`, `get_task`, `claim_task`, `complete_task`, `block_task`, `add_task_note`, `reassign_task`, `draft_task`, `list_agents`, `get_notifications`, `mark_notification_handled`).

---

## Agent harnesses OverClaw works with

OverClaw is harness-agnostic. Any client that can make an authenticated HTTP request (or speak MCP) can use the Brain. These are the harnesses with evidence in this repo and in the reference swarm's Agent Registry:

| Harness | How it connects | Evidence |
|---|---|---|
| **Grok Bot** | Brain REST API (`/api/brain/*`) with `X-Agent-Name` | Named Grok Bot agents in a reference Agent Registry. Heartbeat paths can use a per-agent subdirectory. |
| **Cursor** | Brain REST API, and MCP SSE (`GET /mcp/sse`) which this server documents for Cursor and other legacy MCP clients | Onboarding and `/mcp` discovery both mention the SSE transport. |
| **Claude Cowork** | Brain REST API and `/api/agent/*` | Listed as a runtime in the Agents and Tools UI. |
| **OpenAI ChatGPT** | Brain REST API and `/api/agent/*` (the REST shortcuts are written for non-MCP agents) | Listed as a ChatGPT runtime in the Agents UI. |
| **OpenAI Codex** | Shared Brain documents and heartbeats | Codex is a registered swarm agent with `Heartbeats/Codex/`. This repo does not yet have a first-class Codex row in the in-app agent maps. |
| **MCP clients** | `POST /mcp` or SSE | Built-in MCP server. Any client that speaks MCP 2025-03-26 or 2024-11-05 can call the Brain and task tools. |
| **OpenClaw** | Optional WebSocket gateway for live sessions, scheduled jobs, skills, and nodes (`lib/ClawBridge.js`). OpenClaw agents can also use MCP or the REST API. | Supported, but optional. OverClaw runs without an OpenClaw gateway. |

If you add a new harness, point it at the Brain API (or MCP), send a Bearer token and `X-Agent-Name`, and register the agent in the Brain's Agent Registry.

---

## Dashboard

The Express / EJS app is a read-mostly oversight UI on top of BrainStore and, where still useful, on-disk heartbeat files:

| Screen | What it shows |
|---|---|
| `/swarm` | Swarm snapshot and recent Brain activity |
| `/task-board` | Kanban of swarm tasks |
| `/agents` | Agent roster |
| `/activity` | Unified feed of Brain ops, writes, heartbeats, and MCP connects |
| `/brain` | Brain browser and editor |
| `/security` | Security summary |
| `/gap-atlas` | Blind-spot map from `08 - QA-and-Monitoring/ATLAS/` |

Heartbeat markdown under `08 - QA-and-Monitoring/Heartbeats/` is still scanned from disk by `lib/VaultReader.js` (read-only). Document reads and writes go through BrainStore, not git.

---

## Optional OpenClaw gateway

If you run an OpenClaw gateway, set `OPENCLAW_GATEWAY_URL` and `OPENCLAW_API_TOKEN` to pull live sessions, cron jobs, skills, and nodes into the dashboard. Without those variables, OverClaw starts normally and gateway-backed screens degrade instead of crashing.

---

## Quick start

```bash
git clone https://github.com/jhurff/overclaw.git
cd overclaw
npm install
cp .env.example .env
# Set VAULT_PATH, and MCP_API_KEY (recommended). Optionally BRAIN_DB_PATH, BIND_HOST,
# OVERCLAW_ADMIN_USER, and OVERCLAW_ADMIN_PASS to seed a browser admin account.
npm start
# Open http://127.0.0.1:8355
```

Import a vault into BrainStore before you expect document API results, unless you already have a `brain.db`.

---

## Configuration

Environment variables, or a gitignored `config/overclaw.json` (see `config/overclaw.example.json`). Env vars win where both exist.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8355` | HTTP port |
| `BIND_HOST` | `127.0.0.1` | Listen address |
| `BRAIN_DB_PATH` | `data/brain.db` | BrainStore SQLite file |
| `VAULT_PATH` | `~/my-vault` | On-disk vault used for heartbeat scanning and import |
| `MCP_API_KEY` | *(none)* | Shared Bearer / `X-Api-Key` secret for Brain, MCP, and agent REST routes |
| `OVERCLAW_ADMIN_USER` / `OVERCLAW_ADMIN_PASS` | *(none)* | If both are set and no user exists yet, seed a browser admin account |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Optional OpenClaw gateway WebSocket |
| `OPENCLAW_API_TOKEN` | *(none)* | Optional OpenClaw gateway token |

---

## Vault layout

`starter-brain/` is the recommended folder schema for import and for heartbeat files OverClaw still reads from disk:

```
VAULT_PATH/
├── 00 - Home/
├── 01 - Prompts/
├── 02 - Projects/
├── 03 - Agents/                   # Agent Registry, notifications, Task Board, task files
├── 04 - Models-and-Tools/
├── 05 - Research/
├── 06 - Loops/
├── 07 - Weekly-Reviews/
├── 08 - QA-and-Monitoring/        # ATLAS + Heartbeats (still scanned from disk)
├── _Templates/
└── _Archive/
```

On-disk reads used by the dashboard: `03 - Agents/Agent Registry.md`, `03 - Agents/Notifications/`, `03 - Agents/Coordination/Task Board.md`, `08 - QA-and-Monitoring/ATLAS/atlas.json`, and `08 - QA-and-Monitoring/Heartbeats/`.

Heartbeat filenames:

```
YYYY-MM-DD-HH-MM-event-type.md
NEEDS-ATTENTION-YYYY-MM-DD-HH-MM-*.md
HANDLED-YYYY-MM-DD-HH-MM-*.md
```

---

## Architecture

1. **BrainStore** (`lib/BrainStore.js`) - SQLite document DB. Source of truth for Brain API reads and writes.
2. **HTTP API and UI** (`index.js`, `views/`, `public/`) - Express + EJS. Brain REST, MCP, agent REST, and the dashboard.
3. **VaultReader** (`lib/VaultReader.js`) - read-only scan of heartbeat and coordination files still on disk.
4. **OpenClaw bridge** (`lib/ClawBridge.js`) - optional WebSocket client for one supported agent runtime.

`data/` is gitignored and should never contain secrets or a live `brain.db` in git.

---

## License

MIT. See [LICENSE](./LICENSE).
