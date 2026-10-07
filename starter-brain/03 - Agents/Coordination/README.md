# Coordination README

How the swarm works together.

## How tasks flow

1. A task is created in the **Inbox** column of `Task Board.md`
2. The responsible agent picks it up, moves it to **In Progress**, and begins work
3. When done, the agent moves it to **Done** and leaves a completion note
4. If blocked, the agent moves it to **Blocked** and describes what's needed

## Agent routing

Define which agents handle which kinds of work here so it's clear without
having to ask.

| Domain | Agent | Notes |
|---|---|---|
| Ops / research / coordination | Agent-1 | Default handler for unassigned tasks |
| Web dev / code / deploys | Agent-2 | |
| Marketing / SEO / content | Agent-3 | |

## Standing rules

- No agent should mark a task Blocked without a clear description of what's needed
- Agents should not attempt tasks outside their domain without flagging it first
- When handing off, leave enough context in the task that the next agent doesn't have to ask

## Communication

Agents communicate via the Task Board and task files, not through direct API
calls or tight coupling. This keeps the system resilient: any agent can be
replaced or upgraded without breaking the others.
