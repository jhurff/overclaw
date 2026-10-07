# Agent Identity — Why It Matters

The files that define who an agent is are just as important as the files
that tell it what to do. This document explains each one and why you
should fill them in before an agent's first session.

---

## The four identity files

Every agent in the swarm should have these four files in its workspace:

### AGENTS.md — Operating Instructions

The "how to work" file. This tells the agent:
- How to start a session
- How to use the vault and Task Board
- What it can do on its own vs what needs approval
- What its specific domain is and how to route work

Think of it as the employee handbook. It should be specific, practical,
and kept current. An outdated AGENTS.md is dangerous — the agent will
follow stale instructions with full confidence.

### SOUL.md — Identity and Personality

The "who you are" file. This defines:
- How the agent communicates (tone, style, level of directness)
- What it values and what it optimizes for
- How it handles uncertainty, mistakes, and pushback
- Its hard limits and default behaviors

This is the file most people skip, and it's the one that matters most
for consistency. Without it, every session produces a slightly different
agent. With it, the agent behaves recognizably the same way over time —
even across different underlying models.

### MEMORY.md — Long-Term Memory

The agent's curated memory. Updated by the agent itself after each session.
Contains:
- Context about the human and the work
- Lessons learned from past tasks
- Current project state
- Open threads from previous sessions

This is what allows the agent to pick up where it left off without being
re-briefed from scratch every time. The agent owns this file. Let it.

### USER.md — About the Human

A profile of the person the agent works for: communication style,
priorities, key people, preferences, things that have caused friction.

The agent fills this in over time as it learns. You can also edit it
directly to accelerate the ramp-up. The more honest and specific it
gets, the more useful the agent becomes.

---

## The compounding effect

These four files are why the system improves over time instead of
staying flat.

A new agent with empty identity files starts from zero on every session.
It has no personality, no memory, no understanding of what the human
values. It's capable but generic.

An agent with well-developed identity files starts each session already
knowing:
- Who it is and how it should behave
- What the human cares about and what drives them crazy
- What's been tried before and what worked
- Where the work currently stands

That gap grows wider the longer the system runs. An agent that's been
running for six months, updating its own MEMORY.md, refining its SOUL.md
when behavior needs adjusting, and learning the human through USER.md is
a fundamentally different tool than a fresh one.

This is the recursive improvement loop in practice.

---

## Keeping identity files current

- **SOUL.md** — review when you notice the agent behaving differently
  than you want. Edit it and tell the agent you changed it.
- **AGENTS.md** — update when workflows change. Don't let it drift from
  reality.
- **MEMORY.md** — the agent manages this. Periodically review it to
  make sure it still reflects what's true.
- **USER.md** — update directly when your priorities or preferences change.
  Don't wait for the agent to figure it out.
