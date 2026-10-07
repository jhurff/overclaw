# Starter AI Brain

A minimal vault template to get started with a multi-agent AI swarm using OverClaw.

## What this is

This is the shared knowledge layer your AI agents read from and write to.
It is the "long-term memory" of your swarm. Agents coordinate through it,
leave notes, update task boards, and log their work here.

This starter kit gives you the minimum folder structure and file formats
OverClaw expects. Fill in the blanks, customize to your setup, and delete
anything that doesn't fit.

---

## Folder structure

```
My-AI-Brain/
├── 03 - Agents/
│   ├── Agent Registry.md          # Who your agents are
│   └── Coordination/
│       ├── README.md              # How your swarm coordinates
│       ├── Task Board.md          # Shared task Kanban
│       └── Tasks/
│           └── Requests/          # DRAFT task requests (pre-mint)
├── 08 - QA-and-Monitoring/
│   ├── ATLAS/
│   │   └── atlas.json             # Blind-spot map
│   └── Heartbeats/
│       └── _example-machine/      # Heartbeat log files per machine
└── README.md                      # This file
```

---

## Getting started

1. Copy this folder to wherever your agents can reach it
2. Initialize it as a git repo: `git init && git remote add origin <your-repo>`
3. Fill in `03 - Agents/Agent Registry.md` with your agents
4. Point OverClaw at it via `VAULT_PATH` in your `.env`
5. Add your agents, watch the dashboard come to life

---

## Sync

All agents should sync via git before reading files they intend to modify,
and push after writing. Concurrent writes without rebasing will cause conflicts.

Recommended pattern:
```bash
git pull --rebase --autostash   # before modifying anything
# ... do work ...
git add -A && git commit -m "..." && git push
```

A `vault-sync` wrapper script that serializes writes with `flock` is a useful
addition once you have multiple agents writing concurrently.
