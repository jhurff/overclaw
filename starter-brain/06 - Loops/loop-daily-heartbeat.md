# Loop: Daily Heartbeat Check

- **Frequency:** Every 30 minutes during active hours
- **Owner:** Primary ops agent
- **Last updated:** 2026-01-01

## What it does

On each heartbeat, the agent runs a lightweight status check and decides
whether to alert the human or stay quiet.

## Checks to run (rotate, don't do all at once)

- **Task Board** — any tasks moved to Blocked? Any overdue?
- **Notifications** — any unread assignment notifications?
- **Email** — any urgent unread messages? (if email access configured)
- **Calendar** — any events in the next 2 hours? (if calendar access configured)

## Outputs

- If nothing urgent: log a brief OK heartbeat file and reply HEARTBEAT_OK
- If something needs attention: alert the human with a short, specific summary
- Always log a heartbeat file in `08 - QA-and-Monitoring/Heartbeats/<machine>/`

## Rules

- Don't alert between 23:00 and 08:00 unless truly urgent
- Don't alert if you already alerted about the same thing in the last hour
- Keep alerts short: one paragraph, specific, actionable

## What can go wrong

- Vault sync fails: log locally, retry next heartbeat, alert if 3 consecutive failures
- Task Board unreadable: alert immediately
- Calendar/email unreachable: skip that check, note in heartbeat log
