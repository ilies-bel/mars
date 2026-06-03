---
name: deep-reflect
description: Run `mars arc reflect [<originId>]` to do a transcript-level post-mortem on a Mars task arc (origin task plus any recovery/fix tasks that share its originId). Surfaces token-spend patterns, redundant tool calls, confusion loops, and tool-call/result mismatches (e.g. a successful tool call that still required a follow-up call to get the needed info). Persists a JSON report under .mars/deep-reflections/ and lands "save" verdicts as draft proposals (source='reflection'). Use when the user says "deep reflect", "post-mortem a task arc", "analyse a single arc/session", or invokes `/mars:deep-reflect [originId]`.
---

# Mars: deep-reflect on a task arc

Run a transcript-level post-mortem on **one** Mars arc (an origin task
plus any recovery / fix tasks that share its `originId`). Where
`mars reflect` aggregates signals across many recent tasks, `mars arc
reflect` walks the stored `claude -p` transcripts for every task in a
single arc event-by-event to surface things aggregate reflection cannot
see:

- **token consumption** — where the model spent its budget across the
  arc, expensive turns, cache health per session;
- **time spent** — long stalls, slow tool calls, turns that dragged;
- **confusion loops** — same file Read 5+ times, Edit-and-revert pairs,
  repeated identical Bash invocations, thrash that crosses tasks;
- **tool-call / result mismatches** — a tool call that succeeded at the
  call site but did not give the assistant what it needed, forcing a
  follow-up call (e.g. an Edit that landed on the wrong line, a
  successful `Read` immediately followed by another Read of the same
  file with different offset/limit, a `git commit` that printed
  "nothing to commit", a verify step that reported pass with
  "0 passed, 0 failed");
- **cross-task patterns** — a recovery task that repeated the parent's
  failing strategy, work in task N that task N+1 silently undoes,
  retries thrashing on the same merge conflict.

The CLI persists a structured JSON report under
`.mars/deep-reflections/arc-<originId>-<iso>.json` (gitignored) and
inserts "save"-verdict findings as draft proposals with
`source='reflection'`. Proposals are **never auto-run** — they are for
the user to triage.

This skill does **not** invent findings itself. It runs the CLI, then
points the user at the report and the resulting draft proposals.

## When to invoke

- User asks to "deep reflect", "post-mortem a task arc", "analyse a
  single arc", "what went wrong with task X", "look at the transcript
  for that failed run".
- User invokes `/mars:deep-reflect` with or without an originId / task id.
- Skip and explain if `MARS_REFLECT_DISABLED=1` is set in the
  environment — the CLI short-circuits and produces nothing.

## Inputs

One optional positional arg, passed through verbatim:

- `<originId>`: an arc origin id (or any task id in the arc — the CLI
  resolves the origin via `COALESCE(origin_id, id)`). A one-task arc
  collapses to that single transcript, so passing a leaf task id with
  no recovery siblings is the supported way to do a single-session
  post-mortem.

If the user gives no id, **do not invent one**. Pass nothing and let
the CLI fall into its interactive picker: it prints the recent-arc list
and prompts the operator to type an originId.

If the user's natural-language pointer ("the last failed arc", "the one
about X") is ambiguous, ask one clarifying question or just let the
CLI's picker handle it.

`mars arc reflect` is single-arc by design. **Do not** loop it over
multiple ids; if the user wants several arcs reviewed, run the skill
once per id.

## Output contract

The skill's chat response is a structured relay of the CLI's output —
**not** a re-analysis. The LLM does not re-rank, re-summarise, or
re-score; it surfaces what the CLI already produced, in this fixed
shape, in this order:

1. **Arc header** — verbatim from the CLI:
   `arc <originId>: <n> task(s) [<status mix>], <n> event(s), <n> weighted tokens total`.
2. **Summary** — the CLI's `Summary:` line if present, else omit.
3. **Tool-call stats** — `Tool calls: <total> total — Edit=N, Bash=N, …`.
4. **Top 3 dissonant calls** — the CLI's printed `Top dissonant calls`
   block, kept as-is (severity, eventIndex, task id, tool, stated→actual).
   If the CLI printed none, say so in one line.
5. **Verify mismatches** — count + first entry severity/claimed/actual,
   only if the CLI reported any.
