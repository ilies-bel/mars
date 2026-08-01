# Knip cleanup plan (transient)

> **STATUS 2026-08-01 — PARTIALLY SUPERSEDED. READ THIS BOX FIRST.**
>
> This file is kept only because Slice 1 is still open. Its analysis is
> otherwise stale and **Slice 4 is dangerous — do not execute it.**
>
> - **Slice 4 is WRONG. Do NOT `git rm -r orchestrator/src/bus`.**
>   `src/bus/` is the LIVE event bus: 41 files under `orchestrator/src`
>   import from it (`events.ts`, `publisher.ts`, `subscribers.ts`,
>   `processed-once.ts`, `log.ts`), and it has six test files of its own.
>   The claim that it has "zero importers" was true of a much older tree
>   and is false today. Only the orphaned WebSocket transport within it
>   (`client.ts`, `daemon.ts`) was dead; both were deleted, together with
>   the `ws` / `@types/ws` dependencies. `better-sqlite3` is no longer a
>   dependency at all, so that half of the slice is moot.
> - **Slice 5 is DONE**, and wider than described: `orchestrator/knip.json`
>   now ignores all of `src/init/templates/**`, not just the one
>   provider-registry asset. Those templates are copied into consumer
>   repos by `mars init` and are discovered by a runtime `readdirSync`,
>   so static analysis can never see them.
> - **Slices 2 and 3 are DONE** (already were, per the notes below).
> - **Slice 1 is the only work left**, and its counts are stale: with the
>   entry list corrected, knip reports **118 unused exports and 99 unused
>   exported types**, not 23 and 26.
> - The whole "Mastra registration surface" section below is obsolete.
>   Mastra has been removed from this repo; workflows run on the in-house
>   `@mars/workflow` engine. `src/core/index.ts`, the file that section is
>   built around, **no longer exists** — it was still listed as the sole
>   production entry in `orchestrator/knip.json` until it was removed.
> - Unused *files* and unused *dependencies* are now both at zero. Do not
>   re-derive them from this document.

Pre-curated working notes for the orchestrator knip-cleanup task
(parent: mars-e95b5ee0). The first two implementors stalled
cross-checking ~60 findings against Mastra registrations within the
read budget; this file front-loads that analysis so the next pass
can act.

**Read this file BEFORE running knip yourself.** It pre-triages every
finding against `src/core/index.ts` and `AGENTS.md` so you don't
have to redo the cross-check from scratch. Re-confirmed 2026-05-17:
running `npm --prefix orchestrator run knip` produces exactly the
findings this plan triages — 8 unused files, 4 unused deps, 23
unused exports, 26 unused exported types.

**Delete this file in the final cleanup commit.**

## Mastra registration surface (verified)

`orchestrator/src/core/index.ts` registers only:

- workflows: `implementWorkflow`, `initWorkflow`, `triageWorkflow`,
  `sliceWorkflow`, `abExperimentWorkflow`
- scorers: `verifyPassedScorer`, `mergeCleanScorer`
- plus `resolveContext` from `./context`

**No agents or tools are registered in `index.ts`.** That means the
"Mastra hidden-registration" false-positive risk highlighted in the
brief only meaningfully applies to symbols reachable transitively from
those 7 workflow/scorer files + `context.ts`. Anything outside that
reachable graph is fair game for removal once knip flags it.

## Curated cleanup slices (do in this order — smallest blast radius first)

### Slice 1 — Unused intra-module exports (lowest risk)

23 named exports + 26 exported types/interfaces flagged by knip are
never imported anywhere. Drop the `export` keyword (or delete the
symbol if also unused locally). No runtime impact possible since
nothing imports them.

Spot-check before each removal: `rg "\\b<symbol>\\b" orchestrator/src
orchestrator/tests` — confirm zero hits outside the defining file.

Watch for these that **look** internal but might be CLI-surface:

- `DEVIATION_RULES`, `BLOCKERS_ABORT_MESSAGE`, `TOO_HARD_ABORT_MESSAGE`,
  `TOO_HARD_PREFIX` in `implement-workflow.ts` — verify no test or
  daemon path matches the literal strings.
