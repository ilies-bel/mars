# Unblock note for mars-e95b5ee0 (orchestrator knip cleanup)

The first two implementor passes both stalled in read-only mode
cross-checking knip findings against Mastra registrations. This note
points the next dispatch at the missing context.

## Missing context the implementor needs

**A pre-curated cleanup plan already exists on `main`:**
`orchestrator/KNIP-CLEANUP-PLAN.md` (renamed from `.knip-cleanup-plan.md`
in this unblock — the dot-prefix is why prior implementors didn't
discover it via `ls orchestrator/`).

That plan already does the work the implementor was trying to do
from scratch: it enumerates every Mastra registration in
`src/mastra/index.ts`, then triages every knip finding against it,
broken into five slices ordered smallest-blast-radius first.

**Action for the next implementor:** read
`orchestrator/KNIP-CLEANUP-PLAN.md` first, then execute one slice
per commit. Re-run `npm --prefix orchestrator run knip` after each
slice to confirm the targeted items dropped out of the report.

## Probe results re-confirmed during this unblock (2026-05-17)

- `npm --prefix orchestrator run knip` runs cleanly and reports
  exactly the findings the plan covers (8 unused files, 4 unused
  deps, 23 unused exports, 26 unused exported types).
- `src/mastra/index.ts` registers only 5 workflows
  (`implementWorkflow`, `initWorkflow`, `triageWorkflow`,
  `sliceWorkflow`, `abExperimentWorkflow`) + 2 scorers
  (`verifyPassedScorer`, `mergeCleanScorer`) + `resolveContext`.
  **No `agents` or `tools` are registered there** — the
  hidden-registration false-positive risk in the parent brief is
  narrower than it sounds.
- `src/bus/` is confirmed orphan: `rg "from ['\"].*bus/"
  orchestrator/src` returns nothing outside `src/bus/` itself, and
  `src/internal-bus/` is the live event bus (different directory,
  not flagged by knip).
- `better-sqlite3` and `ws` (and their `@types/*`) are consumed
  **only** inside `src/bus/`, so removing the bus subsystem clears
  those deps too.
- `src/init/templates/claude/skills/mastra/scripts/provider-registry.mjs`
  is a runtime template asset copied by `mars init`, not dead code —
  the plan correctly flags it as a knip false positive.

## Why the watcher aborted last time

Read trail at abort:
1. `orchestrator/src/mastra/index.ts`
2. `orchestrator/AGENTS.md`
3. `orchestrator/knip.json`
4. `orchestrator/package.json`
5. Grep `orchestrator/src`

All five reads were trying to build the Mastra-registration map
from scratch. The pre-curated plan already contains that map. The
parent prompt does not mention the plan exists — that's the gap
this note closes. After reading the plan, executing slice 1 should
be the next action, not another read.

## Out of scope here

Do not attempt to complete the parent task in this unblock
worktree — when mars-e95b5ee0 re-dispatches off `main` it will
get a fresh worktree with this note and the renamed plan visible
at the orchestrator root.
