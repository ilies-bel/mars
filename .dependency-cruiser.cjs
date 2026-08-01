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
