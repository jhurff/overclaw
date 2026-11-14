# Task types

Task notes live at `03 - Agents/Coordination/Tasks/TASK-*.md` inside `brain.db` (`documents.content`, with frontmatter mirrored into `documents.metadata`).

## Fields

| Field | Allowed values | Notes |
|---|---|---|
| `type` | `project`, `standing` | Default `project` when the field is absent and no standing signal matches. |
| `standing_status` | `scheduled`, `active`, `inactive` | Standing tasks only. |
| `cadence` | `daily`, `weekdays`, `weekly`, `monthly`, or a 5- or 6-field cron string | Optional. |
| `heartbeat_job` | job name | Optional. Matches heartbeat `job` frontmatter or the filename type under `08 - QA-and-Monitoring/Heartbeats/`. |

## Workflow

- **Project** tasks use Inbox, In Progress, Parked, Blocked, and Done.
- **Standing** tasks are operational. They never appear in In Progress, even when `Task Board.md` lists them there or `status` is `inProgress`. The board API places them in `standing.scheduled`, `standing.active`, or `standing.inactive`.
- Standing tasks are excluded from In Progress counts and from stuck-task flags. `stats.standing`, `stats.standingScheduled`, `stats.standingActive`, and `stats.standingInactive` carry the counts.
- Cards show owner (`agent`), `cadence`, and `lastRun` (latest dated progress note, or the latest matching heartbeat).

## Inference

`type` in frontmatter wins (`typeSource: "explicit"`). Otherwise the first matching signal wins:

Tasks whose frontmatter `status` is `done` or `cancelled`, and tasks sitting in the Done column, are not inferred as standing. They stay `project` unless `type` is set explicitly.

1. `cadence`, `schedule`, or `cron` frontmatter → `inferred:cadence`
2. Explicit `heartbeat_job` that matches a heartbeat job name, type, or filename → `inferred:heartbeat`. Heartbeat bodies are not scanned for task ids or agent names.
3. Progress notes on 5 or more distinct days with a regular gap, and a title or frontmatter hint (`daily`, `weekdays`, `weekly`, `monthly`, `report`, `check`, `watch`, `scan`, `sweep`, `monitor`) → `inferred:progress-notes`
4. A title matching `daily` / `weekdays` / `weekly` / `monthly` together with `check`, `watch`, `scan`, `sweep`, `monitor`, or `report` → `inferred:title`

Anything else is `type: "project"` with `typeSource: "default"`.

Standing status: explicit `standing_status` wins. Otherwise `active` when `lastRun` is within about 2× the cadence (48 hours if the cadence is unknown; 72 hours for `weekdays`), else `inactive`. Inferred status is never `scheduled`.

Date-only progress notes are treated as 12:00 UTC that day.

## API and MCP

`GET /api/vault/task-board` and the MCP tools `get_task_board`, `get_my_tasks`, and `get_task` return `type` and `typeSource`. Standing tasks also return `standingStatus`, `cadence`, `heartbeatJob`, and `lastRun`.

Agents set the fields with `draft_task`, `add_task_note`, or `claim_task` (`type`, `standing_status`, `cadence`, `heartbeat_job`). `claim_task` does not move a standing task onto In Progress.

## Migration

Dry-run is the default. `--apply` writes explicit frontmatter through `BrainStore.putDoc`, which snapshots the previous body in `document_versions`.

```bash
node scripts/migrate-task-types.js --db path/to/brain.db
node scripts/migrate-task-types.js --db path/to/brain.db --apply
```

Do not point this at a production database until you have read the dry-run report.

## brain.db assumptions

- Path: `BRAIN_DB_PATH` or `data/brain.db`.
- `documents.path` is vault-relative (`03 - Agents/...`), forward slashes.
- Classification reads frontmatter from `documents.content`. `putDoc` refreshes the `metadata` JSON column.
- A missing document in an open database is missing. The vault directory is not consulted for that path.
- The vault directory is used only when the database cannot be opened (`stats()` throws or BrainStore was not constructed).
- `VaultReader.sync()` does not run `git pull`.