6. **Root cause** — the CLI's `Root cause:` line if present.
7. **Verdict counts** — `Suggestions: <saved> saved, <absorbed>
   absorbed, <dropped> dropped`.
8. **Report path** — the absolute
   `.mars/deep-reflections/arc-<originId>-<iso>.json` path from
   `Full report:`.
9. **Next step** — only if `saved > 0`: point at
   `mars proposal list --source reflection --status draft` and
   `/mars:grill <proposal-id>`.

Rules:
- Do **not** add findings the CLI did not print.
- Do **not** paraphrase severity, intent, or outcome — quote.
- Do **not** `cat` or `Read` the JSON report.
- If the CLI emits a non-zero exit code line, surface it verbatim as a
  final note; do not retry.

## Plan

1. Sanity-check the environment:
   ```bash
   echo "${MARS_REFLECT_DISABLED:-}"
   ```
   If it prints `1`, stop and tell the user deep reflection is disabled
   via env var. Do not unset it on their behalf.

2. Run the post-mortem in the foreground so the user sees the CLI's
   summary (arc header, findings, verdicts) as it streams:
   ```bash
   mars arc reflect [<originId>]
   ```
   Pass `<originId>` only if the user supplied one (an arc origin id or
   any task id in the arc). This is a long-running command (it calls
   an LLM to walk every task's transcript). Do **not** run it with
   `run_in_background`.

3. After it returns, locate the persisted report and surface the path
   so the user can open it for full detail:
   ```bash
   ls -1t .mars/deep-reflections/arc-*.json | head -1
   ```
   If a specific originId was used, filter to that id:
   ```bash
   ls -1t .mars/deep-reflections/arc-<originId>-*.json | head -1
   ```
   Tell the user the path. **Do not** `cat` or `Read` the JSON
   contents into chat — the file is large and the CLI's stdout
   summary already covered the highlights.

4. If the CLI's summary mentions that draft proposals were created, point
   the user at the list and the follow-up verb:
   ```bash
   mars proposal list --source reflection --status draft
   ```
   Then tell them how to act:
   ```
   To shape a reflection proposal into a runnable task: /mars:grill <proposal-id>
   ```
   Do **not** run `/mars:grill` yourself — that is a separate
   user-driven step.

## Conventions

- **Never bypass the CLI.** Don't poke at `.mars/queue.db` directly;
  don't read JSONL transcripts under `~/.claude/projects/` by hand;
  don't insert into `proposals` by hand.
- **Foreground only.** `mars arc reflect` is the user-visible action;
  do not run it with `run_in_background`.
- **Never invent an originId.** If the user is vague, ask one clarifying
  question or let the CLI's picker prompt for one. Do not guess from
  `mars list`.
- **Single arc.** One invocation, one arc. Don't loop the verb.
- **Repo resolution.** The CLI resolves the target repo itself. Do not
  pass `--repo` unless the user explicitly provided one.
- **No auto-promotion.** Reflection proposals stay in `draft` status. This
  skill does not call `mars proposal promote`, `/mars:grill`, or any write
  verb beyond `mars arc reflect` itself.

## Failure handling

- `MARS_REFLECT_DISABLED=1` → tell the user, do not unset, stop.
- `mars arc reflect` exits non-zero → surface stderr verbatim; do not
  retry.
- CLI prints `no arc found for <id>` for an explicit id → tell the user
  verbatim and stop. The skill cannot recover a missing arc.
- CLI ran but produced no "save" verdicts → report that the
  post-mortem completed and produced no new draft proposals (this is a
  normal outcome, not a failure). The JSON report still exists and is
  worth pointing at.

## Example transcript

> User: `/mars:deep-reflect mars-7f86263a`
>
> Skill checks `MARS_REFLECT_DISABLED`, runs
> `mars arc reflect mars-7f86263a` in the foreground (CLI resolves the
> origin even if the id is a leaf task in the arc), watches the CLI
> print the arc header, findings, and verdict summary, then runs
> `ls -1t .mars/deep-reflections/arc-*7f86263a*-*.json | head -1` and
> tells the user the path. If new draft proposals landed, points at
> `mars proposal list --source reflection --status draft` and
> `/mars:grill <proposal-id>` to shape one into a task.
>
> User: `/mars:deep-reflect` (no id)
>
> Skill runs `mars arc reflect` with no id; the CLI prints the recent
> arc list and prompts for an originId. Skill surfaces the resulting
> JSON path the same way.
