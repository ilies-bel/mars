---
name: mars:deep-reflect
description: Run `mars deep-reflect [<task-id>]` to do a single-session, transcript-level post-mortem on one Mars task arc. Surfaces token-spend patterns, redundant tool calls, confusion loops, and tool-call/result mismatches (e.g. a successful tool call that still required a follow-up call to get the needed info). Persists a JSON report under .mars/deep-reflections/ and lands "save" verdicts as draft proposals (source='reflection'). Use when the user says "deep reflect", "post-mortem one task", "analyse a single arc/session", or invokes `/mars:deep-reflect [task-id]`.
---

# Mars: deep-reflect on a single task arc

Run a transcript-level post-mortem on **one** Mars task. Where
`mars reflect` aggregates signals across many recent tasks, `mars deep-reflect`
walks a single stored `claude -p` transcript event-by-event to surface
things aggregate reflection cannot see:

- **token consumption** — where the model spent its budget within the arc,
  expensive turns, cache health for that one session;
- **time spent** — long stalls, slow tool calls, turns that dragged;
- **confusion loops** — same file Read 5+ times, Edit-and-revert pairs,
  repeated identical Bash invocations, thrash;
- **tool-call / result mismatches** — a tool call that succeeded at the
  call site but did not give the assistant what it needed, forcing a
  follow-up call (e.g. an Edit that landed on the wrong line, a
  successful `Read` immediately followed by another Read of the same
  file with different offset/limit, a `git commit` that printed
  "nothing to commit", a verify step that reported pass with
  "0 passed, 0 failed").

The CLI persists a structured JSON report under
`.mars/deep-reflections/<task-id>-<iso>.json` (gitignored) and inserts
"save"-verdict findings as draft proposals with `source='reflection'`.
Proposals are **never auto-run** — they are for the user to triage.

This skill does **not** invent findings itself. It runs the CLI, then
points the user at the report and the resulting draft proposals.

## When to invoke

- User asks to "deep reflect", "post-mortem one task/session", "analyse
  a single arc", "what went wrong with task X", "look at the transcript
  for that failed run".
- User invokes `/mars:deep-reflect` with or without a task id.
- Skip and explain if `MARS_REFLECT_DISABLED=1` is set in the
  environment — the CLI short-circuits and produces nothing.

## Inputs

One optional positional arg, passed through verbatim:

- `<task-id>`: a specific Mars task id to post-mortem.

If the user gives no id, **do not invent one**. Pass nothing and let
the CLI auto-pick via `pickDeepReflectCandidate()`. Its precedence:

1. most recent failed task with a stored transcript;
2. else, highest-cost done task in the last 7 days (cost ≥ 2× median);
3. else, most recent done task with a transcript;
4. else, prints "no eligible session found" and exits 0.

If the user's natural-language pointer ("the last failed task", "the
one about X") is ambiguous, ask one clarifying question or just let
the CLI auto-pick — the CLI prints the pick reason (status, weightedTokens,
why-picked) so the user can see what was chosen.

`mars deep-reflect` is single-session by design. **Do not** loop it
over multiple ids; if the user wants several arcs reviewed, run the
skill once per id.

## Output contract

The skill's chat response is a structured relay of the CLI's output —
**not** a re-analysis. The LLM does not re-rank, re-summarise, or
re-score; it surfaces what the CLI already produced, in this fixed
shape, in this order:

1. **Pick line** — verbatim from the CLI:
   `task <id> (status=<status>, weighted-tokens=<n>, picked: <reason>)`
   or `task <id> (explicit selection)`.
2. **Transcript size** — verbatim:
   `loading transcript: <n> event(s), verifyOutput=<n> chars | none`.
3. **Summary** — the CLI's `Summary:` line if present, else omit.
4. **Tool-call stats** — `Tool calls: <total> total — Edit=N, Bash=N, …`.
5. **Top 3 dissonant calls** — the CLI's printed `Top dissonant calls`
   block, kept as-is (severity, eventIndex, tool, stated→actual). If
   the CLI printed none, say so in one line.
6. **Verify mismatch** — severity + claimed→actual, only if the CLI
   reported one.
7. **Root cause** — the CLI's `Root cause:` line if present.
8. **Verdict counts** — `Suggestions: <saved> saved, <absorbed>
   absorbed, <dropped> dropped`.
9. **Report path** — the absolute `.mars/deep-reflections/<task>-<iso>.json`
   path from `Full report:`.
10. **Next step** — only if `saved > 0`: point at
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
   summary (pick reason, findings, verdicts) as it streams:
   ```bash
   mars deep-reflect [<task-id>]
   ```
   Pass `<task-id>` only if the user supplied one. This is a
   long-running command (it calls an LLM to walk the transcript). Do
   **not** run it with `run_in_background`.

3. After it returns, locate the persisted report and surface the path
   so the user can open it for full detail:
   ```bash
   ls -1t .mars/deep-reflections/*.json | head -1
   ```
   If a specific task id was used, filter to that id:
   ```bash
   ls -1t .mars/deep-reflections/<task-id>-*.json | head -1
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
- **Foreground only.** `mars deep-reflect` is the user-visible action;
  do not run it with `run_in_background`.
- **Never invent a task id.** If the user is vague, ask one clarifying
  question or let the CLI auto-pick. Do not guess from `mars list`.
- **Single session.** One invocation, one arc. Don't loop the verb.
- **Repo resolution.** The CLI resolves the target repo itself. Do not
  pass `--repo` unless the user explicitly provided one.
- **No auto-promotion.** Reflection proposals stay in `draft` status. This
  skill does not call `mars proposal promote`, `/mars:grill`, or any write
  verb beyond `mars deep-reflect` itself.

## Failure handling

- `MARS_REFLECT_DISABLED=1` → tell the user, do not unset, stop.
- `mars deep-reflect` exits non-zero → surface stderr verbatim; do not
  retry.
- CLI prints `no eligible session found (need at least one done/failed
  task with a stored transcript)` → report verbatim and stop. This is
  the CLI's normal output when no done/failed task with a stored
  transcript exists.
- CLI reports `no transcript found for task <id>` (or similar) for an
  explicit id → tell the user verbatim and stop. The skill cannot
  recover a missing transcript.
- CLI ran but produced no "save" verdicts → report that the
  post-mortem completed and produced no new draft proposals (this is a
  normal outcome, not a failure). The JSON report still exists and is
  worth pointing at.

## Example transcript

> User: `/mars:deep-reflect mars-7f86263a`
>
> Skill checks `MARS_REFLECT_DISABLED`, runs
> `mars deep-reflect mars-7f86263a` in the foreground, watches the
> CLI print the pick line, findings, and verdict summary, then runs
> `ls -1t .mars/deep-reflections/mars-7f86263a-*.json | head -1` and
> tells the user the path. If new draft proposals landed, points at
> `mars proposal list --source reflection --status draft` and
> `/mars:grill <proposal-id>` to shape one into a task.
>
> User: `/mars:deep-reflect` (no id)
>
> Skill runs `mars deep-reflect` with no id; the CLI auto-picks (most
> recent failed task → highest-cost done in 7d → most recent done) and
> prints the pick reason. Skill surfaces the resulting JSON path the
> same way.
