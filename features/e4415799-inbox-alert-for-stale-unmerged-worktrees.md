---
id: e4415799-inbox-alert-for-stale-unmerged-worktrees
status: draft
origin: user
---

# inbox alert for stale unmerged worktrees

## Story

As a developer using `mars`, I want a background sweeper that hourly removes
worktrees whose `task/<id>` branch is already merged into `integration` and
flags the unmerged ones in my inbox, so that stale worktrees do not pile up
silently and unmerged work surfaces on its own.

The sweeper runs as a **separate background daemon** with its own PID file
(distinct from the existing watcher daemon). It is started at the end of
`mars init`, and at the end of every `implement` workflow run the orchestrator
checks the recorded PID is alive and respawns it if not. Detection of
"merged" is pure git (`git merge-base --is-ancestor`); no LLM, no DB lookup,
fully scripted.

**Acceptance**

- A new `mars sweeper` daemon is spawned in the background at the end of
  `mars init` and its PID is persisted in the project state.
- At the end of every `implement` workflow run, if the recorded PID is not
  alive (`kill -0` / `process.kill(pid, 0)`), the sweeper is respawned.
- Once an hour the sweeper iterates every directory under `.worktrees/` and
  for each task branch `task/<id>`:
  - If `git merge-base --is-ancestor task/<id> integration` succeeds, the
    worktree is removed (`git worktree remove`) and the branch is pruned.
  - Otherwise an inbox entry is written with **one entry per unmerged
    worktree** — subsequent sweeps update/refresh the existing entry rather
    than appending a duplicate.
- Killing the daemon, then running any `implement` task, results in the
  daemon being respawned by the workflow's tail check.

## Technical

**New separate sweeper daemon**

- New module `orchestrator/src/mastra/sweeper/` mirroring the layout of the
  existing `orchestrator/src/mastra/daemon/`:
  - `paths.ts` — exports `sweeperPaths()` returning
    `{ pidFile: '.mars/sweeper.pid', logFile: '.mars/sweeper.log' }`. Reuses
    `resolveLaunchCommand()` from `daemon/paths.ts` for child-spawn.
  - `server.ts` — `startSweeper()` writes the PID file, sets a `setInterval`
    of 1h, and on each tick runs the sweep routine. Reuses
    `isProcessAlive(pid)` from `daemon/paths.ts`.
  - `client.ts` — `ensureSweeperRunning()` reads the PID file, calls
    `isProcessAlive`, and `spawn`s a detached child via the launch command
    if not alive. Used by both `init` and the `implement` tail check.

**Sweep routine (pure scripted, no LLM)**

- Resolve worktrees by listing `.worktrees/<task-id>/` (the contract from
  `CLAUDE.md`). For each, derive the branch as `task/<task-id>`.
- "Merged" = `git merge-base --is-ancestor task/<id> integration` exits 0.
  Use `runGit()` from `orchestrator/src/mastra/lib/git.ts`.
- Merged → `git worktree remove <path>` then `git branch -D task/<id>`.
- Unmerged → upsert one inbox entry keyed by `task-id` (one entry per
  worktree). Implementation: read existing inbox, replace entry with same
  `taskId`, otherwise append.

**Inbox path**

- Honor the path referenced in `CLAUDE.md`: `.mars/inbox.jsonl`. Add a small
  helper `upsertInboxEntry({ taskId, ... })` in a new
  `orchestrator/src/mastra/inbox.ts` (no existing module yet) that reads,
  rewrites, and atomically replaces the file.

**Wiring into init and implement**

- `mars init` (entry path TBD in `orchestrator/src/init/`): after the
  existing init steps complete, call `ensureSweeperRunning()`.
- `orchestrator/src/mastra/workflows/implement-workflow.ts`: at the end of
  the workflow (after `merge` step, regardless of outcome), call
  `ensureSweeperRunning()` so a missing daemon is healed by normal task
  flow.

**PID storage**

- PID lives in `.mars/sweeper.pid` (a project-state file under the existing
  `stateDir` resolved by `resolveContext()`), matching the convention used
  by `watch.pid`. No new "project configuration" file is introduced; the
  `.mars/` state dir already serves that role.

**Out of scope (loose end)**

- Re-evaluate whether the existing `daemon/` watcher is still required now
  that dispatch has moved to an event-driven model. Tracked as a follow-up
  task at session end, not blocking this feature.
