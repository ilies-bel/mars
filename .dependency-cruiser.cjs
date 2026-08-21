/**
 * Mars — static architecture guard (root / Node side).
 *
 * Scope: `orchestrator/` + `packages/*`. The `ui/` tree has its OWN config
 * (`ui/.dependency-cruiser.cjs`) because it lives in a different module-
 * resolution universe (Vite + the `@/* -> ui/src/*` tsconfig alias). A single
 * config cannot serve both alias spaces without silently failing to resolve
 * one of them, and an unresolved alias hides the entire graph behind it.
 *
 * Run it with `npm run arch` (never `depcruise` by hand) — the wrapper in
 * `scripts/arch-guard.mjs` asserts that TypeScript was actually parsed. See
 * the TYPESCRIPT PARSING note below; without that assertion this config can
 * "pass" while having inspected almost nothing.
 *
 * ---------------------------------------------------------------------------
 * TYPESCRIPT PARSING — READ BEFORE TOUCHING THIS FILE
 * ---------------------------------------------------------------------------
 * dependency-cruiser resolves `typescript` OPTIONALLY, with a bare require
 * from inside its own package, and declares no peer dependency on it. Under
 * pnpm's isolated node_modules that resolution fails, and dependency-cruiser
 * then SILENTLY SKIPS every .ts/.tsx file instead of erroring. The symptom is
 * a cruise reporting ~17 modules instead of ~1,200 — a green check that
 * checked nothing.
 *
 * The fix lives in the root package.json as a pnpm `packageExtensions` entry
 * that grafts a `typescript` peer dependency onto dependency-cruiser. Do not
 * remove it. `npm run arch` re-asserts the module count on every run so the
 * failure mode can never be silent again.
 *
 * ---------------------------------------------------------------------------
 * THE RATCHET
 * ---------------------------------------------------------------------------
 * 28 of 49 source folders are already inside an import cycle, so `no-circular`
 * at `error` fails instantly on a clean tree. Today's violations are recorded
 * as accepted debt in `.dependency-cruiser-known-violations.json` and passed
 * back in via `--known-violations`. That file is the ratchet:
 *
 *   - a NEW cycle is not in the baseline, so `npm run arch` fails;
 *   - a FIXED cycle just leaves a stale entry behind, which is harmless;
 *   - the baseline may therefore only ever SHRINK.
 *
 * Regenerating the baseline to make a new violation go away defeats the entire
 * mechanism. See the loud warning on `arch:baseline` in package.json.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A module depends on itself transitively. Cycles make the code impossible to reason ' +
        'about incrementally, break tree-shaking, and produce partially-initialised modules at ' +
        'runtime (a cycle is the usual cause of a mystery `undefined` import at startup). ' +
        'Pre-existing cycles are parked in the known-violations baseline; this rule exists to ' +
        'stop NEW ones. Break the cycle by extracting the shared thing into a leaf module, or by ' +
        'inverting the dependency behind an interface.',
      from: {},
      to: {
        circular: true,
        // Only runtime cycles are errors. A cycle that exists solely because two modules
        // import each other's TYPES vanishes at compile time and is not a real hazard;
        // flagging those would bury the genuine cycles in noise and get this rule turned off.
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Module is not reachable from anything and reaches nothing — usually dead code left ' +
        'behind by a rename or a half-finished extraction. Warn only: an orphan is a cleanup ' +
        'prompt, not a build break.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|mts|cts|json)$', // dotfiles / tool configs
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.[^/]+\\.json$',
          '(^|/)(package|package-lock)\\.json$',
          '\\.(test|spec)\\.(ts|tsx|mts|cts|js|mjs|cjs)$', // nothing imports a test
          '^orchestrator/test/', // fixtures + harnesses, entered by the runner
          '^packages/[^/]+/test/',
          '^orchestrator/src/init/templates/', // shipped verbatim to consumers
          '^orchestrator/bin/',
          '^scripts/',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Import does not resolve to anything on disk. Left unguarded this is how a config ' +
        'silently stops seeing part of the graph.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-duplicate-dep-types',
      severity: 'warn',
      comment: 'Dependency declared more than once (e.g. both a dependency and a devDependency).',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },

    // =========================================================================
    // MODULAR-CORE BOUNDARIES (rework/modular-core)
    // =========================================================================
    // Five rules enforcing the seams the modular-core rework depends on. Each
    // is scoped to pass CLEAN on today's tree — no baseline growth — by
    // excluding the one or two files that ARE the seam (the registry/shell
    // modules a rule's own boundary requires to cross it). Widening a `from`/
    // `to` pattern here to cover more ground is welcome; widening it in a way
    // that starts failing on existing code means fixing that import, not
    // adding it to `.dependency-cruiser-known-violations.json`.

    {
      name: 'workflow-package-is-domain-agnostic',
      severity: 'error',
      comment:
        'packages/workflow is the domain-agnostic step-engine (WorkflowCtx, the flat `services` ' +
        'bag) — it knows nothing about git, Arc, or Mars. Reaching into orchestrator/ from here ' +
        'would let a "generic" engine type silently depend on one concrete host, which is exactly ' +
        'the coupling the package boundary exists to prevent. If the engine needs something ' +
        'orchestrator-shaped, the orchestrator injects it through `services` instead.',
      from: { path: '^packages/workflow/src/' },
      to: { path: '^orchestrator/' },
    },
    {
      name: 'core-no-direct-provider-impl',
      severity: 'error',
      comment:
        'core/workers/providers/* are concrete provider adapters (codex, gemini — claude\'s is ' +
        'still lib/git/claude.ts and not yet covered by this rule). `providers.ts` imports them ' +
        'to self-register into provider-registry.ts; every other consumer must go through that ' +
        'registry (getProvider/requireProvider/listProviders, or the PROVIDERS / PROVIDER_MODELS ' +
        'compat views) so a provider can be added or swapped without editing its callers.',
      from: {
        path: '^orchestrator/src/core/',
        pathNot: [
          '^orchestrator/src/core/workers/providers\\.ts$',
          '^orchestrator/src/core/workers/providers/',
          '^orchestrator/src/core/workers/provider-registry\\.ts$',
          '(^|/)__tests__/',
          '\\.(test|spec)\\.ts$',
        ],
      },
      to: { path: '^orchestrator/src/core/workers/providers/' },
    },
    {
      name: 'primitives-no-daemon-server',
      severity: 'error',
      comment:
        'Step primitives (workflows/primitives/*) are called from scaffolded `.mars/workflows/*.js` ' +
        'files as well as the bundled pipelines, and must work wherever a WorkflowCtx does — they ' +
        'may not reach into the long-running daemon process (its HTTP server, sweepers, ' +
        'reconcilers) or the sweeper/MCP servers directly. `core/daemon/config.ts` is a pure ' +
        'zod-schema config reader with no process/HTTP surface, so it is excepted; every other ' +
        'daemon module is the process itself.',
      from: {
        path: '^orchestrator/src/workflows/primitives/',
        pathNot: ['(^|/)__tests__/', '\\.(test|spec)\\.ts$'],
      },
      to: {
        path: [
          '^orchestrator/src/core/daemon/',
          '^orchestrator/src/core/sweeper/server\\.ts$',
          '^orchestrator/src/core/mcp/worker-server\\.ts$',
        ],
        pathNot: '^orchestrator/src/core/daemon/config\\.ts$',
      },
    },
    // ─────────────────────────────────────────────────────────────────────────
    // NOT HERE: the ADR-0052 sealed-service guard.
    //
    // The obvious rule to want next to these — "nothing outside the container
    // seam may `ctx.provide('store', …)`, and nothing outside it may import
    // @deepseek-ai/cordis directly" — is NOT expressible in this file, twice
    // over:
    //
    //   1. dependency-cruiser reasons about IMPORTS, never about call
    //      expressions. `ctx.provide('store', fake)` is invisible to it.
    //   2. `options.includeOnly` below pins the graph to
    //      `^(orchestrator|packages|scripts)/`, so npm packages are not in the
    //      cruised graph at all. A rule with `to: { path: '@deepseek-ai/cordis' }`
    //      would match nothing and pass silently forever — the exact failure
    //      mode the TYPESCRIPT PARSING note at the top of this file exists to
    //      prevent. Widening includeOnly to fix that would drag node_modules
    //      into every other rule.
    //
    // The guard therefore lives in vitest, alongside the ADR-0052 any-ban it is
    // a sibling of: orchestrator/src/core/__tests__/sealed-write-funnel-guard.test.ts.
    // The runtime seal itself is in packages/workflow/src/ctx/sealed.ts.
    // ─────────────────────────────────────────────────────────────────────────

    {
      name: 'verify-heuristics-no-provider-modules',
      severity: 'error',
      comment:
        'A verify heuristic (tools/verify/heuristics/*, tools/verify/selection.ts, the ' +
        'registries/verify-heuristics.ts registry) is tool-specific knowledge the verify RUNNER ' +
        'consults, not a place that dispatches work — heuristics/types.ts says so explicitly: ' +
        '"a heuristic never records a step, never touches task state, and never spawns the step ' +
        'itself". Reaching into core/workers/* (provider dispatch, provider-registry, the concrete ' +
        'provider adapters) from here would let a heuristic act like a worker instead of judging ' +
        'one. `tools/verify/review.ts` — the shell that DOES dispatch workers to retry a failing ' +
        'suite — is deliberately outside this rule\'s `from`.',
      from: {
        path: [
          '^orchestrator/src/tools/verify/heuristics/',
          '^orchestrator/src/tools/verify/selection\\.ts$',
          '^orchestrator/src/registries/verify-heuristics\\.ts$',
        ],
        pathNot: ['(^|/)__tests__/', '\\.(test|spec)\\.ts$'],
      },
      to: { path: '^orchestrator/src/core/workers/' },
    },

    {
      name: 'verifier-port-only',
      severity: 'error',
      comment:
        'Verification internals are reachable only through the Verifier Port ' +
        '(core/ports/verifier/*, ADR-0097). `core/lib/git/verify.ts` (the local subprocess gate ' +
        'runner) and `tools/verify/review.ts` (the review shell that wraps it — worktree/dirty-main ' +
        'preflight, gate selection *and* execution, fix-task dispatch, the LLM full-review path, and ' +
        'the manual-QA park) are the two concrete implementations the port fronts. Importing either ' +
        'directly from outside core/ports/verifier/ lets a caller bypass the swappable seam — e.g. a ' +
        'future remote-http Verifier binding would silently stop covering that caller. Resolve a ' +
        'Verifier through registry.ts (`resolveVerifier`/`requireVerifier`) to run gates, or — for ' +
        'the non-`run()` verify vocabulary (step specs, scope loading, worktree cleanup) — through ' +
        'the port\'s `types.ts`/`verify-helpers.ts` re-exports. `tools/verify/review.ts` is excepted ' +
        'from `from` (not just `to`): it is itself one of the two wrapped modules and legitimately ' +
        'imports helper vocabulary straight out of `verify.ts`, the same way `core-no-direct-' +
        'provider-impl` above excepts a provider\'s own self-registration module. Test files are ' +
        'excepted the same way every other rule in this section excepts them: a unit test\'s ' +
        '`vi.mock(\'.../core/lib/git/verify\', ...)` must name the concrete module\'s real resolved ' +
        'path to intercept what the port\'s `local` implementation actually calls — mocking the ' +
        'port re-export instead would not intercept anything.',
      from: {
        path: '^orchestrator/src/',
        pathNot: [
          '^orchestrator/src/core/ports/verifier/',
          '^orchestrator/src/tools/verify/review\\.ts$',
          '(^|/)__tests__/',
          '\\.(test|spec)\\.ts$',
        ],
      },
      to: {
        path: '^orchestrator/src/core/lib/git/verify\\.ts$|^orchestrator/src/tools/verify/review\\.ts$',
      },
    },

    {
      name: 'no-cli-to-core',
      severity: 'error',
      comment:
        'Tracer-bullet ratchet for the "CLI must not import orchestrator internals" boundary ' +
        '(PRD ae17340a, ADR-0056 adapter/domain split). orchestrator/src/cli/** renders output ' +
        'and parses args; importing orchestrator/src/core/** directly couples argument parsing to ' +
        'daemon/store internals that a future Port is meant to front. Unlike the disabled ' +
        'cli-no-orchestrator-internals stub below (which waits on the verifier/executor/vcs ' +
        'ports to migrate every caller before landing clean), this rule is active NOW: today\'s ' +
        'offenders are frozen in .dependency-cruiser-known-violations.json via the same ' +
        '--ignore-known baseline mechanism no-circular uses above, and scripts/arch-guard.mjs ' +
        'additionally enforces that baseline count EXACTLY (see checkCliToCoreExactRatchet there) ' +
        '— not just as a ceiling — so fixing an offender without regenerating the baseline also ' +
        'fails the guard, the same discipline the env-reads allowlist already uses. The baseline ' +
        'may only ever shrink; do not widen `to` or add path exclusions to hide a new import ' +
        'instead of routing it through a Port.',
      from: {
        path: '^orchestrator/src/cli/',
        pathNot: ['(^|/)__tests__/', '\\.(test|spec)\\.ts$'],
      },
      to: { path: '^orchestrator/src/core/' },
    },

    // =========================================================================
    // STUB — MODULAR-CORE PORT BOUNDARIES (PRD ae17340a). INTENTIONALLY
    // DISABLED. DO NOT ENABLE YET.
    // =========================================================================
    // Contract slice for ADR-0097 ("every seam is a cordis service Port with
    // serializable contracts"). Three consumer slices each thicken one of the
    // rules below by (a) building/finishing the named `core/ports/<name>/`
    // module — mirroring the existing `core/ports/{code-index,reflector,
    // verifier}/` shape (types.ts + registry.ts + one file per impl kind +
    // __tests__/serializable.test.ts) — and (b) migrating the listed current
    // callers off the internals and onto the port, then uncommenting its rule.
    //
    // Each rule is commented out, not just left un-added, because an `error`
    // rule that starts red the moment it lands would break `npm run arch` on
    // `main` for every task that branches afterward — the opposite of what an
    // owner slice landing ahead of its consumers is for. A consumer slice
    // uncomments its own rule as part of proving its own boundary; it does
    // NOT touch the others.
    //
    // Do not "fix" this by pre-populating `pathNot` with every current
    // caller: for CLI (~46 files) and the not-yet-built Executor/VCS ports
    // that defeats the rule (it would pass by excluding everything it exists
    // to catch).
    //
    // The fourth rule this stub used to describe, `no-direct-verifier-
    // internals`, is DONE and lives above as the active `verifier-port-only`
    // rule (not here, and not disabled) — its consumer slice migrated every
    // real caller (cli/commands/verify-gate.ts, tools/coder/run-agent.ts,
    // tools/merge/merge.ts, tools/verify/selection.ts,
    // workflows/primitives/shared.ts, plus one test that drove verifyChanges
    // directly) onto core/ports/verifier and landed the rule clean, with no
    // baseline seed and no pathNot carve-outs beyond the port dir, verify.ts's
    // own tests, and review.ts's documented self-import exception.

    // {
    //   name: 'cli-no-orchestrator-internals',
    //   severity: 'error',
    //   comment:
    //     'Consumer slice: "Arch-guard ratchet: CLI must not import orchestrator internals". ' +
    //     'orchestrator/src/cli/** (cli.ts, cli/dispatch.ts) is already clean; the violations are ' +
    //     'inside cli/commands/*.ts, which today reach past any port straight into core/workers/*, ' +
    //     'core/lib/git/* (verify.ts, checkpoint.ts, worktree.ts, merge.ts), and tools/verify/* — ' +
    //     'roughly 46 files (e.g. cli/commands/worker.ts, verify-gate.ts, install.ts). Because the ' +
    //     'violation count is too large for a `pathNot` carve-out and too broad for a one-off ' +
    //     'baseline seed in this owner slice, TO ENABLE: migrate cli/commands/*.ts onto the ' +
    //     'verifier/executor/vcs ports below (once built) or another stable public surface, THEN ' +
    //     'either land clean or record residual pre-existing imports as a known-violations ratchet ' +
    //     'baseline (same mechanism as no-circular above) — never widen this pathNot to hide new ' +
    //     'ones instead.',
    //   from: {
    //     path: '^orchestrator/src/cli/',
    //     pathNot: ['(^|/)__tests__/', '\\.(test|spec)\\.ts$'],
    //   },
    //   to: {
    //     path: [
    //       '^orchestrator/src/core/workers/',
    //       '^orchestrator/src/core/lib/git/',
    //       '^orchestrator/src/tools/',
    //     ],
    //   },
    // },
    // {
    //   name: 'agent-execution-through-executor-port',
    //   severity: 'error',
    //   comment:
    //     'Consumer slice: "Arch-guard: route all agent execution through the Executor port". No ' +
    //     'core/ports/executor/ module exists yet — this rule names the internals it will wrap: ' +
    //     'core/lib/git/claude.ts (runClaudeCode), core/workers/run-pty-session.ts, ' +
    //     'core/workers/providers.ts + provider-registry.ts + providers/*, core/workers/index.ts. ' +
    //     'tools/coder/run-agent.ts is today\'s de-facto dispatch shell (the review.ts-equivalent an ' +
    //     'executor implementation will wrap, per core-no-direct-provider-impl above for the ' +
    //     'provider-adapter half of this same boundary). TO ENABLE: build core/ports/executor/ ' +
    //     '(mirror core/ports/verifier/\'s shape), migrate cli/commands/worker.ts, ' +
    //     'tools/coder/coder-exit.ts, tools/verify/review.ts, and the plan/slice/triage workflows off ' +
    //     'core/workers directly, then narrow this from/to to the real remaining boundary.',
    //   from: {
    //     path: '^orchestrator/src/',
    //     pathNot: [
    //       '^orchestrator/src/core/workers/',
    //       '^orchestrator/src/core/lib/git/claude\\.ts$',
    //       '^orchestrator/src/core/ports/executor/',
    //       '^orchestrator/src/tools/coder/run-agent\\.ts$',
    //       '(^|/)__tests__/',
    //       '\\.(test|spec)\\.ts$',
    //     ],
    //   },
    //   to: {
    //     path: [
    //       '^orchestrator/src/core/lib/git/claude\\.ts$',
    //       '^orchestrator/src/core/workers/(run-pty-session|providers|provider-registry)\\.ts$',
    //       '^orchestrator/src/core/workers/providers/',
    //     ],
    //   },
    // },
    // {
    //   name: 'vcs-internals-through-port-only',
    //   severity: 'error',
    //   comment:
    //     'Consumer slice: "Arch-guard: VCS internals reachable only through the port". No ' +
    //     'core/ports/vcs/ module exists yet. Internals under core/lib/git/ this will wrap: ' +
    //     'checkpoint.ts, worktree.ts, merge.ts, commit-main.ts, commit-message.ts, lock.ts, ' +
    //     'verify-markers.ts, classify-porcelain.ts, internal.ts (verify.ts and claude.ts are the ' +
    //     'Verifier and Executor internals above, not this boundary). Today\'s fan-out is the widest ' +
    //     'of the four (tools/context.ts, tools/merge/merge.ts — the TOOL, distinct from ' +
    //     'core/lib/git/merge.ts the INTERNAL it calls — tools/coder/{run-agent,setup-worktree,' +
    //     'coder-exit}.ts, tools/verify/review.ts, tools/qa/finalize-mockup.ts, ' +
    //     'tools/report/finalize-report.ts, workflows/primitives/behaviour-verify.ts). ' +
    //     'cli/commands/{worktree,merge}.ts already go through injected CommandDeps rather than ' +
    //     'importing core/lib/git/* directly, so the CLI side of this boundary may already be clean. ' +
    //     'TO ENABLE: build core/ports/vcs/, migrate the tools/* + workflows/* callers above, then ' +
    //     'narrow this from/to to the real remaining boundary.',
    //   from: {
    //     path: '^orchestrator/src/',
    //     pathNot: ['^orchestrator/src/core/lib/git/', '(^|/)__tests__/', '\\.(test|spec)\\.ts$'],
    //   },
    //   to: {
    //     path: [
    //       '^orchestrator/src/core/lib/git/checkpoint\\.ts$',
    //       '^orchestrator/src/core/lib/git/worktree\\.ts$',
    //       '^orchestrator/src/core/lib/git/merge\\.ts$',
    //       '^orchestrator/src/core/lib/git/commit-main\\.ts$',
    //       '^orchestrator/src/core/lib/git/commit-message\\.ts$',
    //       '^orchestrator/src/core/lib/git/verify-markers\\.ts$',
    //     ],
    //   },
    // },
    // =========================================================================

    // =========================================================================
    // STUB — ADR-0056 LAYER RULES. INTENTIONALLY DISABLED. DO NOT ENABLE YET.
    // =========================================================================
    // ADR-0056 ("One library, three logical layers") specifies a downward-only
    // dependency direction:
    //
    //     adapters  ->  domain  ->  engine
    //
    //   engine   = workflow runtime, agent runtime, claude-session, git-worktree.
    //              Knows nothing of tasks/arcs. Exports step primitives.
    //   domain   = aggregates (Arc, Tree, Proposal, Action Queue, Alert),
    //              invariants, stores, events, application services.
    //              No process, no HTTP, no TTY.
    //   adapters = daemon, CLI, UI, TUI, skills. Thin; call application services.
    //
    // NONE OF THESE FOLDERS EXIST TODAY. The ADR was written and never
    // implemented, and no arch test was ever built. The rules below are the
    // arch test, pre-written against the ADR's own vocabulary, so that landing
    // the folders is the only remaining step.
    //
    // TO SWITCH ON: create the folders, move code into them, then delete the
    // comment markers around each rule below and regenerate the baseline ONCE
    // (this is the one legitimate reason to grow the baseline — the layer
    // rules are new rules, not new violations of an existing rule; record it
    // in the commit message).
    //
    // {
    //   name: 'layer-engine-is-a-leaf',
    //   severity: 'error',
    //   comment:
    //     'ADR-0056: the engine layer is the bottom of the stack. It may not reach up into ' +
    //     'domain or adapters. If the engine needs something from the domain, the domain must ' +
    //     'inject it.',
    //   from: { path: '^orchestrator/src/engine/' },
    //   to: { path: '^orchestrator/src/(domain|adapters)/' },
    // },
    // {
    //   name: 'layer-domain-no-adapters',
    //   severity: 'error',
    //   comment:
    //     'ADR-0056: domain depends downward on engine only. Reaching into adapters inverts ' +
    //     'the stack.',
    //   from: { path: '^orchestrator/src/domain/' },
    //   to: { path: '^orchestrator/src/adapters/' },
    // },
    // {
    //   name: 'layer-domain-is-pure',
    //   severity: 'error',
    //   comment:
    //     'ADR-0056: the domain layer has no process, no HTTP, and no TTY. Aggregates and ' +
    //     'application services must be callable from a test with no I/O. Move the side effect ' +
    //     'into an adapter and inject it.',
    //   from: { path: '^orchestrator/src/domain/' },
    //   to: {
    //     dependencyTypes: ['core'],
    //     path: '^(node:)?(child_process|http|https|http2|net|tls|readline|tty|cluster|worker_threads|repl)$',
    //   },
    // },
    // {
    //   name: 'layer-adapters-are-thin',
    //   severity: 'error',
    //   comment:
    //     'ADR-0055 + ADR-0056: adapters (daemon, CLI, UI, TUI, skills) are thin and call the ' +
    //     'application-service layer. They must not reach past the domain straight into engine ' +
    //     'internals.',
    //   from: { path: '^orchestrator/src/adapters/' },
    //   to: { path: '^orchestrator/src/engine/', pathNot: '^orchestrator/src/engine/index\\.ts$' },
    // },
    // =========================================================================
  ],

  options: {
    doNotFollow: {
      path: ['node_modules'],
    },

    exclude: {
      path: [
        '(^|/)node_modules/',
        '(^|/)dist/',
        '(^|/)coverage/',
        '(^|/)\\.mars/',
        '(^|/)\\.worktrees/',
        '(^|/)\\.claude/worktrees/',
        // Gitignored build output from the removed Mastra engine. Absent in a
        // fresh checkout (so CI never saw it) but ~329MB of bundled .mjs sits
        // in a working tree that ever ran the old build, and its generated
        // cycles are not this repo's architecture.
        '(^|/)\\.mastra/',
        // Consumer-facing template tree: copied verbatim by `mars init`, never
        // part of this repo's own runtime graph.
        '^orchestrator/src/init/templates/',
        // Scratch space — not architecture.
        '^scratch/',
      ],
    },

    // Keep the graph inside this repo's first-party source. Without this, a
    // single `import 'react'` drags the whole of node_modules into the report.
    includeOnly: '^(orchestrator|packages|scripts)/',

    // Full pre-compilation import graph: type-only imports ARE recorded, so the
    // cruise sees the code as written. The `no-circular` rule then narrows
    // itself back down to runtime-only cycles via `viaOnly` (see above). This
    // split is deliberate — `false` here would hide type-only edges from the
    // orphan and unresolvable rules too.
    tsPreCompilationDeps: true,

    // NO tsConfig here, deliberately.
    //
    // dependency-cruiser resolves a tsconfig's `include` globs against
    // process.cwd(), not against the tsconfig's own directory. Pointing at
    // `orchestrator/tsconfig.json` from a cruise rooted at the repo root
    // therefore hard-errors with `TS18003: No inputs were found`.
    //
    // This tree does not need it: orchestrator + packages import each other by
    // relative path and by real package name (`@mars/workflow` resolves through
    // the node_modules link back into `packages/workflow/`, and symlinks are
    // resolved to their real path so those modules stay in the graph). The one
    // `paths` entry in orchestrator/tsconfig.json remaps `@libsql/client` to a
    // TEST adapter, which we specifically do not want reflected in a runtime
    // dependency graph.
    //
    // `ui/` is the opposite case — it genuinely needs its `@/*` alias — which is
    // why it has its own config, run with cwd=ui/ so the include globs line up.

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },

    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern:
          '^(orchestrator/src/[^/]+(/[^/]+)?|packages/[^/]+/src(/[^/]+)?|scripts)',
      },
      text: { highlightFocused: true },
    },

    cache: false,
  },
};
