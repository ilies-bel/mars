#!/usr/bin/env node
/**
 * Mars static architecture guard.
 *
 *   node scripts/arch-guard.mjs            # check   -> `npm run arch`
 *   node scripts/arch-guard.mjs --baseline # freeze   -> `npm run arch:baseline`
 *   node scripts/arch-guard.mjs --graph    # diagram  -> `npm run arch:graph`
 *
 * WHY A WRAPPER INSTEAD OF CALLING `depcruise` TWICE FROM package.json
 * --------------------------------------------------------------------
 * Three reasons, each of which is a way the guard would otherwise pass while
 * checking nothing:
 *
 * 1. TYPESCRIPT MAY NOT BE PARSED AT ALL. dependency-cruiser resolves
 *    `typescript` optionally, with a bare require from inside its own package,
 *    and declares no peer dependency on it. Under pnpm's isolated node_modules
 *    that resolution fails — and dependency-cruiser then SILENTLY SKIPS every
 *    .ts/.tsx file rather than erroring. A cruise of this repo reports ~1,034
 *    modules when it is working and ~17 when it is not, and BOTH exit 0. The
 *    root package.json carries a pnpm `packageExtensions` entry that grafts the
 *    peer dependency on; this script re-asserts the module count on every run
 *    so that if the entry is ever dropped, the guard fails loudly instead of
 *    turning into a no-op green check.
 *
 * 2. THE JSON REPORTER ALWAYS EXITS 0. Verified on dependency-cruiser 18.1.0:
 *    a cruise with 36 error-severity violations still exits 0 under
 *    `--output-type json`. We need JSON (for the module count), so the
 *    pass/fail decision is computed here from `summary.error` instead of being
 *    inherited from the child's exit code.
 *
 * 3. TWO CONFIGS, TWO ALIAS SPACES. `ui/` resolves `@/* -> ui/src/*` through
 *    `ui/tsconfig.json`, and dependency-cruiser reads a tsconfig's `include`
 *    globs relative to process.cwd(). So the ui cruise MUST run with cwd=ui/,
 *    and the root cruise must not use that tsconfig at all. Each tree gets its
 *    own cruise; this script joins the results into one verdict.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The real ESM entry point, NOT `node_modules/.bin/depcruise` — that one is a
// shell wrapper, and handing it to `process.execPath` makes Node try to parse
// `basedir=$(dirname ...)` as JavaScript. Under pnpm `node_modules/dependency-cruiser`
// is a symlink into the virtual store, which resolves fine.
const DEPCRUISE = join(
  REPO_ROOT,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruise.mjs',
);

/**
 * MODULE-COUNT FLOORS — the anti-vacuous-pass assertion (see reason 1 above).
 *
 * These are FLOORS, not exact counts, set well below the real figures measured
 * on 69d4b45d so that ordinary file churn never trips them:
 *
 *     root : 1,034 modules / 3,434 dependencies   -> floor 900
 *     ui   :   324 modules /   751 dependencies   -> floor 250
 *
 * If a cruise drops below its floor, the overwhelmingly likely cause is that
 * TypeScript stopped being parsed, NOT that 13% of the codebase was deleted.
 * Raise a floor when the tree genuinely grows; only lower one alongside a
 * deletion you can point at in the same commit.
 */
const TREES = [
  {
    name: 'root',
    label: 'orchestrator + packages',
    cwd: REPO_ROOT,
    config: '.dependency-cruiser.cjs',
    baseline: '.dependency-cruiser-known-violations.json',
    targets: ['orchestrator', 'packages', 'scripts'],
    minModules: 900,
    // Folder granularity for the graph: orchestrator/src/<area>/<subarea>,
    // packages/<pkg>/src, scripts.
    collapse: '^(orchestrator/src/[^/]+/[^/]+/|orchestrator/src/[^/]+/|packages/[^/]+/src/|scripts/)',
    graphOut: 'docs/architecture/dependency-graph-orchestrator.md',
  },
  {
    name: 'ui',
    label: 'ui',
    cwd: join(REPO_ROOT, 'ui'),
    config: '.dependency-cruiser.cjs',
    baseline: '.dependency-cruiser-known-violations.json',
    targets: ['src', 'server'],
    minModules: 250,
    collapse: '^(src/[^/]+/[^/]+/|src/[^/]+/|server/|scripts/)',
    graphOut: 'docs/architecture/dependency-graph-ui.md',
  },
];

