# Migration: Mastra → `@mars/workflow`

**Status:** draft. Author the engine first; phase the cutover.
**Goal:** retire `@mastra/*` from the orchestrator without breaking any
running task arc.

## Principles

1. **No big-bang.** The orchestrator stays green at every commit. Mastra
   and the new engine coexist behind a feature flag until the last
   workflow is migrated.
2. **One workflow at a time, smallest first.** Each migration is its own
   PR with its own verify.
3. **Two storage tables, two writers.** The new engine writes
   `workflow_runs` / `workflow_step_runs`. The legacy `tasks` table is
   untouched. `mars list` keeps working the entire time.
4. **No in-flight task left behind.** A task started under Mastra
   finishes under Mastra. Flag flips affect *new* dispatches only.
5. **Reversible until phase 5.** Until we delete Mastra, flipping the
   flag back is a one-line change.

## Surface to migrate

| Site | Type | What it does |
|---|---|---|
| `daemon/server.ts:288` | runtime | dispatches `implementWorkflow` |
| `daemon/server.ts:767` | runtime | dispatches `abExperimentWorkflow` |
| `init-workflow.ts:337` | runtime | CLI calls `initWorkflow` |
| `mastra/index.ts` | registry | registers all 7 workflows |
| `mastra/workflows/*.ts` (7 files, ~2300 LOC) | definitions | step + workflow definitions |
| `mastra/tools/*.ts` (5 files) | dead code | defined, never invoked — delete in phase 5 |
| `mastra/scorers/*.ts` | live | called from steps — keep as plain functions |
| `mastra/context.ts:48` | config | `mastra.db` path — keep until phase 5 |

Seven workflows ranked by complexity (per `grep .then\\|createStep`):

| Workflow | Steps | Complexity | Migrate order |
|---|---|---|---|
| `tdd-brief`        | linear, ~108 LOC  | trivial   | 1 |
| `plan`             | 1 step, ~111 LOC  | trivial   | 2 |
| `triage`           | 3 steps, ~161 LOC | small     | 3 |
| `slice`            | 3 steps, ~297 LOC | small     | 4 |
| `init`             | 7 steps, ~351 LOC | medium    | 5 |
| `implement`        | 4 steps, ~505 LOC | high      | 6 — flagship |
| `ab-experiment`    | 5 steps, ~623 LOC | high      | 7 |

## Phases

### Phase 0 — Engine + scaffolding (1 PR, ~2 days)

Build `packages/workflow/` per ADR 0012:

- `defineStep`, `defineWorkflow`, `runWorkflow`.
- `WorkflowStore` interface + `Sqlite3Store` reference impl.
- `AgentRuntime` interface + `HeadlessRuntime` (claude -p stream-json)
  + `TmuxRuntime` stubbed (full impl in phase 6, when `implement` needs it).
- `pinoLogger()` helper; lifecycle events wired.
- Vitest suite covers: topo sort, resume after kill, schema validation
  failure path, abort propagation, store round-trip.

**Done when:** `packages/workflow/` has green tests, no Mars imports,
publishable in isolation. No orchestrator changes yet.

### Phase 1 — Wire the dispatcher behind a feature flag (1 PR, ~1 day)

In `orchestrator/`:

- Add `MARS_WORKFLOW_ENGINE` env var (`legacy` | `mars`, default
  `legacy`).
- Implement a `WorkflowStore` adapter against the existing
  `.mars/queue.db` connection — new tables, same DB file.
- In `daemon/server.ts`, behind the flag, branch:
  ```ts
  const wf =
    process.env.MARS_WORKFLOW_ENGINE === 'mars'
      ? marsImplementWorkflow      // exists but unused yet
      : mastra.getWorkflow('implementWorkflow');
  ```
- `marsImplementWorkflow` does **not exist yet** — the branch is dead.
  This PR only proves the wiring compiles and the legacy path is
  untouched.

**Done when:** `MARS_WORKFLOW_ENGINE=legacy` runs unchanged; the `mars`
branch throws "not implemented" at startup if the workflow ID isn't
registered.

### Phase 2 — Migrate trivial workflows (`tdd-brief`, `plan`) (1 PR each)

For each:

1. Port `mastra/workflows/<name>.ts` to `mastra/workflows/<name>.mars.ts`
   using the new engine.
2. Register both. The dispatcher (or caller) picks based on the flag.
3. Add a vitest that runs the same input through both implementations
   and asserts identical outputs (golden test).
4. Flip `MARS_WORKFLOW_ENGINE=mars` in CI for these two workflow IDs
   via a per-workflow allowlist:
   ```ts
   const useNewEngine = (id: string) =>
     process.env.MARS_WORKFLOW_ENGINE === 'mars' ||
     ALLOWLIST.has(id);
   const ALLOWLIST = new Set(['tdd-brief', 'plan']);  // grows over time
   ```

**Done when:** allowlist contains the migrated IDs; legacy `.ts` file
deleted; golden tests pass.

### Phase 3 — `triage`, `slice` (1 PR each)

Same pattern. These start touching real side effects (the daemon emits
on bus events). Verify the bus events fire identically:

