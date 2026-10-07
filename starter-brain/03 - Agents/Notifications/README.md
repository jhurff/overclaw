# 03 - Agents / Notifications

Inbox folder for agent task assignment notifications.

## Purpose

When a task is assigned to an agent, a notification file is dropped here
so the agent knows to pick it up. This keeps assignment lightweight: no
direct API calls between agents, just a file drop the agent checks on
each heartbeat.

## Structure

One subfolder per agent. Each subfolder is that agent's inbox.

```
Notifications/
├── Agent-1/
│   ├── 2026-01-01-10-00-task-assigned.md
│   └── HANDLED-2026-01-01-09-00-task-assigned.md
└── Agent-2/
    └── (empty — no pending notifications)
```

## Notification lifecycle

1. A task is assigned → notification file created in the agent's subfolder
2. Agent reads the file on next heartbeat → begins work
3. Agent renames the file with `HANDLED-` prefix to mark it done

```bash
# Mark a notification handled
mv Notifications/Agent-1/2026-01-01-10-00-task-assigned.md \
   Notifications/Agent-1/HANDLED-2026-01-01-10-00-task-assigned.md
```

## Notification file format

```markdown
# Task Assignment — TASK-XXXX

- Task ID: TASK-XXXX
- Title: Do the thing
- Assigned by: Agent-1 (or Human)
- Assigned at: 2026-01-01 10:00

## Context

Brief note explaining why this agent was chosen for the task
and any handoff context needed.
```
