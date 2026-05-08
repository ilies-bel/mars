---
name: mars-run
description: Pick the next available Mars task (oldest queued, or an explicit id) and dispatch it through `mars run` so the orchestrator implements it in a parallel git worktree. Use when the user says "run the next task", "implement the next mars task", or invokes `/mars:run`.
---

# Mars: dispatch the next available task

Hand the next claimable task off to the Mars orchestrator. The orchestrator
clones a worktree on `task/<id>` off `integration`, runs Claude Code headless
to produce a diff, verifies (typecheck/test/lint), then fast-forwards into
`integration`. This skill does **not** code the task itself — it resolves
which task to run and invokes `mars run`.

## When to invoke

- User asks to "run", "dispatch", or "implement" the next Mars task.
- User invokes `/mars:run` with or without a task id.
- Skip if `mars list queued` is empty — say so and stop.

## Inputs

- Optional positional arg: a Mars task id (e.g. `c4ea0348`).
- If no arg is provided, resolve to the **oldest queued** task:
  ```
  mars list queued
  ```
  Pick the first row. If the list is empty, tell the user and stop.

Never invent a task id. If `mars list queued` is empty and the user passed
no arg, do not fall back to draft/failed tasks — explain and stop.

## Plan

1. Resolve the task id:
   - If the user passed an arg, use it. Verify it exists and is `queued`:
     ```
     mars show <id>
     ```
     If status is not `queued` (e.g. `draft`, `running`, `done`, `failed`),
     refuse and explain — only queued tasks are claimable. For `draft`,
     suggest `/mars-answer-questions` then promotion.
   - Otherwise run `mars list queued`, take the first id (oldest first).

2. Print a one-line preview so the user sees what will run:
   ```
   mars show <id>
   ```
   Surface the title and the functional/technical plan summary. If either
   plan section is empty, warn the user — the orchestrator will dispatch
   anyway, but agents do better with plans.

3. Dispatch via the CLI. `mars run` has no per-task selector; it dispatches
   **all** queued tasks in parallel. That is fine when there is a single
   queued task. When there are multiple queued tasks and the user asked for
   just one:
   - First check `mars list queued | wc -l`. If > 1 and the user expected a
     single task, ask via `AskUserQuestion` whether to:
     a. dispatch all queued tasks (`mars run`), or
     b. run only the resolved id — which today requires no extra step
        because `mars run` is all-or-nothing; if (b), stop and tell the user
        the CLI does not yet support single-task dispatch.

4. Run the dispatch:
   ```
   mars run
   ```
   This is a long-running command (spawns Claude Code per task). Run it in
   the foreground so the user sees progress. Do **not** background it — the
   user invoked the skill specifically to watch this happen.

5. After `mars run` returns, summarize outcomes by re-listing:
   ```
   mars list
   ```
   Report per-task status: `done`, `failed`, `verifying`, `merging`. For any
   `failed` task, suggest `mars show <id>` to inspect the failure.

## Conventions

- **Never bypass the CLI.** Don't poke at `.mars/queue.db` directly; don't
  manually create worktrees. The whole point is to use `mars run`.
- **Don't code the task yourself.** This skill is dispatch-only. The
  orchestrator spawns its own Claude Code instance in a worktree.
- **Foreground only.** `mars run` is the user-visible action; do not run it
  with `run_in_background`.
- **Repo resolution.** The user may have set `MARS_REPO` or be inside the
  target repo. `mars run` resolves the repo itself — do not pass `--repo`
  unless the user explicitly provided one.

## Failure handling

- `mars list queued` empty and no arg → tell the user "no queued tasks" and
  stop. Do not auto-promote drafts or retry failed tasks.
- User-supplied id not found → surface the `mars show` error verbatim.
- User-supplied id has status other than `queued` → refuse with one line
  explaining which status it is in and what command would advance it
  (`/mars-answer-questions` for draft, nothing for running/done/failed).
- `mars run` exits non-zero → run `mars list failed` and report which task
  failed; do not retry automatically.

## Example transcript

> User: `/mars:run`
>
> Skill runs `mars list queued`, picks `c4ea0348`, prints
> `mars show c4ea0348`, runs `mars run`, then `mars list` to confirm
> `c4ea0348 done`.
