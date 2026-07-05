# Live Execution

Live execution lets a human do the code step of a task — inside a managed worktree, with the same verify-and-merge pipeline that agents run.

---

## Entry paths

### 1. `mars task add --live`

Enqueue a task that parks for you before the code step:

```
mars task add "add retry logic to the sync worker" --live
```

The orchestrator runs setup (worktree on `task/<id>` off `main`) then parks the task in `awaiting-human`. An action-queue row appears immediately. Attach and start working:

```
mars attach <id>          # takes the lease; surfaces the Handoff
```

The **Handoff** is the context bundle Mars assembles at attach time: the prior Worker's Completion report (if any), commits ahead of the integration branch, done-criteria state, and the Progress-journal tail.

### 2. Taking over an `awaitHuman`-parked task

Any task whose workflow parks at a manual step lands in `awaiting-human` and appears in the action queue. If the action-queue row shows "Take the lease with `mars attach <id>`", do exactly that:

```
mars attach <id>          # takes the lease and prints the Handoff
```

You now own the worktree. The pipeline is suspended until you release.

---

## Runbook discipline

Work in the worktree normally — edit, run, test. Use these commands to keep the record current:

| Command | Purpose |
|---|---|
| `mars task note <id> "<text>"` | Append a progress note (surfaced in Handoff and UI). |
| `mars task check <id> <n>` | Tick a done criterion (1-based). `--uncheck` to reverse. |
| `git commit` | Commit as you go — **required** before any exit gate. |
| `mars step done <id>` | Complete the current manual step; pipeline resumes. Lease follows you to the next manual step automatically. |
| `mars release --abort <id>` | Bail out. Task routes to the failure path; worktree is retained for inspection. |

Commit frequently. The verify step's `has-diff` and `commits-ahead` checks treat uncommitted work as invisible — the same rule that binds agents binds you.

---

## Exit gates

Both `mars release` and `mars step done` refuse to proceed if the worktree is dirty:

```
error: worktree .mars/worktrees/<id> has uncommitted changes
hint: commit or stash your changes before releasing the lease
```

This is a hard gate, not a warning. Commit or stash first, then re-run.

Once released cleanly, the pipeline continues from verify — exactly as it would for an agent run. Mars checks `commits-ahead`, runs the verify command, and merges the branch into `main`. No special human path; the same gate, the same merge.
