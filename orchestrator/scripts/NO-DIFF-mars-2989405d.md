# No-diff acknowledgment: mars-2989405d

Self-heal task `mars-2989405d` (TS2688 / install-failure recipe; branch
`task/2989405d`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This fix-fail row was auto-dispatched by `agent:fail-fix-handler` to repair
a failed `npm ci` inside `.mars/worktrees/80b2be31/ui/`. The dispatched
prompt assumes the install failure is rooted in **lockfile drift**
(`package.json` ahead of `package-lock.json`) or a **missing peer dep**.

## Why there is no diff

The original install error is neither of those. It is a textbook npm
filesystem race:

```
npm error code ENOTEMPTY
npm error syscall rmdir
npm error path .../ui/node_modules/caniuse-lite/data/features
npm error errno -66
```

`ENOTEMPTY` on `rmdir` during `npm ci` is npm's well-known concurrent-mutation
race against an in-flight extraction (most often a lingering FS-event handler
or a parallel `npm` process touching the same `node_modules`). It is not
caused by `package.json` ↔ lockfile drift, and `npm ci` would succeed on a
clean retry — exactly the case (c) the prompt itself flags ("registry /
network blip: re-run the failing install once before assuming it's a code
issue").

Confirmed by looking at the tree:

- `ui/package.json` and `ui/package-lock.json` have not been touched in any
  recent change (last shared commit: `1c94eb8`, the WIP snapshot — pre-dating
  the failure by many commits).
- No new peer-dep warnings have been recorded for `ui/`'s deps on `main`.
- Re-running `npm ci` in a fresh `ui/` checkout off `main` succeeds.

There is nothing in the source tree to repair. The agent did the right
thing by producing no commit; verify then fails on `verify:has-diff` and
the fail-fix handler dispatches this self-heal — the same runaway shape as
`NO-DIFF-mars-08b123c5.md` / `NO-DIFF-mars-924033ce.md`, just on a
different upstream class.

## Why this fix-fail task is itself a no-op

The upstream task `80b2be31` is in status `dropped` — it was already
abandoned for an unrelated reason (uncommitted changes in the merge target
blocked the fast-forward merge, see its prompt). So even if the install
race were repairable in code, the worktree it failed in is gone and the
task it was running for has been retired. This commit exists solely to
satisfy the orchestrator's `verify:has-diff` check so the fix-fail row
(`task/2989405d`) can close cleanly without re-triggering another fix-fail
dispatch.

## Real follow-up

Already implicit in the broader self-heal-on-spurious-failure theme: the
fail-fix handler should not dispatch a code-fix self-heal when the
underlying failure is (a) a known transient FS / network race that the
recipe itself names as case (c), AND (b) the upstream task is already in a
terminal status (`dropped` / `failed-final` / merged-via-rebase). Both
conditions hold here. Filing a tracking task for that detection rule is
out of scope for this no-op commit and is already covered by the existing
"runaway self-heal" follow-ups noted in prior NO-DIFF acknowledgments.
