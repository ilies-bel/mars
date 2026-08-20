# Baseline repair resolves version-pin defects deterministically, never via agent guess

## Context

The baseline repair actor (`orchestrator/src/core/lib/baseline-repair.ts`,
ADR-0040-adjacent leaf-node privilege to commit dependency-manifest fixes
straight to the integration branch) originally ran a single free-form
repair-agent for every install-failure defect class it saw, including an
unsatisfiable manifest version pin (`ETARGET` / "No matching version found
for X@Y"). The incident that motivated this: a merged commit pinned
`packages/demo/package.json`'s `@types/react-dom` to `^18.3.18`, a version
that was never published, while four sibling manifests in the same repo
already correctly pinned `^18.3.5`.

For that defect class the correct fix is mechanical and human-obvious:
resolve to the nearest published version, preferring whatever a sibling
manifest in the same repo already pins. Handing that decision to a
free-form agent means the replacement version number that lands on the
integration branch — unattended, with no worktree, no review — is whatever
the agent happened to guess. That is unverifiable and untestable, and it is
exactly the kind of decision this actor's other constraints (file
allowlist, diff-size cap, verify-before-commit, one-attempt-then-escalate)
exist to keep out of agent hands.

## Decision

`baseline-version-resolver.ts` implements the resolution as a pure,
dependency-free algorithm, not an agent call:

1. `parseUnsatisfiablePin` recognizes the npm/pnpm/yarn-classic
   "no matching version" failure text and extracts the offending package
   name and requested range.
2. `resolveManifestVersion` resolves it in strict priority order — a
   sibling manifest's pin IF it is itself a published version, otherwise
   the published version with the smallest weighted (major, minor, patch)
   distance to the requested one (ties broken toward the lower version) —
   and returns `{ status: 'unresolved' }`, never a guess, when neither
   tier produces an answer.
3. `baseline-repair.ts` calls this resolver BEFORE the free-form
   repair-agent whenever the probe output names an unsatisfiable pin. On a
   resolved outcome it rewrites the manifest itself
   (`replaceDependencyRange`) and the agent is never invoked for that
   defect class. On `unresolved`, or when no tracked manifest pins the
   exact offending range, it escalates to a human
   (`unresolvable-version` / `unlocatable-manifest-pin`) instead of
   falling through to the agent. Every other install-failure defect class
   (lockfile/manifest disagreement, a moved dependency, …) is unaffected
   and still goes through the repair-agent.

## Consequences

- The version number that lands on the integration branch for this defect
  class is always the output of an algorithm whose behavior is asserted
  directly in `baseline-version-resolver.test.ts` — never an agent's
  free-form choice.
- Widening the resolver's two tiers (e.g. adding a third fallback, or
  relaxing what counts as a "sibling") is a deliberate, reviewable change
  to this ADR's decision, not a prompt tweak.
- This ADR documents only the version-resolution decision. The baseline
  repair actor's broader design — the file allowlist, diff-size cap, and
  one-attempt-then-escalate privilege model — was implemented directly in
  `baseline-repair.ts` but was never separately written up as an ADR; see
  the draft proposal filed alongside this one.
