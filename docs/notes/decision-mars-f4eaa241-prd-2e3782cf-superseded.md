# Decision: PRD 2e3782cf (dual-write bridge) and siblings superseded

**Task:** mars-f4eaa241  
**Date:** 2026-05-18  
**Chosen option:** A (supersede; do not revert)

## Situation

PRD `2e3782cf` planned a phased idea→proposal rename:
- Slice 1 (`2e3782cf`): non-destructive dual-write bridge (keep `ideas` table live, add
  no-caller `proposals.ts`, copy rows idempotently).
- Slice 2 (`cdc18afc`): CLI cutover (`mars idea` → `mars proposal`).

Both slices were already `dismissed` before this task ran.

Commits that pre-empted the plan:
- **e968d85** (`WIP(mars-23c9352d)`): renamed `ideas.ts` → `proposals.ts`, rerouted all
  callers, destructively renamed the `ideas` table (`ALTER TABLE ideas RENAME TO proposals`),
  added `proposals-migration.test.ts` which asserts `ideas` table is gone.
- **8b0bd99** (`feat(planning-graph)`): built `proposal_dependencies` +
  `addProposalDependencies` + CLI wiring on top of the renamed `proposals.ts`.

## Actions taken

| Item | Before | After | Rationale |
|------|--------|-------|-----------|
| PRD `2e3782cf` (dual-write bridge) | `dismissed` | `dismissed` (already) | Premise invalid; both slices physically shipped destructively |
| PRD `cdc18afc` (CLI cutover) | `dismissed` | `dismissed` (already) | Pre-empted by e968d85 |
| Parent PRD `208a283c` (rename idea→proposal) | `sliced` | `dismissed` | Data-layer half shipped; CLI children all dismissed |
| Idea `56aa2337` (drop dead ideas.ts migration code) | `sliced` | `dismissed` | Target module `ideas.ts` is gone; `proposals.ts` has no equivalent dead code |
| Draft `07925a1c` (triage pass on 208a283c/56aa2337) | `draft` | `dismissed` | Triage applied in this task |
| Fresh idea `bec75592` (CLI verb rename) | — | `draft` | Deferred; operator sign-off needed |

## Verification: migration idempotency

`initProposals()` in `orchestrator/src/core/proposals.ts` is safe on re-run:

1. Module-level `initialised` flag short-circuits the second call within a process.
2. `tableSet.has('ideas') && !tableSet.has('proposals')` guards the `ALTER TABLE` rename.
3. `tableSet.has('idea_user_stories') && !tableSet.has('proposal_user_stories')` guards the
   user-stories rename.
4. All `CREATE TABLE` / `CREATE INDEX` calls use `IF NOT EXISTS`.

Both paths (legacy DB with `ideas` table, fresh DB without it) are covered by
`orchestrator/src/core/__tests__/proposals-migration.test.ts`.

**No separate idempotency task is needed.**

## Remaining open work

- `bec75592`: CLI verb rename `mars idea` → `mars proposal` — deferred draft; operator
  decides whether and when to promote.
- Separate known issue (out of scope here): `bun test` baseline is red (~141 failures,
  `vi.resetModules is not a function`); tracked separately.
