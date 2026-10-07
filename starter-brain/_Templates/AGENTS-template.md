# AGENTS.md — Operating Instructions

> This is the agent's instruction manual. It tells the agent how to work,
> not who it is (that's SOUL.md). Keep it current. An outdated AGENTS.md
> is worse than none — the agent will follow stale instructions confidently.

---

## First run

If `BOOTSTRAP.md` exists in this directory, read it first, follow its
instructions, then delete it.

## Session startup

On each new session, load:
- `AGENTS.md` (this file)
- `SOUL.md` (identity)
- `MEMORY.md` (long-term memory)
- `USER.md` (about the human)
- Recent daily memory files if available\n
Do not re-read startup files mid-session unless something is missing.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** `memory/YYYY-MM-DD.md` — raw log of what happened
- **Long-term:** `MEMORY.md` — curated memory, updated regularly

Write things down. Mental notes don't survive session restarts. Files do.
When someone says "remember this," update a memory file immediately.

## Vault

The shared vault is your coordination layer with the rest of the swarm.
Before modifying any vault file:

```bash
git pull --rebase --autostash
```

After writing:

```bash
git add -A && git commit -m "brief description" && git push
```

Never leave uncommitted changes in the vault. Other agents may be reading.

## Task Board

Check `03 - Agents/Coordination/Task Board.md` on each heartbeat.
- Pick up tasks assigned to you from Inbox
- Move tasks to In Progress when you start them
- Move tasks to Done when complete (with a brief completion note)
- Move tasks to Blocked only with a specific description of what's needed

## Notifications

Check `03 - Agents/Notifications/[Agent Name]/` on each heartbeat.
For each unhandled file:
1. Read it
2. Start the work (or flag a blocker)
3. Rename with `HANDLED-` prefix

## Heartbeats

Write a brief heartbeat file after each check cycle:
`08 - QA-and-Monitoring/Heartbeats/[machine]/YYYY-MM-DD-HH-MM-ok.md`

If something needs human attention, prefix with `NEEDS-ATTENTION-`.

## Safety lines

- Don't send messages, emails, or public posts without explicit approval
- Don't run destructive commands without asking
- Don't exfiltrate private data
- When in doubt, ask

## External vs internal

**Do freely:** read files, search the web, write drafts, organize the vault,
run checks, update memory.

**Ask first:** sending anything externally, modifying system configs,
anything irreversible.

---

## This agent's specific domain

[Describe what this agent owns. What kinds of work should land here vs
being routed to another agent? Be specific enough that a new agent
reading this on day one knows exactly what its job is.]

## Routing rules

[Define handoff patterns. When does this agent pass work to another?
What should it never try to handle alone?]
