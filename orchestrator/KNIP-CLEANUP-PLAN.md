# Knip cleanup plan (transient)

Pre-curated working notes for the orchestrator knip-cleanup task
(parent: mars-e95b5ee0). The first two implementors stalled
cross-checking ~60 findings against Mastra registrations within the
read budget; this file front-loads that analysis so the next pass
can act.

**Read this file BEFORE running knip yourself.** It pre-triages every
finding against `src/mastra/index.ts` and `AGENTS.md` so you don't
have to redo the cross-check from scratch. Re-confirmed 2026-05-17:
running `npm --prefix orchestrator run knip` produces exactly the
findings this plan triages — 8 unused files, 4 unused deps, 23
unused exports, 26 unused exported types.

**Delete this file in the final cleanup commit.**

## Mastra registration surface (verified)

`orchestrator/src/mastra/index.ts` registers only:

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
- `planWorkflow` in `plan-workflow.ts` — confirm it isn't lazy-loaded
  by an experimental code path before removing.

Commit as one slice (or split workflows / lib / init if diff is large).

### Slice 2 — `src/mastra/lib/origin-timeline.ts`

Only reference is a **stale comment** in
`src/mastra/lib/claude-session-ids.ts:11` ("Import it here instead of
re-implementing"). No actual import. Verify with:

    rg "origin-timeline|originTimeline" orchestrator/src orchestrator/tests

If zero non-comment hits: delete the file and update the comment in
`claude-session-ids.ts` so future readers don't go hunting for a
deleted module.

### Slice 3 — `src/init/load-manifest.ts`

Knip flags as unused. Verify with `rg "load-manifest|loadManifest"
orchestrator/src orchestrator/tests` before deleting.

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