- `planWorkflow` / `runPlan` in `plan-workflow.ts` — **CONFIRMED LIVE,
  do NOT delete.** `runPlan` is dynamically imported at
  `src/core/daemon/server.ts:460` inside `dispatchRefine`, which is
  invoked from a bus-event handler at `server.ts:566`. A literal-string
  `rg "plan-workflow|planWorkflow" orchestrator/src` catches it; a
  type-only static analysis like knip will miss the `await import()`.
  Whether the refine bus-event path is itself reachable in practice is
  a separate question — parked as a mars idea, not in scope here.

Commit as one slice (or split workflows / lib / init if diff is large).

### Slice 2 — `src/core/lib/origin-timeline.ts` ✅ DONE

Deleted in commit `813da93` ("remove dead origin-timeline and
load-manifest modules"). The stale JSDoc comment in
`claude-session-ids.ts` was also resolved by the same commit (verify
with `rg "origin-timeline|OriginTimeline" orchestrator/src` — should
return zero hits in `.ts` files).

### Slice 3 — `src/init/load-manifest.ts` ✅ DONE

Deleted in commit `813da93`. Verify with `rg "load-manifest|loadManifest"
orchestrator/src` — zero hits expected.

### Slice 4 — Bus subsystem (largest, do last, separate commit)

`src/bus/` (8 files: `client.ts`, `daemon.ts`, `db.ts`, `events.ts`,
`log.ts`, `publisher.ts`, `schema.ts`, plus one more) has **zero
importers in `orchestrator/src`** (verified with
`rg "from ['\"].*bus/" orchestrator/src` — no matches).

Note: the live event bus is `src/internal-bus/` (different directory).
`src/bus/` is a separate, orphaned subsystem.

Deleting the directory also makes these dependencies removable
(they are consumed only by `src/bus/`):

- `better-sqlite3` + `@types/better-sqlite3` (only in `src/bus/db.ts`,
  `publisher.ts`, `schema.ts`)
- `ws` + `@types/ws` (only in `src/bus/daemon.ts`)

Order within this slice:
1. Confirm one more time: `rg -l "from ['\"].*\\bbus/" orchestrator/src
   orchestrator/tests` returns nothing outside `src/bus/` itself.
2. `git rm -r orchestrator/src/bus`
3. Remove the four deps from `orchestrator/package.json` (runtime
   `dependencies` for `better-sqlite3` and `ws`; `devDependencies` for
   the two `@types/*`).
4. Also remove `"better-sqlite3"` from the `pnpm.onlyBuiltDependencies`
   array in `package.json` (line ~55).
5. Drop the lockfile updates (`package-lock.json`, `pnpm-lock.yaml`)
   by running `npm --prefix orchestrator install` after the
   `package.json` edit.
6. Verify: `npm --prefix orchestrator run build` + `npm --prefix
   orchestrator test`.

### Slice 5 — `knip.json` ignore for template asset

`src/init/templates/claude/skills/mastra/scripts/provider-registry.mjs`
is **NOT dead** — it is a template file copied into user repos by
`mars init` (referenced by sibling `SKILL.md` lines 46, 145, 148, 149).

Add an ignore to `orchestrator/knip.json`:

    "ignore": ["src/init/templates/**"]

(Adjust to merge with whatever `ignore` already exists.) Templates are
runtime assets, not source — knip can't see the copy-tree at
`mars init` time. Note this rationale in the commit message.

## Verification per slice

After each slice:

    npm --prefix orchestrator run knip   # report should shrink
    cd orchestrator && npm run build      # green
    cd orchestrator && npm test           # green

## Out of scope (file as `mars idea add` if interesting)

- Knip configuration tuning beyond the one template ignore.
- Refactoring the live `src/internal-bus/` subsystem.
- Investigating whether `src/bus/` is a partially-extracted future
  feature worth resurrecting — current evidence says "orphan, delete".
