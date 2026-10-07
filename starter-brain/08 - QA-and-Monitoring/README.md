# 08 - QA and Monitoring

Health monitoring, blind-spot tracking, and heartbeat logs for your swarm.

## Purpose

Running an AI swarm without monitoring is running blind. This folder
is where the swarm's self-awareness lives.

It has two parts:

1. **Heartbeats** — periodic logs from each machine showing the agent
   is alive and reporting status
2. **ATLAS** — a live map of known blind spots: areas where agents have
   historically failed or need to be extra careful

## Subfolders

```
08 - QA-and-Monitoring/
├── ATLAS/
│   └── atlas.json          # Blind-spot map, read by agents before risky operations
└── Heartbeats/
    └── <machine-name>/     # One subfolder per machine
        └── YYYY-MM-DD-HH-MM-event-type.md
```

## How agents use this folder

- **Before risky work:** check `ATLAS/atlas.json` for relevant blind spots
- **After each heartbeat cycle:** write a new log file in `Heartbeats/<machine>/`
- **When something goes wrong:** add or update a region in `atlas.json`
  so future agents know about it

## Alert file naming

OverClaw surfaces these visually:

- Normal: `YYYY-MM-DD-HH-MM-ok.md`
- Alert needed: `NEEDS-ATTENTION-YYYY-MM-DD-HH-MM-<note>.md`
- Resolved: `HANDLED-YYYY-MM-DD-HH-MM-<note>.md`
