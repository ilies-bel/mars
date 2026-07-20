# Vision

> Forward-looking. Describes the target state of Mars, not the current code.
> For "what exists today," see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## What Mars is

**A lean, local-first, no-API-key alternative to managed agent platforms.**

Mars is a personal AI coding orchestrator. It runs Claude Code in parallel
git worktrees against a single repo, governed by a small TypeScript CLI and
a SQLite database that lives next to the project. Every LLM call goes through
the user's authenticated Claude Code session — there are no provider SDKs,
no API keys, no cloud control plane.

The point of Mars is to let one person run a small AI engineering team on
their own laptop, against their own repo, with the full audit trail in a
local SQLite file they can `cat`, `grep`, and back up like any other file.

## The canonical loop

```
draft  ──► queued  ──► running  ──► verifying  ──► merging  ──► done | failed
  │          ▲
  │          │
  └── chat ──┘
```

1. **Draft.** I jot down a feature idea: `mars add --draft "<spec>"`. The
   task lands in the DB as `draft` with empty `plan_functional` and
   `plan_technical` columns.
2. **Chat.** I open a chat skill (`/mars:feature:chat`) inside Claude Code.
   The skill grills me one question at a time, writing my answers directly
   into the task's plan columns in the Mars database. No markdown specs on disk.
   The conversation challenges fuzzy terms, cross-references the codebase,
   and refuses to move on until the plan is precise.
3. **Queued.** When I'm satisfied, the task transitions to `queued`. The
   plan is locked-in input for execution.
4. **Daemon pickup.** A long-running `mars daemon` polls `queued`,
   claims a task atomically, and dispatches it through the implement
   workflow. I don't trigger anything by hand — the daemon is the dispatcher.
5. **Implement.** Worktree on `task/<id>` off `integration` → `claude -p`
   with the prompt + plan → typecheck/test/lint → fast-forward into
   `integration`. Conflicts go to a bundled supervisor agent for
   reconciliation.
6. **Done or failed.** Worktree removed on success; retained for inspection
   on failure.

This is the only loop. There is no synchronous batch mode in the target
state — `mars run` (current code) collapses into the watcher.

## Glossary (intentionally small)

- **Task.** The unit of work. A row in the Mars database. Carries a prompt, a
  plan (functional + technical), a status, a worktree path, and a session id.
- **Plan.** Two free-text columns on a task: `plan_functional` (what and why)
  and `plan_technical` (where and how). Filled by the chat skill.
- **Supervisor.** A generated system prompt in `.mars/supervisors/`,
  tailored to the project's stack at `mars init` time. Agents read these
  to know the project's idioms.
- **Worktree.** A throwaway git worktree at `.mars/worktrees/<task-id>` on
  branch `task/<id>` off `integration`. One per running task.
- **Integration branch.** The merge target inside the orchestrator. `main`
  is reserved for human PRs.

No "feature" layer. No markdown specs on disk. No "ready" state separate
from "queued." If the chat skill currently talks about `features/<id>.md`
or `mars feature refine`, that's drift to be corrected in code.

## Non-goals

- **No LLM provider SDKs.** No `@ai-sdk/anthropic`, no `OPENAI_API_KEY`,
  no provider strings in `Agent({ model: ... })`. Every model call routes
  through `claude -p`.
- **No cloud or multi-tenant features.** No hosted control plane, no
  shared queues, no auth, no telemetry. State is one SQLite file per repo.
- **No managed agent runtime.** Mars does not try to be Mastra Cloud,
  LangSmith, or AutoGPT. It uses Mastra as a local workflow runtime and
  nothing more.
- **No write surface in the UI.** `mars ui` is a read-only viewer over
  the Mars database. The CLI is the only way to mutate state.
- **No background telemetry, no opt-in analytics.** What happens on the
  laptop stays on the laptop.

## Why this shape

The constraint that drives everything else is **no API keys**. That single
choice rules out the entire managed-agent ecosystem and forces a local
architecture: SQLite for state, file locks for serialization, headless
`claude -p` for inference, git worktrees for isolation. Each of those is
the simplest thing that could possibly work, and they compose.

The second constraint is **one user, one machine**. There is no concurrency
model for multiple humans, no permissioning, no audit trail beyond what
SQLite already gives me. That keeps the surface area small enough for one
person to hold in their head.

## Open questions

Things the docs have a position on but the code hasn't caught up to. These
will be reconciled in subsequent passes.

- **Chat skill ↔ orchestrator drift.** `.claude/commands/mars/feature/chat.md`
  describes a markdown-first model (`features/<id>.md`, `mars feature refine`,
  `.mars/state.db`). Vision is DB-first. The skill needs to be rewritten to
  edit the Mars database directly via `mars set-functional` / `mars
  set-technical` (or equivalent), not write markdown files.
- **`mars run` vs `mars daemon`.** Current code has both: `run` is a
  one-shot batch dispatcher, `daemon` is the long-running dispatcher.
  Vision says the daemon is canonical. Decide whether to keep `run` as a
  debug tool or remove it.
- ~~**`state.db` vs `queue.db`.**~~ Resolved: both merged into `mars.db`,
  since imported into the embedded Postgres store.
