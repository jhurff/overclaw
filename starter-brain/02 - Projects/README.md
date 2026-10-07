# 02 - Projects

One subfolder per active project.

## Purpose

This folder organizes project-level context so agents working on a project
have everything they need in one place. No hunting across the vault.

Each project gets its own subfolder. Inside that subfolder lives the brief,
status notes, research, decisions, and any deliverables or outputs.

## What belongs here

- One subfolder per project, named clearly: `project-name/`
- Each project subfolder should have at minimum:
  - `README.md` — what the project is, what done looks like, current status
  - `BRIEF.md` — the original ask, goals, constraints, timeline
  - `LOG.md` — running notes as work progresses

## Naming convention

Use lowercase with hyphens. Be specific enough that you know what it is
six months from now:

```
website-redesign/
onboarding-automation/
competitor-research-2026/
```

## Lifecycle

- **Active** projects live here
- **Completed** projects move to `_Archive/`
- If a project spawns tasks, link them to the Task Board in `03 - Agents/`

## Example structure

```
02 - Projects/
└── example-project/
    ├── README.md      # what it is + current status
    ├── BRIEF.md       # original ask + goals
    └── LOG.md         # running notes
```
