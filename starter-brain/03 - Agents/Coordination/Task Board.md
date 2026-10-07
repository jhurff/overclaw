# Task Board

All swarm tasks live here. Agents read this file to know what to work on,
and write to it to update status.

OverClaw reads this file to render the Kanban view.

---

## 📥 Inbox

Tasks that have been created but not yet started.

| Task ID | Title | Agent | Priority | Deadline | Created |
|---|---|---|---|---|---|
| TASK-EXAMPLE-001 | [Example task](Tasks/TASK-EXAMPLE-001.md) | Agent-1 | Medium | | 2026-01-01 |

---

## 🔄 In Progress

Tasks actively being worked on.

| Task ID | Title | Agent | Priority | Deadline | Started |
|---|---|---|---|---|---|

---

## 🔴 Blocked

Tasks that cannot proceed without external input.

| Task ID | Title | Agent | Blocker | Since |
|---|---|---|---|---|

---

## ✅ Done

Completed tasks. Archive periodically to keep this file manageable.

| Task ID | Title | Agent | Completed |
|---|---|---|---|

---

*Last reviewed: —*
