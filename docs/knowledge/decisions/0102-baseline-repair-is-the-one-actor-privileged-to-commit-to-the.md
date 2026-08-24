# Baseline repair is the one actor privileged to commit to the integration branch

## Status

Accepted. Supplements ADR-0096, which covers only the deterministic
version-pin resolution inside this actor and explicitly defers the actor's
broader design to "an ADR that does not yet exist". This is that ADR.

## Context

Every task branches off the integration branch, so a dependency defect that
lands on it (the motivating incident: a merged commit pinning
`@types/react-dom` to a version that was never published, producing
`ETARGET / No matching version found`) is inherited by every subsequent
worktree at once.

Nothing in the system could fix that. `tools/coder/setup-worktree.ts` does
call `repairInstallInPlace(...)` on a `WorktreeInstallError`, but it
reconciles the *lockfile*, not the *manifest*, and its branch-safety guard
correctly refuses to let a repair commit land anywhere other than the task's
own branch. So the only useful fix was attempted in N worktrees and thrown
away N times, while the baseline dispatch pause
(`src/core/daemon/baseline-health.ts`, `pause-state.ts`) held the queue
still and waited for a human.

The gap was structural: there was no actor allowed to fix the integration
branch. Granting that privilege is the decision — and the constraints on it
are what make it grantable at all.

## Decision

**One actor holds the privilege.** `src/core/lib/baseline-repair.ts`
(`createBaselineRepairer`) is the only code path allowed to commit to the
integration branch without going through a task worktree and the merge gate.
Its shape is `probe → resolve-or-repair-agent → verify → commit`.

**It runs in place on the integration checkout.** No worktree is carved and
no branch is created; the Fixer Worker is dispatched with `cwd` set to the
repo root itself. A worktree was rejected precisely because the defect *is*
the baseline: repairing a copy reproduces the problem the guard in
`setup-worktree.ts` already names — the fix would land somewhere that is not
the integration branch. Running in place is the privilege, and it is why the
bounds below are enforced in code rather than in a prompt.

**Five bounds, all in code:**

1. **File allowlist** (`BASELINE_REPAIR_ALLOWLIST`) — dependency manifests
   and lockfiles only, matched on basename so workspace packages are covered
   without enumerating paths. `.env` and `.mars/` are structurally
   unreachable. Widening the list is widening the privilege.
2. **Diff-size cap** (`defaultMaxDiffLines`, 5000, env-overridable) — beyond
   it the repair is reverted and escalated.
3. **Verify before commit** — the commit happens only after a clean frozen
   install actually passes at the repaired tree. The agent's say-so is never
   sufficient.
4. **One attempt, then a human** — mirroring ADR-0040's leaf-node rule for
   recovery tasks, a baseline repair is itself non-recoverable. A second
   attempt against the same install signature is refused
   (`attempt-exhausted`); dispatch stays paused and exactly one actionable
   action-queue item names the repo, the signature and the failing manifest.
5. **Never `git push`** — the actor shells out to git for status, diff,
   checkout, clean, add, commit and rev-parse. Nothing else.

Every refusal path leaves the integration branch byte-identical to how the
repair found it, leaves dispatch paused, and raises exactly one
action-queue item.

**Where it is triggered.** `src/core/daemon/baseline-repair-wiring.ts`
supplies the real dependencies (git via `execProbe` at the repo root,
`node:fs/promises` scoped to the repo root, `npm view <pkg> versions --json`
for published versions, the Fixer Worker run in place, the real action queue
and the daemon's shared `PauseController`). `server.ts` constructs the
repairer once at startup, alongside the baseline health checker, and fires
`.repair()` at exactly the two moments the health checker reports the
integration branch poisoned: **at daemon startup** (before `reconcile()`
triggers the first `drain()`) and **after a merge** poisons the baseline.

Repair is *event-driven off the pause, not a timer*: the health checker is
already the single place that decides "poisoned", so hanging repair off its
verdict keeps one source of truth. A periodic re-attempt would also
contradict bound 4 — one attempt per install signature, then a human.

Repair does **not** get an entry in the daemon's per-kind worker-pool
semaphores. A single in-flight boolean guards it instead: baseline repairs
are rare (one per poisoning incident), are never worth running in parallel,
and the guard exists only so a startup trigger racing a same-tick post-merge
event cannot both pass the one-attempt ledger's read-then-write across an
await.

`listPublishedVersions` degrades to `[]` on any registry, timeout or parse
failure. Per the module's contract an empty array means "no data", not
"nothing is published", so `resolveManifestVersion` reports `unresolved`
rather than guessing — a registry outage can only produce a more
conservative escalation, never a wrong version on the integration branch.

## Consequences

- The class of incident that motivated this (an unsatisfiable pin merged
  into the baseline) is now repaired unattended, and the dispatch pause is
  cleared by the repairer itself — but only after a real install passes.
  `server.ts` re-runs the health check after a successful repair so
  `isBaselinePoisoned()` and the pause agree.
- The privilege is auditable as a fixed set of bounds rather than as agent
  behaviour. Every one of them is asserted directly in
  `__tests__/baseline-repair.test.ts` against injected dependencies.
- Anything the actor cannot fix inside those bounds becomes a human's
  problem quickly and exactly once, with dispatch still paused — the
  failure mode is "stops and asks", never "commits something unreviewed to
  the baseline".
- A defect class outside the allowlist (a broken source file merged into the
  baseline, say) is deliberately still not auto-repairable. Extending the
  actor there is a new decision against this ADR, not a configuration
  change.