- Snapshot bus events on a fixture run under legacy, replay under mars,
  diff. Tolerance for timing fields; everything else exact.

### Phase 4 — `init` (1 PR)

Higher-stakes — this writes manifests to disk. Mitigations:

- Run new engine in **dry-run mode** first (writer is gated by a flag):
  log diffs, write nothing.
- Compare against legacy output for 3 reference repos (Node app, KMP
  app, generator).
- Flip allowlist only after dry-run parity for one week of internal use.

### Phase 5 — `implement` (the flagship, 1 PR + soak time)

Highest-risk. Plan:

1. Port steps. Keep the legacy file intact.
2. **Shadow-run** mode: when a task dispatches under legacy, also start
   a parallel run under the new engine in a *separate worktree*, with
   `claude -p` replaced by a no-op runtime (`NullRuntime`). This
   exercises the engine's setup → verify → merge plumbing on the same
   inputs without spending tokens.
3. Compare bus event streams. Fix divergences.
4. **Canary by task kind:** the daemon already has per-kind semaphores
   (`triage`, `implement`, `refine`, `structured-write`). Flip
   `triage` first (cheap, fast feedback), then `refine`, then
   `implement`, then `structured-write`.
5. Soak at 100% for one week before phase 6.

**Recovery recipe interaction:** the `verify:has-diff/no-commits-ahead`
recipe runs *after* the workflow throws. The new engine must surface
the same error shape (`error.code === 'verify:has-diff'`) so the recipe
keeps firing. Add a vitest for this exact error path.

**Fix-task fallout:** `handleTaskFailureWithFixTask` is called from the
verify step. In the new engine, this lives in the step's `onFailure`
hook. Keep the same signature so the integration test for fix-task
spawning stays valid.

### Phase 6 — `ab-experiment` (1 PR)

Mostly mechanical at this point — the engine is proven. The
`runVariantsStep` does internal `Promise.all` over variants; the engine
doesn't need to know.

### Phase 7 — Delete Mastra (1 PR)

When all 7 workflows are off the allowlist and have run successfully
in production for one week:

1. Delete `mastra/workflows/*.ts` legacy files.
2. Delete `mastra/tools/*.ts` (dead code).
3. Delete `mastra/index.ts` and the `Mastra` instance.
4. Remove `@mastra/*` from `package.json`. Run `npm install`.
5. Remove `MARS_WORKFLOW_ENGINE` flag and the allowlist — the engine
   is the only path.
6. Keep `.mars/mastra.db` on disk for one more release (read-only,
   ignored). Delete in the release after.
7. Update `CLAUDE.md`, `AGENTS.md`, the `mastra` skill notice.

## In-flight tasks: the hard part

A task can be running for >30 min. We must not yank Mastra mid-arc.

**Rule:** the workflow engine for a *run* is decided at dispatch time
and stored on the run row. The dispatcher reads
`MARS_WORKFLOW_ENGINE` + allowlist *once*, writes the chosen engine into
`workflow_runs.engine` (`legacy` | `mars`), and never re-evaluates. The
resume path keys off that column.

Practical implication: when you flip the allowlist or unset the env
var, in-flight runs continue on whichever engine they started on.
Only the next dispatch sees the new value.

This means phase 7 (deletion) must wait until **zero in-flight
legacy runs**. Add a guard:

```bash
mars admin engine-stats
# legacy runs: 0
# mars runs:   3
```

Refuse the phase-7 PR if legacy > 0.

## Rollback

Until phase 7:

- Per-workflow rollback: remove ID from allowlist. Next dispatch uses
  legacy.
- Global rollback: unset `MARS_WORKFLOW_ENGINE`. Allowlist still wins
  for whitelisted IDs — to *fully* roll back, also clear the allowlist
  (one-line edit, no rebuild required if we read it from env or a
  config file).

After phase 7: revert is a git revert of the deletion PR. Mastra
re-installs from lockfile. `.mars/mastra.db` is still on disk for one
release window precisely so this works.

## Verification at each phase

Every PR must include:

1. **Build green.** `npm run build` in `orchestrator/`.
2. **Vitest green.** Existing tests plus the new golden test for the
   migrated workflow.
3. **Smoke arc.** One real `mars task add` on a throwaway repo,
   end-to-end. Bus events captured under `docs/migrations/runs/`.
4. **Engine stats clean.** `mars admin engine-stats` shows the expected
   distribution.

## Open questions (decide before phase 1)

1. **Allowlist location:** env var (`MARS_WORKFLOW_ALLOWLIST=tdd-brief,plan`),
   or config file (`.mars/engine.json`)? Env var is simpler; config
   file survives env hygiene.
2. **`mars admin engine-stats` UI:** new subcommand or `mars where`
   extension?
3. **Shadow-run worktrees:** where do they live? Reuse `.worktrees/`
   with a `shadow-` prefix or a sibling `.shadow-worktrees/`?

## Out of scope for this migration

- Tmux runtime — phase-0 scaffolding only; real impl is post-migration.
- Multi-host / distributed runs — not a goal of the engine.
- `mastra.db` schema preservation — we don't read it back; one release
  of dust then deleted.
