/**
 * Mars — static architecture guard (ui / browser side).
 *
 * WHY THIS IS A SEPARATE CONFIG FROM THE ROOT ONE
 * -----------------------------------------------
 * `ui/` resolves `@/*` to `ui/src/*` via `ui/tsconfig.json`. dependency-cruiser
 * reads a tsconfig's `include` globs relative to process.cwd() rather than to
 * the tsconfig's own directory, so this config only works when the cruise is
 * run with cwd = `ui/`. The root config, run from the repo root, cannot also
 * adopt this tsconfig — it would either hard-error (TS18003) or, worse, leave
 * every `@/...` import unresolved. An unresolved alias does not fail loudly: it
 * silently drops the entire subgraph behind it, which would hide all of ui/
 * from the guard.
 *
 * Hence two configs and two cruises, stitched together by
 * `scripts/arch-guard.mjs`. `npm run arch` (at the repo root) runs both.
 *
 * `not-to-unresolvable` is at `error` here specifically so that a broken alias
 * can never degrade into a vacuous pass.
 *
 * THE RATCHET: today's violations are frozen in
 * `ui/.dependency-cruiser-known-violations.json`. New cycles fail; the baseline
 * may only shrink. See the root config and `arch:baseline` in package.json.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A module depends on itself transitively. In a React tree this shows up as a component ' +
        'that is `undefined` on first render for no visible reason. Pre-existing cycles are ' +
        'parked in the known-violations baseline; this rule exists to stop NEW ones.',
      from: {},
      to: {
        circular: true,
        // Runtime cycles only — a type-only cycle disappears at compile time.
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Module is not reachable from anything and reaches nothing — usually a component left ' +
        'behind by a redesign. Warn only.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|mts|cts|json)$',
          '\\.d\\.ts$',
          '(^|/)(vite|vitest)\\.config\\.ts$',
          // Split in two on purpose: `(^|/)tsconfig(\.[^/]+)?\.json$` nests a
          // quantifier inside an optional group, which dependency-cruiser's
          // safe-regex check rejects outright ("unsafe regular expression.
          // Bailing out.") rather than warning about.
          '(^|/)tsconfig\\.json$',
          '(^|/)tsconfig\\.[^/]+\\.json$',
          '\\.(test|spec)\\.(ts|tsx|mts|cts|js|mjs|cjs)$',
          '^src/(main|vite-env)\\.',
          '^scripts/',
          '^bin/',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Import does not resolve. Load-bearing here: if the `@/* -> src/*` alias ever stops ' +
        'working, EVERY aliased import becomes unresolvable and this rule screams instead of ' +
        'the guard quietly inspecting nothing.',
      from: {},
      to: { couldNotResolve: true },
    },

    // =========================================================================
    // STUB — ADR-0056 / ADR-0055 LAYER RULE. INTENTIONALLY DISABLED.
    // =========================================================================
    // ADR-0055: displays are thin adapters over ONE application-service layer.
    // ADR-0056: adapters -> domain -> engine, downward only. The UI is an
    // adapter, so it must talk to application services and never reach into
    // domain internals or the engine.
    //
    // The target folders DO NOT EXIST YET — the ADRs were written and never
    // implemented, and no arch test was ever built. Enable this rule when the
    // layer folders land, then regenerate the baseline ONCE and say so in the
    // commit message.
    //
    // {
    //   name: 'ui-is-a-thin-adapter',
    //   severity: 'error',
    //   comment:
    //     'ADR-0055/ADR-0056: the UI is an adapter. It consumes the application-service layer ' +
    //     '(over HTTP or via its published client) and must not import domain aggregates or ' +
    //     'engine internals directly.',
    //   from: { path: '^src/' },
    //   to: { path: '^[.][.]/orchestrator/src/(domain|engine)/' },
    // },
    // =========================================================================
  ],

  options: {
    doNotFollow: { path: ['node_modules'] },

    exclude: {
      path: [
        '(^|/)node_modules/',
        '(^|/)dist/',
        '(^|/)coverage/',
        '(^|/)\\.mars/',
      ],
    },

    // First-party ui source only. Paths are relative to cwd, which MUST be ui/.
    includeOnly: '^(src|server|scripts)/',

    tsPreCompilationDeps: true,

    // The whole reason this config exists. `baseUrl: "."` + `paths: {"@/*": ["src/*"]}`.
    tsConfig: {
      fileName: 'tsconfig.json',
    },

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'browser', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'browser', 'main', 'types', 'typings'],
    },

    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
      archi: { collapsePattern: '^(src/[^/]+(/[^/]+)?|server|scripts)' },
      text: { highlightFocused: true },
    },

    cache: false,
  },
};
