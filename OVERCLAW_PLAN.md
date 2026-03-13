# OverClaw Plan

A phased plan for OverClaw, grounded in **OVERCLAW_INCEPTION.md** and the current codebase.

---

## Vision (from Inception + README)

- **OverClaw** = real-time oversight webapp for OpenClaw: read-only view of agents, configs, sessions, projects, reports, and **learnings**.
- **OKAT (OverClaw Knowledge & Audit Taxonomy)** = structured knowledge base that:
  - Maps session history events to distilled, categorized “understandings” (OCUs).
  - Updates as the agent learns from chats (proactive + reactive).
  - Supports deep links from learnings back to session/message context.
  - Enables search, filter, and a dedicated dashboard (/activity, /knowledge, or /audit).

**Current MVP (shipped):** Activity & Audit Log at `/activity` showing learnings from `learnings_db.json`, with tags and a single “source” link per learning. No taxonomy, no agent write path, no real session deep links in UI.

---

## Current State Snapshot

| Area | Status | Notes |
|------|--------|--------|
| **Dashboard** | ✅ | index.ejs with Agent Status, placeholders for Projects, Reports, System Health, Sessions |
| **Agents** | ✅ | /agents, /api/agents, ClawBridge |
| **Config** | ✅ | /config, file browser, git history, model settings |
| **Sessions** | ✅ | /sessions, /api/sessions-detail |
| **Cron Jobs** | ✅ | /cron-jobs, /api/cron-jobs |
| **Skills / Nodes** | ✅ | /skills, /nodes |
| **Logs / Debug / Docs** | ✅ | Routes and views exist |
| **Learnings (OCUs)** | 🟡 MVP | /activity, /api/learnings, reads `data/learnings_db.json` (project-local) |
| **Taxonomy / hierarchy** | ❌ | Flat list only; no categories, related_ocu_ids, or multi-source |
| **Session deep links** | ❌ | derived_from stored but UI link is generic (postMessage navigate); no message_id deep link |
| **Agent write path** | ❌ | No knowledge_add / knowledge_update tool; learnings are manual or external |
| **Project dashboard** | ❌ | Placeholder card only |
| **Report registry** | ❌ | Placeholder card only; DELIVERABLES.md / usage reports not wired |
| **Config validation** | 🟡 | Implicit via config viewer; no explicit “validation” report |

---

## Phased Plan

### Phase 1: Stabilize & Complete OCUs MVP (1–2 days)

**Goal:** Reliable Activity & Audit Log and a clear data contract.

1. **Template / nav**
   - Ensure `/activity` renders everywhere: either add `views/partials/sidebar.ejs` used by activity.ejs or make activity use the same inline sidebar structure as index.ejs so the “Learnings” nav is consistent.

2. **Learnings API**
   - Keep `/api/learnings` reading from `learnings_db.json`.
   - Document the schema (id, title, summary, tags, derived_from, created_at) in the repo (e.g. `docs/learnings-schema.md` or in README).
   - Optional: add query params for `tag` and `category` (if you add category to the schema now) for future filter UI.

3. **Activity UI**
   - Show “No learnings yet” when array is empty; keep chronological order (newest first).
   - Fix or remove the “Source” link until session deep linking exists (e.g. show “Session: main” + timestamp only, or a clear “Deep link coming soon” state).

4. **Docs**
   - Add a short “Activity & Audit Log” section to README describing the feature and that learnings live in `data/learnings_db.json` (project-local).

**Exit criteria:** Visit `/activity` on any deployment and see learnings (or empty state) without errors; README and schema are clear.

---

### Phase 2: Taxonomy & Session Integration (3–5 days)

**Goal:** Align with OKAT design: richer model, multiple sources, and real links to session history.

1. **Data model (learnings / OCUs)**
   - Add optional fields to each learning: `category`, `related_ocu_ids[]`, `source_session_ids[]` (or multiple `derived_from` entries).
   - Keep backward compatibility: existing entries without these fields still render.

2. **Session history access**
   - Rely on OpenClaw session history (e.g. `sessions_history` with `visibility: all`) and/or gateway APIs if available.
   - Define a stable “session + message” identifier format (e.g. `sessionKey + messageId` or timestamp) so the UI can link “View in session” to the right place (e.g. Cursor/Discord/OpenClaw UI).

3. **OverClaw APIs**
   - Optional: `GET /api/session-message?session=...&message=...` (or similar) that returns a minimal payload (e.g. timestamp, snippet) for building deep links, if the gateway exposes it.
   - Extend `GET /api/learnings` to support filter by `tag`, `category`, and optionally by `session_key`.

4. **Activity / Knowledge UI**
   - Add search (client-side or server-side) by title/summary/tags.
   - Add filter by tag and by category.
   - OCU detail view (optional): click a learning to see full summary, all related OCUs, and all linked session events with “View in session” links using the new identifier format.
   - Use the new `derived_from[]` or `source_session_ids` to show multiple “Source” links per learning.

