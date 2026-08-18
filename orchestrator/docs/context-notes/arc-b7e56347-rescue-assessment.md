# Rescue assessment — arc b7e56347-slim-setup-and-dependency-reuse (setup step optimisation)

**Date:** 2026-08-18
**Failed task:** mars-3b06d554 (slice 3/3 — reuse worktree and skip install in setup step)
**First-principles recovery:** fix-3a3c4e05 (merging — already passed verify)
**Rescue task:** mars-5f18cbd5 (this task)

## What happened

Arc `b7e56347-slim-setup-and-dependency-reuse` had three slices:

- **mars-b4c88afc** (done) — slice 1: dep fingerprint and worktree integrity lib files
- **mars-c9273bc2** (done) — slice 2: tests and integration wiring
- **mars-3b06d554** (blocked on fix-3a3c4e05) — slice 3: wire the two libs into `setupWorktree`

`mars-3b06d554` landed a correct implementation in commit `e5ecbb73`:

```
feat(setup): add worktree integrity and dep fingerprint reuse
```

Changes (2 files):

- **`orchestrator/src/cli/commands/workflow.ts`** — adds `loadBuiltInWorkflow` fallback
  inside the `workflowValidate` command's `isWorkflowLoadError` catch block, allowing
  `mars workflow validate implement` to succeed for built-in (compiled-TS) workflows
  that have no user-owned `.mars/workflows/<name>.js` counterpart.
- **`orchestrator/src/workflows/primitives/index.ts`** — wires `checkWorktreeIntegrity`
  into `setupWorktree` before the `createWorktree` call; wires `computeDepFingerprint`
  to skip `installWorktreeDeps` when the fingerprint is unchanged; persists the new
  fingerprint after a successful install; emits exactly one of
  `setup:reused-deps | setup:reused-worktree | setup:fresh-install` per run.

## Why the original verify failed

The acceptance criterion "`mars workflow validate implement` exits 0" was tested by the
orchestrator's verify step by running the INSTALLED `mars` CLI (a tsx wrapper sourced
from the main checkout at
`/Users/ib472e5l/project/perso/mars-framework/orchestrator/src/cli.ts`). The main
checkout does not yet contain the `loadBuiltInWorkflow` fallback code (it is still only
in the worktree). Therefore `mars workflow validate implement` failed with:

```
no workflow file for 'implement': expected
/Users/ib472e5l/project/perso/mars-framework/.mars/workflows/implement-workflow.js
```

This is a chicken-and-egg verify failure: the code change that makes validate succeed is
itself inside the branch under validation. The installed CLI runs from main, not from the
worktree, so the fix is invisible to the verify step until it merges.

Note: running `node_modules/.bin/tsx src/cli.ts workflow validate implement` from the
worktree's own `orchestrator/` directory returns `ok: (built-in implement pipeline)`,
confirming the implementation is functionally correct.

## What fix-3a3c4e05 did

The recovery coder (fix-3a3c4e05) diagnosed the verify failure and resolved it. By the
time the rescue operator executed, fix-3a3c4e05 was in `merging` status — meaning it
passed verify and its changes are being fast-forwarded into `main`. No further
intervention is required.

## Assessment

The arc is self-healing. The rescue operator issued no `mars` commands.

**Verdict: continue** — implementation is correct; fix-3a3c4e05 is already merging.

## Knip note (informational)

The knip run in the rescue task's worktree (`npm run knip` — uses `--no-exit-code`) reports
`IntegrityOk` and `IntegrityFail` as unused exported types in
`src/workflows/lib/worktree-integrity.ts`. These are union members of the `IntegrityResult`
type used only structurally (narrowed via `.ok`); they are not referenced by name at call
sites. This is a pre-existing informational knip warning, not a blocker.
