# 04 - Models and Tools

Notes on the AI models, tools, APIs, and integrations your swarm uses.

## Purpose

Agents and humans forget things. This folder is where you document:
what tools you have, how they behave, what they're good at, what they're bad at,
and any gotchas discovered through use.

Think of it as your team's tool manual, written from experience.

## What belongs here

- Notes on AI models you use (capabilities, quirks, cost tradeoffs)
- API integration notes (endpoints, auth method, rate limits, known issues)
- Tool evaluations (tried X, found it better/worse than Y because...)
- Credentials inventory (names only — never actual keys or passwords)
- Configuration notes for tools your agents depend on

## What doesn't belong here

- Actual API keys, passwords, or tokens (those go in a secrets manager)
- Installation instructions that belong in a project README

## Suggested structure

```
04 - Models-and-Tools/
├── models/
│   ├── gpt-4o-notes.md
│   └── claude-sonnet-notes.md
├── tools/
│   ├── web-search.md
│   └── browser-automation.md
└── apis/
    └── example-api.md
```
