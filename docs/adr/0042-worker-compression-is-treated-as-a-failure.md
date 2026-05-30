# Worker compression is treated as a failure

## Status

Accepted

## Context

Headless Claude Code workers run unbounded turns in parallel worktrees. As
a run accumulates context, the Claude Code CLI will eventually hit its
context-window limit and auto-compact (compress) the conversation to keep
going. Compaction is lossy: it summarises earlier turns, which can silently
drop the precise file contents, error output, and task framing a coder was
relying on. A worker that compacts mid-implementation often degrades —
re-deriving state it already had, contradicting earlier decisions, or
producing a diff that no longer matches the task — without any signal that
its working memory was truncated.

Mars optimises for correctness and observability of each run over the
survival of any individual run. A recovery task (exactly one per origin
failure) and the action-queue/inbox already exist to handle a run that
cannot finish cleanly.

## Decision

A worker reaching its compression (context-compaction) threshold is treated
as a **failure**, not a recoverable in-run event. The orchestrator does not
allow a worker to silently compact and continue.

Concretely:

- Each worker carries a per-worker context-token budget (mirroring the
  existing per-worker message cap). `runClaudeCode` watches the live
  context size — derived from the most recent assistant event's
  input + cache tokens, not a cumulative sum across turns — and:
  - warns once at 80% of the budget, and
  - aborts the run as it approaches 100% (before the CLI would compact).
- The abort reuses the existing read-span external-abort path (exit 138),
  but is tagged with a distinct failure reason, `context-exhausted`, so it
  is distinguishable from an exploration-loop abort.
- From there it follows the normal failure flow: one recovery task per
  origin failure, with an action-queue item if recovery also fails. There
  is no graceful summarize-and-continue and no compaction-survival path.

## Consequences

- A run that would have compacted instead fails fast and visibly, before
  lossy compaction can corrupt its output. The failure is attributable
  (`context-exhausted`) rather than surfacing as a confusing bad diff.
- Per-worker budgets must be set conservatively below each model's real
  context window so the 80% warning fires before actual compaction; the
  budgets are a tuning surface (env override `MARS_CONTEXT_TOKEN_BUDGET`)
  and may need revisiting as model context windows change.
- Tasks that genuinely need more context than the budget allows must be
  sliced smaller upstream (the slicer's job) rather than relying on the
  worker to compact its way through — this pushes scope discipline to
  enqueue time.
- Trade-off accepted: we lose the ability for a long run to self-rescue via
  compaction, in exchange for never trusting a silently-truncated run.