**Exit criteria:** Learnings have categories and optional related IDs; at least one working “View in session” link format; Activity page has search/filter and optional detail view.

---

### Phase 3: Agent-Driven Learning (2–3 days)

**Goal:** Agent can create and update learnings from within a session.

1. **OpenClaw tool**
   - Implement `knowledge_add` and `knowledge_update` (or a single `learning_record` with mode) in the OpenClaw tool set that:
     - Append to (or update) OverClaw's `data/learnings_db.json` (or an API that OverClaw exposes),
     - Accept: title, summary, tags, category (optional), related_ocu_ids (optional), derived_from (session_key, message_id, timestamp, link_text).
   - Ensure safe concurrent writes (e.g. read-modify-write with locking or atomic write).

2. **OverClaw**
   - No change required if the tool only touches `learnings_db.json`; `/api/learnings` already serves it.
   - Optional: `POST /api/learnings` from OverClaw (e.g. “Add learning” form) for human curation; same schema as agent tool.

3. **Guidance**
   - Update agent instructions (e.g. MEMORY.md or SOUL.md) so the agent knows when to call `knowledge_add` / `knowledge_update` (e.g. after resolving a bug, changing config, or adopting a user preference).

**Exit criteria:** Agent can add/update learnings from a chat; new entries appear on `/activity`; no corruption under concurrent use.

---

### Phase 4: Dashboard Completeness (2–4 days)

**Goal:** Replace placeholder cards with real data and light validation.

1. **Recent Project Updates**
   - Consume `projects_log.md` or an existing OpenClaw “projects” API if available.
   - Parse or fetch and show last N entries / summary on the dashboard card; link to a dedicated “Projects” view or to Config (projects_log) if appropriate.

2. **Latest Reports**
   - List recent OpenClaw usage reports (e.g. `openclaw_usage_report_*.md`) and/or DELIVERABLES.md-derived list from OpenClaw's memory paths (read-only).
   - Dashboard card: “Last 5 reports” with names and dates; link to a “Reports” view or to Config file viewer for that report.

3. **System Health**
   - Simple health: gateway ping (`/status` or equivalent), process list, or uptime if exposed.
   - Display “Gateway: OK” / “Agent: OK” and optional basic metrics (no heavy instrumentation in MVP).

4. **Config Validation**
   - Add a “Validate” action or a small validation report: run openclaw config validation (if `openclaw config validate` or similar exists) and show result on Config or Debug page; or list common issues (missing SOUL.md, invalid JSON, etc.) from existing data.

**Exit criteria:** Dashboard cards show real project snippets, report list, and health; validation is visible somewhere.

---

### Phase 5: Polish & Scale (ongoing)

- **Performance:** If learnings_db.json grows large, add pagination or lazy loading on `/activity`; consider indexing by tag/category for filter.
- **Taxonomy browser:** Dedicated `/knowledge` or `/audit` view that shows OCUs as a tree or graph (by category and related_ocu_ids).
- **Export:** Export learnings as Markdown or JSON for backup or sharing.
- **Notifications (optional):** Alert when a new learning is added or when validation fails (e.g. email or in-dashboard badge).

---

## Suggested Next Steps (Immediate)

1. **Verify activity route:** Run the app, open `/activity`, confirm it renders (and fix `partials/sidebar` if missing).
2. **Document learnings schema** in the repo (one source of truth for agent and OverClaw).
3. **Pick one of:** (A) Add `views/partials/sidebar.ejs` and reuse it from activity + other pages, or (B) Refactor activity.ejs to use the same inline sidebar as index.ejs.
4. **Prioritize Phase 2 vs Phase 3:** If you want the agent to start recording learnings soon, Phase 3 (agent tools) can be done right after Phase 1, with Phase 2 (taxonomy + deep links) following.

---

## Backlog (Optional)

- **llms.txt / GEO:** If OverClaw ever gets a public docs or status page, consider llms.txt and GEO-style visibility (see GEO skills); not required for internal dashboard.
- **Auth:** If OverClaw is ever exposed beyond localhost, add auth and secure token handling.
- **Tests:** Add a few integration tests for `/api/learnings` and critical routes.

---

## Summary Table

| Phase | Focus | Outcome |
|-------|--------|--------|
| 1 | Stabilize OCUs MVP | Reliable /activity, schema docs, nav fix |
| 2 | Taxonomy & sessions | Categories, related OCUs, search/filter, session deep links |
| 3 | Agent learning | knowledge_add / knowledge_update tools; learnings from chat |
| 4 | Dashboard completeness | Real projects, reports, health, validation |
| 5 | Polish | Taxonomy browser, export, performance, optional alerts |

This plan keeps the inception vision (OKAT, session-linked learnings, agent-driven updates) and ties it to concrete steps and the existing OverClaw codebase.
