# 03 - Agents / Coordination / Tasks / Requests

Pre-approval task request drafts (DRAFTs).

## Purpose

Before a task is formally minted onto the Task Board, it starts here as
a DRAFT. This is useful when:

- A task needs human approval before an agent starts work
- An agent wants to propose work but not act unilaterally
- You want a staging area for tasks that aren't quite ready

## Lifecycle

```
DRAFT created here
      ↓
Human reviews → approves or rejects
      ↓
If approved → task minted: file created in Tasks/, row added to Task Board
DRAFT stamped with the task ID
```

## File naming

```
DRAFT-YYYY-MM-DD-short-description.md
```

## DRAFT file format

```markdown
# DRAFT — Short Description

- **Created:** YYYY-MM-DD
- **Proposed by:** Agent-Name
- **Approval status:** pending | pre-approved
- **Minted task ID:** — (filled in after approval)

## What this is

Plain description of the proposed work.

## Why now

Why is this worth doing? What happens if we don't?

## Estimated scope

Small / Medium / Large. What's involved.
```

## SLA

DRAFTs should be reviewed within 24 hours. If a DRAFT sits longer
than a day without a decision, flag it to the human.
