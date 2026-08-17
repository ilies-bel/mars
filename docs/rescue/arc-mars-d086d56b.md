# Rescue Assessment — Arc mars-d086d56b

**Date:** 2026-08-17  
**Rescue task:** mars-62659e4b  
**Failed task:** mars-d086d56b  
**Failure signature:** dispatch:bad-primitive-opts/unclassified  

## What failed

Task `mars-d086d56b` was a `--workflow report` task investigating the PGLite WASM
full-suite deadlock. It failed immediately at dispatch with:

```
dispatch:bad-primitive-opts: runAgent: unknown option(s) 'mode' — did you mean
awaitHuman(ctx, { note }) for a manual step?
```

## Root cause

The deployed `.mars/workflows/report-workflow.js` was on **v4**, which calls:

```js
await ctx.step('code', () => runAgent(ctx, { mode: 'auto' }))
```

`mode` is not a member of `RunAgentOpts` (see `opts-descriptors.ts`). The
primitive validator in `src/workflows/primitives/index.ts` rejects unknown keys and
marks the task `failed` with `failureReasonCode: 'dispatch:bad-primitive-opts'`.

The bundled template had already been updated to **v5** (removing `mode: 'auto'`)
as part of the 2026-08-16 incident fix, but the deployed file was not refreshed via
`mars update`.

## Arc state at rescue arrival

| task | status at rescue | notes |
|------|-----------------|-------|
| mars-d086d56b | blocked | waiting on fix task |
| fix-b2c6d54b | **running** | recovery coder active on worktree |

The arc had self-progressed by the time the rescue operator arrived — `fix-b2c6d54b`
moved from `queued` → `running` without operator intervention.

## Actions taken

1. **Fixed `.mars/workflows/report-workflow.js`** (operator-level, not committed —
   gitignored): bumped to v5, removed `{ mode: 'auto' }` from the `runAgent` call.
   This prevents future `--workflow report` tasks from hitting the same
   `bad-primitive-opts` dispatch failure.

2. **Verdict: continue** — `fix-b2c6d54b` is the active recovery; no restart or
   supersede is warranted. The original investigation goal (PGLite deadlock cause)
   will be completed when `fix-b2c6d54b` finishes.

## Prevention

The `bundled-workflow-templates.test.ts` CI guard (added in the same 2026-08-16
incident fix) now validates every bundled template through `dryRunWorkflow` and
catches unknown-option errors before release. The deployed workflow was already
out of sync with the fixed template.

**Going forward:** when `mars update` reports template diffs, apply them promptly
to avoid deployed workflows falling behind the primitives API.
