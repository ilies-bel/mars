# Mars as a layered npm framework: bottom-up demand-driven package extraction

## Status

Accepted

## Context

Mars is being turned into an npm-installable framework consumed by a second
project of the author's (dev mode via `npm link`, prod mode via a registry
publish). The desired product is a *layered* SDK: a consumer can start from a
bare engine and opt up the ladder toward the full platform during onboarding
(`mars init`), and can either use the official workflows or author their own.

A coupling audit (three independent explorations of the orchestrator) produced
a decisive finding:

- `@mars/workflow` (the imperative engine: `defineWorkflow`, `runWorkflow`,
  steps, stores, `AgentRuntime`, `Logger`) is **genuinely standalone**. It
  knows nothing of tasks, recovery, events, or the daemon. It is a library
  today and needs only a build pipeline to be installable.
- **Everything else is welded to one thing: the Mars task DB (`mars.db`) and
  its domain model.** `queue.ts` (~2,400 lines) and `git.ts` (~2,200 lines,
  containing both worktree operations and the ~2,000-line `runClaudeCode`
  agent wrapper) are the floor that events, recovery, agents, and the official
  workflows all stand on. All three subsystems scored 4/5 on extraction
  difficulty for the same reason.
- **Recovery is 100% application-level**, not an engine concern. The engine
  provides only step checkpoint-resume. The recovery *model* (fix-tasks,
  `task_blockers`, the zero-budget rule, the recipe registry) is operations on
  the task DB and belongs in a platform layer, not the engine.
- The official workflows (`implement-workflow.ts` et al.) are honest *clients*
  of the engine's durability API but *slaves* to orchestrator-internal domain
  logic: `implement-workflow.ts` imports from ~15 orchestrator-internal modules
  and only one from `@mars/workflow`. They cannot move to a separate package
  until the floor below them is extracted.

The consequence: the "package ladder" is the right destination, but the rungs
are **not pre-cut** — they are fused at the bottom into `queue.ts` + `git.ts`.
There is exactly one real seam today (`@mars/workflow`) and one ball of mud
(everything touching the task DB). Extraction order is therefore *forced*: the
task store and the git/worktree + agent-runtime layer must be split out before
events, recovery, agents, or the official workflows can become packages.

## Decision

1. **The framework is a dependency ladder, extracted bottom-up, demand-driven.**
   The target layering is:

   - `@mars/workflow` — bare engine (already a library; needs only a build).
   - `@mars/claude-session` — PTY Claude control (sibling; native dep).
   - **Forced floor** (must precede everything above it):
     `@mars/agent-runtime` (`runClaudeCode` + `ClaudeEvent`, pulled out of
     `git.ts`), `@mars/git-worktree` (worktree/verify/merge), `@mars/task-store`
     (the task DB + domain model, pulled out of `queue.ts`).
   - **Plumbing:** `@mars/events` (generic publish/subscribe/dispatch
     primitives only — the Mars-domain subscribers stay in the app),
     `@mars/agents` (the `WorkerConfig` registry on top of `@mars/agent-runtime`),
     `@mars/platform` (recovery + queue + action-queue + daemon).
   - **Product:** `@mars/workflows-official` (implement/triage/slice, which
     become honest library consumers once the floor exists) and the `mars` CLI
     (with `init` layer-choice and opt-in to official workflows).

   Each rung must be independently installable and depend only on rungs below
   it. Rungs are extracted **only when a real consumer needs them**, not
   speculatively — the second project's first failure decides the next rung.

2. **The orchestrator must become "just another consumer" of the ladder.** The
   honesty test for any extracted rung: the orchestrator imports it across the
   published package boundary exactly as the second project would. If the
   orchestrator can reach into internals a second project cannot, the layer is
   a fiction and the extraction is not done. Recovery being application-level
   is explicitly accepted: a consumer who wants Mars-style recovery installs
   `@mars/platform`; the bare engine offers only step resume.

3. **Recovery is a platform concern, not an engine concern.** `@mars/workflow`
   will not grow recovery primitives. The recovery model lives in
   `@mars/platform`.

4. **The published surface still follows "every change is a hard cut."** Because
   the only consumers are the author's own projects, npm publication does NOT
   trigger semver/deprecation discipline. No changesets, no migration windows,
   no compat shims — a wrong package boundary is renamed/redrawn everywhere in
   one step, exactly as for internal churn. This is a deliberate exception to
   the usual "published packages owe consumers stability" rule, valid only
   while every consumer is first-party.

5. **Build for both consumption modes from day one.** Every publishable package
   compiles to `dist/*.js` (+ `.d.ts`) and points its `exports` map at `dist`,
   so it works under plain Node for both `npm link` (dev; live propagation via
   a watch build + `prepare`) and registry publish (prod; gated by
   `prepublishOnly`). Shipping raw `.ts` and requiring consumers to run a
   TS-aware loader is rejected — it pushes a toolchain requirement onto the
   library-author audience.

## Consequences

- The single highest-leverage refactor is decomposing `git.ts` and `queue.ts`;
  nothing above the floor can be extracted until they are split, and they are
  also too large to maintain. This work happens *in-place* in the orchestrator
  first and is promoted to a package only when a consumer needs it.
- The first shippable step is small and unambiguous: build pipelines for
  `@mars/workflow` and `@mars/claude-session`. These unblock the second project
  and force standalone-correctness without designing any new boundary in the
  dark.
- Designing all six-plus boundaries up front is explicitly avoided; the second
  project is the forcing function that reveals correct seams. The hard-cut
  culture makes redrawing a wrong boundary cheap.
- `@mars/events` ships only generic primitives; consumers wanting Mars-domain
  subscribers (recovery-spawn, blocker-resolution) take `@mars/platform`. The
  `events` table's co-location with `mars.db` (for transactional atomicity) is
  a platform detail, not an engine one.
