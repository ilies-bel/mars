# Context note — mars-68cb0655 / mars-fce65d26 (verify:test error excerpt)

**Status: the parent task chain is essentially already resolved. This
note exists so a re-dispatched implementor does not loop on it again.**

## Why the implementors kept aborting with `too_hard:no-action-after-reads`

`mars-fce65d26` asked: *"verify:test failures persist a useless error
excerpt (the vitest run HEADER, not the failing assertion) — persist the
END of the output, not the head."*

That core fix **already landed today** in commit `d20b5af`
("fix(verify): persist failing-test tail, not the run preamble"):

- `failureExcerpt()` in `implement-workflow.ts` was extracted and
  rewritten to keep the **tail** (the assertion diff + final `FAIL`
  summary), not the head.
- It is used for both the persisted `error` column (`updateTask`) and
  `firstFailedOutput` fed to the fix-recipe classifier.
- The excerpt cap was bumped 500 → 2000.
- Unit tests in `__tests__/implement-workflow.test.ts` assert the tail
  is kept and the preamble dropped.

So when the `mars-fce65d26` and then `mars-68cb0655` implementors read
`implement-workflow.ts` looking for head-slicing code to fix, **there
was nothing to change** — the bug was already gone. The read-span guard
killed them mid-search. This is a stale-task artifact, not a real block.

## What this follow-up (mars-9662b735) delivered

The one piece of the parent prompt **not** covered by `d20b5af` was its
explicitly-requested trade-off mitigation:

> "capture BOTH a small head (first ~1KB, catches early spawn/import
> crashes) AND the tail (catches the actual assertion) … concatenated
> with a separator, capped at a sane total size."

`failureExcerpt()` now keeps a `headMax`-byte head **and** a
`tailMax`-byte tail joined by `…[middle elided]…`, so an early
spawn/import crash (whose only signal is at the very top, before any
test runs) survives alongside the failing-assertion tail. Tests updated
accordingly, including the regression guard the parent prompt asked for
(excerpt must not consist solely of the passing preamble).

## Recommended disposition of the parent chain

`mars-fce65d26` and `mars-68cb0655` should be **purged, not retried** —
their entire scope is now delivered (`d20b5af` + this commit). Retrying
them will only abort again on `verify:has-diff/no-commits-ahead`
(nothing left to change). An idea has been filed recommending the purge.
