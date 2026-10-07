# Agent Registry

This file is your swarm's roster. OverClaw reads it to populate the agent list.

## Format

Each agent is a row in the table below. Update status badges as agents come
online or go offline.

| Agent | Status | Machine | Role | Runtime | Notes |
|---|---|---|---|---|---|
| Agent-1 | 🟢 Active | my-machine | Chief of Staff / ops | OpenClaw | Main coordinator |
| Agent-2 | 🟡 Idle | my-machine | Web dev / code | Cursor / Codex | |
| Agent-3 | 🔴 Offline | other-machine | Marketing / SEO | Claude.ai | |

## Status badges

- 🟢 Active — running, healthy
- 🟡 Idle — configured but not recently active
- 🔴 Offline — not running or unreachable
- ⚠️ Error — running but in a degraded state

## Adding a new agent

1. Add a row to the table above
2. Create a notifications folder: `03 - Agents/Notifications/<AgentName>/`
3. Register any routing rules in `Coordination/README.md`
