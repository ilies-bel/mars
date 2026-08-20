# Vision

> Forward-looking. Describes the target state of Mars, not the current code.
> For "what exists today," see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## What Mars is

**A lean, local-first, no-API-key alternative to managed agent platforms.**

Mars is a personal AI coding orchestrator. It runs a selected agent CLI in
parallel git worktrees against a single repo, governed by a small TypeScript
CLI and an embedded PostgreSQL database that lives next to the project. Every
LLM call crosses one provider-neutral boundary and then uses the user's existing
CLI authentication. Codex via `codex exec` and the OAuth session created by
`codex login` is the default; Claude Code and Gemini are alternative adapters.
There are no provider SDKs and no cloud control plane.

The point of Mars is to let one person run a small AI engineering team on
their own laptop, against their own repo, with the full audit trail in a
local database they can inspect, back up, and restore themselves.

## The canonical loop

```
grill/shape ──► draft ──► triaging ──┐
                                      ├──► queued ──► running ──► verifying ──► merging ──► done | failed
              mars task add ─────────┘
```

1. **Shape (optional, for hard or cross-repo work).** I open `/mars:grill`
   inside Claude Code. It challenges fuzzy terms against the domain model,
   cross-references the codebase, and writes decisions straight into
   `CONTEXT.md` and ADRs as they crystallise — conversation only, no
   markdown specs on disk. When the conversation settles, `/mars:to-prd`
   synthesises it into a proposal (`mars proposal add`), which I then
   `mars proposal promote` and `mars proposal slice` into vertical-slice
   tasks.
2. **Enqueue.** For everything else, `mars task add "<prompt>"` lands a
   task directly in the DB, skipping triage. Plan text — what and why,
   where and how — lives in the `plan_functional` / `plan_technical`
   columns, set via `mars task set-functional` / `set-technical` (or the
   inline plan flags on `task add`), not in markdown files.
3. **Daemon pickup.** A long-running `mars daemon` polls `queued`,
   claims a task atomically, and dispatches it through the implement
   workflow. I don't trigger anything by hand — the daemon is the dispatcher.
4. **Implement.** Worktree on `task/<id>` off `main` (override with
   `INTEGRATION_BRANCH`) → selected agent CLI with the prompt + plan →
   typecheck/test/lint → fast-forward into `main`, serialized via file
   lock. Conflicts go to the bundled `vcs-supervisor` agent ("Vega") for
   reconciliation.
5. **Done or failed.** Worktree removed on success; retained for inspection
   on failure.

This is the only loop. There is no synchronous batch mode in the target
state — the old `mars run` synchronous batch dispatcher has already been
removed from the code; `mars daemon` is the sole entry point.

## Glossary (intentionally small)

- **Task.** The unit of work. A row in the Mars database. Carries a prompt, a
  plan (functional + technical), a status, a worktree path, and a session id.
- **Plan.** Two free-text columns on a task: `plan_functional` (what and why)
  and `plan_technical` (where and how). Filled via `set-functional` /
  `set-technical` or by the shaping skills (`/mars:grill`, `/mars:to-prd`).
- **Supervisor.** A generated system prompt in `.mars/supervisors/`,
  tailored to the project's stack at `mars init` time. Agents read these
  to know the project's idioms.
- **Worktree.** A throwaway git worktree at `.mars/worktrees/<task-id>` on
  branch `task/<id>` off `main`. One per running task.
- **Integration branch.** The merge target inside the orchestrator. `main`
  by default, overridable per-invocation with `INTEGRATION_BRANCH`.

No "feature" layer. No markdown specs on disk. No "ready" state separate
from "queued." Plan text lives in the `plan_functional` / `plan_technical`
columns, never in a `features/<id>.md` file, and there is no
`mars feature refine` command.

## Non-goals

- **No LLM provider SDKs.** No `@ai-sdk/anthropic`, no `OPENAI_API_KEY`,
  and no direct provider invocation outside an adapter. Every model call routes
  through the provider-neutral dispatch boundary and the selected local CLI.
- **No cloud or multi-tenant features.** No hosted control plane, no
  shared queues, no Mars account, no telemetry. State is embedded PostgreSQL
  per repo; provider authentication remains owned by the provider CLI.
- **No managed agent runtime.** Mars does not try to be a hosted agent
  platform like LangSmith or AutoGPT. Workflows run on the in-house
  `@mars/workflow` engine (`packages/workflow/`) as a local runtime and
  nothing more.
- **No write surface in the UI.** `mars ui` is a read-only viewer over
  the Mars database. The CLI is the only way to mutate state.
- **No background telemetry, no opt-in analytics.** What happens on the
  laptop stays on the laptop.

## Why this shape

The constraint that drives everything else is **local CLI authentication, not
provider credentials managed by Mars**. It forces a local architecture:
embedded PostgreSQL for state, file locks for serialization, headless agent
CLIs for inference, and git worktrees for isolation. The provider boundary is
deliberately narrow so changing the configured provider does not change task,
workflow, scheduling, or verification code.

The second constraint is **one user, one machine**. There is no concurrency
model for multiple humans, no permissioning, and no multi-user control plane.
The local event and transcript stores provide the audit trail. That keeps the
surface area small enough for one person to hold in their head.

## Open questions

Previously-open items. Both have since landed in code; kept here as
history rather than deleted outright.

- ~~**Chat skill ↔ orchestrator drift.**~~ Resolved: there is no
  `features/<id>.md` and no `mars feature refine`. Plan text is set via
  `mars task set-functional` / `set-technical` (or the inline plan flags
  on `mars task add`), and shaping happens conversationally through
  `/mars:chat` → `/mars:grill` → `/mars:to-prd`, which write straight to
  the proposals and task tables.
- ~~**`mars run` vs `mars daemon`.**~~ Resolved: `mars run` was removed.
  `mars daemon` is the sole dispatcher.
- ~~**`state.db` vs `queue.db`.**~~ Resolved: both merged into `mars.db`,
  since imported into the embedded Postgres store.