function runDepcruise(tree, extraArgs) {
  if (!existsSync(DEPCRUISE)) {
    console.error(
      `\narch: dependency-cruiser is not installed.\n` +
        `      Run \`pnpm install\` at the repo root (${REPO_ROOT}).\n`,
    );
    process.exit(2);
  }
  const result = spawnSync(
    process.execPath,
    [DEPCRUISE, '--config', tree.config, ...extraArgs, ...tree.targets],
    { cwd: tree.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) {
    console.error(`arch [${tree.name}]: failed to run depcruise:`, result.error.message);
    process.exit(2);
  }
  return result;
}

function cruiseToJson(tree, extraArgs = []) {
  const result = runDepcruise(tree, ['--output-type', 'json', ...extraArgs]);
  if (!result.stdout || !result.stdout.trim().startsWith('{')) {
    console.error(`\narch [${tree.name}]: depcruise produced no JSON. stderr follows:\n`);
    console.error(result.stderr || '(empty)');
    process.exit(2);
  }
  return JSON.parse(result.stdout);
}

/** Assert TypeScript was actually parsed. See reason 1 in the header. */
function assertParsed(tree, summary) {
  if (summary.totalCruised >= tree.minModules) return true;
  console.error(
    `\n  ✗ arch [${tree.name}]: cruise inspected only ${summary.totalCruised} modules ` +
      `(floor is ${tree.minModules}).\n` +
      `\n    This almost always means dependency-cruiser could not resolve \`typescript\`\n` +
      `    and silently skipped every .ts/.tsx file, rather than that the tree shrank.\n` +
      `\n    Check that the root package.json still contains:\n` +
      `\n        "pnpm": { "packageExtensions": {\n` +
      `            "dependency-cruiser": { "peerDependencies": { "typescript": "*" } } } }\n` +
      `\n    ...then re-run \`pnpm install\` at the repo root.\n`,
  );
  return false;
}

function printViolations(tree, violations) {
  const shown = violations.slice(0, 40);
  for (const v of shown) {
    const where = v.from === v.to ? v.from : `${v.from} -> ${v.to}`;
    const cycle = v.cycle
      ? '\n        cycle: ' + v.cycle.map((c) => (typeof c === 'string' ? c : c.name)).join(' -> ')
      : '';
    console.error(`      ${v.rule.severity} ${v.rule.name}: ${where}${cycle}`);
  }
  if (violations.length > shown.length) {
    console.error(`      ... and ${violations.length - shown.length} more`);
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
function check() {
  let ok = true;
  let totalModules = 0;

  for (const tree of TREES) {
    const baselinePath = join(tree.cwd, tree.baseline);
    // The flag is `--ignore-known`, NOT `--known-violations` (that is the name
    // used in the docs' prose; the CLI rejects it with `unknown option`).
    const args = existsSync(baselinePath) ? ['--ignore-known', tree.baseline] : [];
    if (args.length === 0) {
      console.error(
        `arch [${tree.name}]: no baseline at ${tree.baseline} — every pre-existing ` +
          `violation will be reported. Run \`npm run arch:baseline\` if this is a first setup.`,
      );
    }

    const { summary } = cruiseToJson(tree, args);
    totalModules += summary.totalCruised;

    if (!assertParsed(tree, summary)) {
      ok = false;
      continue;
    }

    const live = (summary.violations ?? []).filter((v) => v.rule.severity !== 'ignore');
    const errors = live.filter((v) => v.rule.severity === 'error');
    const warns = live.filter((v) => v.rule.severity === 'warn');
    const accepted = summary.ignore ?? 0;

    const head =
      `arch [${tree.name}] ${tree.label}: ${summary.totalCruised} modules, ` +
      `${summary.totalDependenciesCruised} dependencies, ` +
      `${accepted} accepted (baseline)`;

    if (errors.length > 0) {
      ok = false;
      console.error(`\n  ✗ ${head}, ${errors.length} NEW error(s):\n`);
      printViolations(tree, errors);
      console.error(
        `\n    These are NEW — they are not in ${tree.baseline}.\n` +
          `    Fix the cycle. Do NOT run \`npm run arch:baseline\` to make this go away;\n` +
          `    the baseline is a ratchet and is only ever allowed to shrink.\n`,
      );
    } else {
      console.log(`  ✓ ${head}, 0 new errors`);
    }

    if (warns.length > 0) {
      console.log(`    ${warns.length} warning(s) (non-blocking):`);
      printViolations(tree, warns);
    }
  }

  if (totalModules < 1000) {
    console.error(
      `\n  ✗ arch: only ${totalModules} modules inspected across all trees. ` +
        `TypeScript is very likely not being parsed.\n`,
    );
    ok = false;
  }

  if (!ok) {
    console.error('\narch: FAILED\n');
    process.exit(1);
  }
  console.log(`\narch: OK — ${totalModules} modules inspected, no new violations.\n`);
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------
/** The baseline reporter emits a FLAT ARRAY of violations, not a cruise result. */
function countBaseline(path) {
  if (!existsSync(path)) return 0;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed.length : (parsed.summary?.violations ?? []).length;
}

function baseline() {
  console.log(
    '\n' +
      '  ┌──────────────────────────────────────────────────────────────────────────┐\n' +
      '  │  REGENERATING THE ARCHITECTURE BASELINE                                  │\n' +
      '  │                                                                          │\n' +
      '  │  This file is a RATCHET. It exists to record cycles that already existed │\n' +
      '  │  so that NEW ones fail the build. Regenerating it to ADD entries — i.e.  │\n' +
      '  │  to silence a violation you just introduced — defeats the whole point    │\n' +
      '  │  and is FORBIDDEN.                                                       │\n' +
      '  │                                                                          │\n' +
      '  │  The ONLY legitimate reasons to run this:                                │\n' +
      '  │    * you FIXED cycles and want the stale entries dropped (shrinks);      │\n' +
      '  │    * you enabled a genuinely NEW rule (e.g. the ADR-0056 layer stubs),   │\n' +
      '  │      in which case say so explicitly in the commit message.              │\n' +
      '  │                                                                          │\n' +
      '  │  Reviewers: a diff that GROWS this file is a red flag. Check the entry   │\n' +
      '  │  count printed below against the committed version before approving.     │\n' +
      '  └──────────────────────────────────────────────────────────────────────────┘\n',
  );

  for (const tree of TREES) {
    const baselinePath = join(tree.cwd, tree.baseline);
    const before = countBaseline(baselinePath);

    // Sanity-check the cruise BEFORE freezing it: baselining a cruise that
    // parsed nothing would write an empty baseline and quietly un-ratchet
    // everything the next time someone regenerates.
    const probe = cruiseToJson(tree);
    if (!assertParsed(tree, probe.summary)) {
      console.error(`arch:baseline [${tree.name}]: refusing to write a baseline from a bad cruise.`);
      process.exit(1);
    }

    // The `baseline` reporter writes to a FILE, not to stdout (`--output-to`
    // is not optional for it — `-T baseline` with no `-f` emits nothing at all).
    runDepcruise(tree, ['--output-type', 'baseline', '--output-to', tree.baseline]);
    if (!existsSync(baselinePath)) {
      console.error(`arch:baseline [${tree.name}]: no baseline written to ${tree.baseline}.`);
      process.exit(2);
    }

    const after = countBaseline(baselinePath);
    const delta = after - before;
    const arrow = delta > 0 ? `GREW by ${delta}  <-- REVIEW THIS` : delta < 0 ? `shrank by ${-delta}` : 'unchanged';
    console.log(`  ${tree.name}: ${before} -> ${after} accepted violations (${arrow})`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------
function graph() {
  for (const tree of TREES) {
    const probe = cruiseToJson(tree);
    if (!assertParsed(tree, probe.summary)) process.exit(1);

    const result = runDepcruise(tree, ['--output-type', 'mermaid', '--collapse', tree.collapse]);
    const body = (result.stdout || '').trim();
    if (!body) {
      console.error(`arch:graph [${tree.name}]: mermaid reporter produced nothing.\n${result.stderr}`);
      process.exit(2);
    }

    const outPath = join(REPO_ROOT, tree.graphOut);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `<!-- GENERATED by \`npm run arch:graph\` — do not edit by hand. -->\n` +
        `# Folder dependency graph — ${tree.label}\n\n` +
        `Collapsed to folder granularity (\`${tree.collapse}\`).\n` +
        `${probe.summary.totalCruised} modules, ${probe.summary.totalDependenciesCruised} dependencies.\n\n` +
        '```mermaid\n' +
        body +
        '\n```\n',
    );
    console.log(`  wrote ${tree.graphOut}`);
  }
}

const mode = process.argv[2];
if (mode === '--baseline') baseline();
else if (mode === '--graph') graph();
else if (mode === undefined || mode === '--check') check();
else {
  console.error(`arch-guard: unknown mode "${mode}". Use --check (default), --baseline, or --graph.`);
  process.exit(2);
}
