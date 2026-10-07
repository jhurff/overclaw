# 06 - Loops

Recurring processes, scheduled workflows, and automation patterns.

## Purpose

Some work isn't a one-time task. It's a loop: something that runs
on a schedule, repeats on a trigger, or recurs every week.

This folder documents those loops so agents know how they work,
what they produce, and what to do when something goes wrong.

A loop documented here is a loop that survives agent turnover.
A loop that lives only in someone's head (or chat history) eventually breaks.

## What belongs here

- Recurring agent workflows (daily checks, weekly summaries, monitoring jobs)
- Automation patterns you've built and want to preserve
- Cron job documentation (what runs, how often, what it does)
- Heartbeat check specs (what does the agent check each heartbeat?)
- Runbooks for processes that repeat

## Example loops worth documenting

- Morning brief: what an agent checks at the start of each day
- Weekly review: what gets summarized and where it goes
- Health monitoring: what does the swarm watch, and at what thresholds?
- Inbox triage: how does incoming work get sorted and routed?

## Loop file format

Each loop should have its own file:

```markdown
# Loop: [Loop Name]

- **Frequency:** daily / weekly / on trigger
- **Owner:** which agent runs this
- **Last updated:** YYYY-MM-DD

## What it does
## Inputs
## Outputs
## What can go wrong / how to recover
```
