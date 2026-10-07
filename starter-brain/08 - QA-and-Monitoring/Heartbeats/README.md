# Heartbeats

This folder contains periodic heartbeat logs from each machine in your swarm.

## Structure

Create one subfolder per machine. Agents write a new `.md` file each heartbeat.

```
Heartbeats/
├── my-desktop/
│   ├── 2026-01-01-09-00-ok.md
│   └── 2026-01-01-12-00-ok.md
└── my-server/
    ├── 2026-01-01-09-00-ok.md
    └── NEEDS-ATTENTION-2026-01-01-11-30-disk-full.md
```

## Filename conventions

OverClaw parses filenames to extract dates and alert status:

- `YYYY-MM-DD-HH-MM-<event-type>.md` — normal heartbeat
- `NEEDS-ATTENTION-YYYY-MM-DD-HH-MM-<note>.md` — alert (shown in red in OverClaw)
- `HANDLED-YYYY-MM-DD-HH-MM-<note>.md` — resolved alert

## What to put in a heartbeat file

Keep it brief. Status, what was checked, anything worth flagging.

```markdown
## Heartbeat — 2026-01-01 09:00

- Status: OK
- Checked: email, calendar, task board
- Task board: 3 in progress, 0 blocked
- Notes: nothing urgent
```
