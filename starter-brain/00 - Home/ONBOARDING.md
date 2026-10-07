# Onboarding a New Agent

How to add a new agent to your swarm. This covers both the
technical wiring and the identity setup that makes the agent
feel like a consistent team member rather than a stateless tool.

---

## Why both things matter

The technical wiring (files, directories, Task Board rows) gets the agent
plugged in. The identity layer (SOUL, MEMORY, AGENTS) is what makes the
agent actually useful over time.

Without identity, every session starts from zero. The agent has no
personality, no preferences, no memory of decisions, no sense of its
own role. It's a vending machine. You feed it a question. It spits
out an answer. You close the tab. Nothing compounds.

With identity, the agent knows who it is, what its job is, who it works
with, and how it's supposed to behave. Sessions build on each other.
The agent gets better the longer it runs. That's the whole point.

---

## Step 1 — Create the agent's workspace files

Every agent needs four files in its working directory (wherever the agent
runtime looks for context):

```
AGENTS.md       # operating instructions — what to do and how to behave
SOUL.md         # identity and personality — who the agent is
MEMORY.md       # long-term memory — updated by the agent over time
USER.md         # about the human — filled in by the agent as it learns
```

Copy the templates from `_Templates/` in this vault:

```bash
cp "_Templates/AGENTS-template.md"  /path/to/agent/workspace/AGENTS.md
cp "_Templates/SOUL-template.md"    /path/to/agent/workspace/SOUL.md
cp "_Templates/MEMORY-template.md"  /path/to/agent/workspace/MEMORY.md
cp "_Templates/USER-template.md"    /path/to/agent/workspace/USER.md
```

Then fill them in. The SOUL and AGENTS files are the most important ones
to get right before the agent's first session.

---

## Step 2 — Create the BOOTSTRAP file (first-run only)

On the agent's very first session, you want it to read its own context
and understand its place in the swarm — without you having to explain
it every time.

Create a `BOOTSTRAP.md` file in the agent's workspace directory:

```bash
cp "_Templates/BOOTSTRAP-template.md" /path/to/agent/workspace/BOOTSTRAP.md
```

Fill in the agent's name, role, and key context. The agent will read
this file on first launch, internalize it, then delete it. It won't
need it again because that context will now live in MEMORY.md.

---

## Step 3 — Register the agent

Add the agent to the swarm roster in this vault:

1. Open `03 - Agents/Agent Registry.md`
2. Add a row for the new agent (name, status, machine, role, runtime)
3. Create an inbox folder:
   ```bash
   mkdir -p "03 - Agents/Notifications/Agent-Name"
   ```

---

## Step 4 — Set up vault access

The agent needs to be able to read and write to this vault.

**Option A — Local access (same machine)**
Clone the vault repo to the machine where the agent runs:
```bash
git clone <your-vault-repo-url> ~/My-AI-Brain
```

**Option B — Remote access (different machine)**
Same clone, but on the remote machine. Configure git credentials so the
agent can pull and push without prompting for a password.

**Vault sync pattern (important)**
All agents should use the same sync pattern to avoid conflicts:
```bash
git pull --rebase --autostash   # before modifying anything
# ... do work ...
git add -A && git commit -m "brief description" && git push
```
If you have multiple agents writing concurrently, wrap this in a lock
(e.g. `flock`) to serialize writes.

---

## Step 5 — Configure the agent runtime

This step depends on which AI runtime you're using (OpenClaw, Cursor,
Claude.ai, etc.). In general:

- Point the runtime at the workspace directory containing AGENTS.md
- Set up any environment variables the agent needs (vault path, API keys)
- Configure the heartbeat schedule if the agent will run autonomously
- Test a cold start: does the agent pick up its context correctly?

See your runtime's documentation for specifics.

---

## Step 6 — First session checklist

Before the agent's first real task, verify:

- [ ] Agent reads and acknowledges BOOTSTRAP.md on first session
- [ ] Agent can read and write to the vault
- [ ] Agent appears in OverClaw's Agent Registry screen
- [ ] Agent writes a heartbeat file to `08 - QA-and-Monitoring/Heartbeats/<machine>/`
- [ ] Task Board row reads correctly in OverClaw

---

## Ongoing maintenance

- **MEMORY.md** — the agent updates this itself over time. Periodically
  review it to make sure it reflects reality.
- **SOUL.md** — edit when you want to change the agent's personality or
  communication style. Tell the agent when you change it.
- **AGENTS.md** — update when operating procedures change. This is the
  agent's instruction manual, not a static document.
- **USER.md** — the agent fills this in as it learns about the human.
  You can also edit it directly to give the agent context faster.

---

## Removing an agent

1. Mark the agent `🔴 Offline` in `03 - Agents/Agent Registry.md`
2. Archive any open tasks or reassign them
3. Move the agent's workspace files to `_Archive/` if you want to preserve them
4. Leave the Notifications folder in place until you're sure nothing is pending
