---
name: live
description: "Drive a manual-step (awaiting-human) task: list parked tasks or attach to one and work through the step-done loop. Use when the user says 'live', 'take over', 'work on a task', 'pick up', or invokes `/mars:live [id]`."
---

# Mars: live — manual-step driver

You drive the human side of a Mars manual-step task.  Two modes:

- **No argument** — list `awaiting-human` action-queue rows and let the user pick one.
- **With `<id>`** — attach to the task, restate the Handoff and current Step guide, then guide the loop until the step is complete.

---

## Mode A — No argument (pick a task)

Run:

```bash
mars action-queue list --lean 2>&1
```

Filter the output for rows whose `kind` column reads `awaiting-human` (the lean format prints `awaiting-human:N` in the summary line and one `<id>  <title>` line per row).

If none found, tell the user in one line: "No tasks are currently awaiting human input." and stop.

If one or more are found, present them as a numbered list and ask the user which one to work on via `AskUserQuestion`.  Once they pick one, proceed to **Mode B** with that id.

---

## Mode B — Attach and drive the loop

### Step 1 — Attach

```bash
mars attach $ARGUMENTS 2>&1
```

Print the full output verbatim so the user sees the Handoff: task title, worktree path, branch, done-criteria checklist, commits ahead, completion report (if any), and journal tail.

Also run:

```bash
mars action-queue list --lean 2>&1
```

Look for the `awaiting-human` row whose `entity` matches `$ARGUMENTS` to surface the **Step guide** (`leaseNote`).  If found, print:

```
━━━ Step guide ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<leaseNote>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If no leaseNote is present, skip the block.

### Step 2 — Orient

State in one sentence what this step is asking the operator to do, derived from:
1. The Step guide (leaseNote) if present.
2. The done-criteria checklist (unchecked items) as a fallback.
3. The task prompt / completion report as a last resort.

### Step 3 — Drive the loop

Work inside the worktree (`data.worktreePath` from the attach output).  Follow these rules throughout:

**Journal at milestones** — after each meaningful action, run:
```bash
mars task note $ARGUMENTS "<what you just did>"
```

**Check off criteria as you complete them** — use the 1-based index from the checklist:
```bash
mars task check $ARGUMENTS <n>
```

**Commit as you go** — never accumulate more than one logical unit before committing:
```bash
git add -A && git commit -m "<message>"
```

**Do NOT leave uncommitted work** — both `mars step done` and `mars release --abort` refuse dirty worktrees.

### Step 4 — Advance when the step is done

When all work for this step is complete and the worktree is clean:

```bash
mars step done $ARGUMENTS
```

Print the CLI output verbatim.  If the pipeline parks at another manual step the lease automatically comes back to you (same owner).  If it does, loop back to Step 1 with the new step's context.

### Bail out

If the user decides to abandon this step entirely:

```bash
mars release $ARGUMENTS --abort
```

This routes the task to the failure path.  The worktree is retained for inspection.

---

## What you do NOT do

- Do not `mars release <id>` (no `--abort`) from this skill — that verb releases the whole lease and resumes the pipeline, which is what `mars step done` does in step-aware terms; the release form is only valid for single-step (non-workflow) awaiting-human tasks or for a clean handoff.
- Do not leave uncommitted changes before calling `mars step done` or `mars release --abort`.
- Do not `cd` out of the worktree mid-session.
- Do not create commits on `main` — all work stays on the task branch inside the worktree.

---

# Argument

The user passed: `$ARGUMENTS`
