---
name: reflect
description: Run `mars reflect` to synthesize draft proposals (source='reflection') from recent completed Mars tasks, then surface them via `mars proposal list --source reflection`. Use when the user says "reflect on past sessions", "reflect on recent tasks", "what should we do next based on history", or invokes `/mars:reflect`.
---

# Mars: reflect on recent completed tasks

Synthesize reflection-source proposals from completed Mars tasks. `mars reflect`
reads token + scorer signals from `.mars/mars.db`,
defaults to the last 10 completed tasks, and inserts draft proposals into the
`proposals` table with `source='reflection'`. Proposals are **never auto-run** —
they are for the user to triage.

This skill does **not** invent suggestions itself. It runs the CLI, then
shows the resulting proposals so the user can act on them.

## When to invoke

- User asks to "reflect", "review past sessions", "see what mars learned",
  or "synthesize suggestions from recent tasks".
- User invokes `/mars:reflect` with or without flags.
- Skip and explain if `MARS_REFLECT_DISABLED=1` is set in the environment —
  the CLI will short-circuit and produce nothing.

## Inputs

Optional positional/flag args, passed through verbatim:

- `--since <iso>`: only reflect on tasks completed after this ISO timestamp
  (e.g. `2026-05-01T00:00:00Z`).
- `--limit <n>`: max number of tasks to include (default: 10).

If the user gives a natural-language window ("last week", "since Monday"),
convert it to an ISO timestamp before calling `mars reflect --since`. If you
cannot resolve it confidently, ask one clarifying question.

Never invent task ids or fabricate suggestions. The CLI is the only producer.

## Plan

1. Sanity-check the environment:
   ```bash
   echo "${MARS_REFLECT_DISABLED:-}"
   ```
   If it prints `1`, stop and tell the user reflection is disabled via env
   var. Do not unset it on their behalf.

2. Check there's something to reflect on:
   ```bash
   mars list done | head -5
   ```
   If no completed tasks exist (and no `--since` was given that would still
   match), tell the user there is nothing to reflect on and stop.

3. Run reflection in the foreground so the user sees progress and any
   model output:
   ```bash
   mars reflect [--since <iso>] [--limit <n>]
   ```
   This is a long-running command (it calls an LLM to synthesize
   suggestions). Do **not** background it.

4. After it returns, list the resulting reflection-source proposals:
   ```bash
   mars proposal list --source reflection --status draft
   ```
   Print the output so the user sees what landed. If the list is empty,
   say so — reflection ran but produced no new proposals.

5. Tell the user how to act on a proposal:
   ```
   To shape a reflection proposal into a runnable task: /mars:grill <proposal-id>
   ```
   Do **not** run `/mars:grill` yourself — that is a separate user-driven
   step.

## Conventions

- **Never bypass the CLI.** Don't poke at `.mars/mars.db` directly;
  don't insert into `proposals` by hand.
- **Foreground only.** `mars reflect` is the user-visible action; do not
  run it with `run_in_background`.
- **Repo resolution.** The CLI resolves the target repo itself. Do not pass
  `--repo` unless the user explicitly provided one.
- **No auto-promotion.** Reflection proposals stay in `draft` status. This
  skill does not call `mars proposal promote`, `/mars:grill`, or any write
  verb beyond `mars reflect` itself.

## Failure handling

- `MARS_REFLECT_DISABLED=1` → tell the user, do not unset, stop.
- No completed tasks in the window → report "nothing to reflect on" and stop.
- `mars reflect` exits non-zero → surface stderr verbatim; do not retry.
- `mars proposal list --source reflection --status draft` empty after a
  successful run → report that reflection produced no new proposals (this is
  a normal outcome, not a failure).

## Example transcript

> User: `/mars:reflect --limit 20`
>
> Skill checks `MARS_REFLECT_DISABLED`, runs `mars list done | head -5` to
> confirm there is history, runs `mars reflect --limit 20` in the
> foreground, then `mars proposal list --source reflection --status draft` to
> display the new proposals, and points the user at `/mars:grill <id>` to
> shape one into a task.
