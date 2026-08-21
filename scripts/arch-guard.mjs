#!/usr/bin/env node
/**
 * Mars static architecture guard.
 *
 *   node scripts/arch-guard.mjs                # check   -> `npm run arch`
 *   node scripts/arch-guard.mjs --baseline     # freeze  -> `npm run arch:baseline`
 *   node scripts/arch-guard.mjs --env-baseline # freeze the process.env allowlist (see below)
 *   node scripts/arch-guard.mjs --graph        # diagram -> `npm run arch:graph`
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
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
    // Alternation is ordered most-specific-first: two levels under
    // orchestrator/src (so core/lib and core/daemon stay distinct — that is
    // where the interesting structure is), then one level, then the
    // non-src orchestrator dirs, then packages, then root scripts.
    collapse:
      '^(orchestrator/src/[^/]+/[^/]+/|orchestrator/src/[^/]+/|orchestrator/[^/]+/|packages/[^/]+/src/[^/]+/|packages/[^/]+/[^/]+/|scripts/)',
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

// =============================================================================
// CUSTOM TEXT-PATTERN RULES — the shared contract for the modular-core
// boundary rules (PRD ae17340a).
// =============================================================================
// dependency-cruiser reasons about IMPORT EDGES only. It cannot see a bare
// property read like `process.env.FOO` (not an import at all), and its
// baseline mechanism ratchets ONE whole-tree `no-circular` count, not an
// arbitrary from/to pair scoped to a single boundary rule. Three boundary
// rules the modular-core program needs are shaped that way — a text pattern,
// or an import ratchet scoped to one folder pair:
//
//   1. "no `process.env` reads outside the config loader"
//      (orchestrator/src/core/config/) is a TEXT pattern. Unlike the two
//      rules below, it is NOT a CUSTOM_RULES entry — it has its own EXACT
//      ratchet (see ENV READS CHECK below) backed by a per-file allowlist
//      file (`.arch-guard-env-allowlist.json`) instead of a single inline
//      count, so a maintainer who FIXES a read but forgets to update the
//      allowlist also fails the guard, not just one who adds a new read.
//   2. "CLI must not import orchestrator internals" is an import RATCHET:
//      orchestrator/src/cli/ already reaches into orchestrator/src/core/
//      directly in dozens of places, so the rule must start from today's
//      count and only ever shrink — the same shape as the `no-circular`
//      ratchet above, scoped to this one from/to pair instead of the whole
//      tree.
//   3. "VCS internals reachable only through the port" polices a Port
//      (ADR-0097) that does not exist on `main` yet — see the DISABLED
//      entry below, which follows the ADR-0056 stub convention already used
//      in .dependency-cruiser.cjs: the rule's shape is defined now so the
//      consumer slice only has to flip `enabled: true` once the port lands.
//
// CUSTOM_RULES is the shared contract: each of the three consumer slices
// edits (or enables) exactly one entry here and nowhere else in this file,
// so none of them collide with each other or with the runner below.
//
// Rule shape:
//   name             short id, used in output and nowhere else
//   severity         'error' (fails the build) — every rule here is a hard
//                    boundary; a text/import rule with no enforcement teeth
//                    isn't worth carrying
//   comment          printed on failure; explain WHY the boundary exists
//   pathPattern      RegExp tested against the repo-relative, forward-slash
//                    path of every scanned file — the `from` side
//   pathExclude      RegExp[] — files matching pathPattern are still skipped
//                    if any of these also match (the loader/port/tests
//                    themselves)
//   forbidPattern    RegExp (global) — occurrences in a scanned file's text
//                    are violations
//   knownViolations  ratchet floor: today's occurrence count. Omit (or 0)
//                    for a zero-tolerance rule. NEW occurrences beyond the
//                    floor fail the build; fixing occurrences down is
//                    encouraged but never required by this script — lower
//                    the floor yourself once you've shrunk it, the same
//                    discipline as the dependency-cruiser baseline.
//   enabled          false = defined but not yet enforced (the ADR-0056
//                    stub shape) — used by rule 3 above until its port
//                    exists.
const CUSTOM_RULE_SCAN_ROOTS = ['orchestrator/src'];
const CUSTOM_RULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const CUSTOM_RULE_SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.mastra']);

const CUSTOM_RULES = [
  {
    name: 'cli-no-orchestrator-internals',
    severity: 'error',
    comment:
      'orchestrator/src/cli/ is the adapter layer (ADR-0056 vocabulary): it renders output and ' +
      'parses args, then hands off. Importing orchestrator/src/core/ directly from a CLI command ' +
      'couples argument parsing to daemon/store internals and is exactly the coupling the ' +
      'adapter boundary exists to prevent. Reach the daemon through its HTTP client/RPC surface ' +
      'instead of the module that implements the other side of that call.',
    pathPattern: /^orchestrator\/src\/(cli\/|cli\.ts$)/,
    pathExclude: [/(^|\/)__tests__\//, /\.(test|spec)\.tsx?$/, /^orchestrator\/src\/cli\/test-adapter\.ts$/],
    forbidPattern: /from\s+['"](?:\.\.\/)+core\//g,
    // Measured on 69d4b45d (86), re-measured at 87 while landing the
    // `no-cli-to-core` dependency-cruiser rule below (PRD ae17340a #19) —
    // pre-existing drift unrelated to that rule, fixed here because it
    // blocked this task's own `node scripts/arch-guard.mjs` verify. This
    // ratchet starts wide because today's CLI is not yet layered — shrinking
    // it is a later consumer slice's job, not this owner slice's. Lower this
    // floor as call sites move to a client.
    knownViolations: 87,
    enabled: true,
  },
  {
    name: 'vcs-internals-only-through-port',
    severity: 'error',
    comment:
      'orchestrator/src/core/lib/git/ (worktree, merge, checkpoint, verify, claude) is the ' +
      'concrete VCS implementation. Per ADR-0097 every swappable seam is a Port; once the VCS ' +
      'Port lands at orchestrator/src/core/ports/vcs/, everything outside these two folders must ' +
      'go through it instead of importing core/lib/git/* directly, the same shape as the ' +
      'core-no-direct-provider-impl rule in .dependency-cruiser.cjs.',
    pathPattern: /^orchestrator\/src\//,
    pathExclude: [
      /^orchestrator\/src\/core\/lib\/git\//,
      /^orchestrator\/src\/core\/ports\/vcs\//,
      /(^|\/)__tests__\//,
      /\.(test|spec)\.tsx?$/,
    ],
    forbidPattern: /from\s+['"](?:\.\.\/)*core\/lib\/git\//g,
    // No known-violations floor: the VCS Port does not exist on `main` yet
    // (orchestrator/src/core/ports/ has code-index, reflector, verifier —
    // no vcs/). DISABLED until the "VCS internals reachable only through the
    // port" consumer slice creates the port; flip `enabled: true` there and
    // record the real floor at that time (today's call sites all import
    // core/lib/git/* directly, so the floor will not be zero on day one).
    enabled: false,
  },
];

/** Repo-relative, forward-slash path — the shape every CUSTOM_RULES pattern is written against. */
function toRelPosix(absPath) {
  return relative(REPO_ROOT, absPath).split('\\').join('/');
}

function walkFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!CUSTOM_RULE_SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (CUSTOM_RULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(join(dir, entry.name));
      }
    }
  }
  return out;
}

/** Find every occurrence of `rule.forbidPattern` across files matching `rule.pathPattern`. */
function scanCustomRule(rule, files) {
  const violations = [];
  for (const abs of files) {
    const rel = toRelPosix(abs);
    if (!rule.pathPattern.test(rel)) continue;
    if (rule.pathExclude?.some((p) => p.test(rel))) continue;
    const content = readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(rule.forbidPattern);
      if (!matches) continue;
      for (let m = 0; m < matches.length; m++) violations.push({ file: rel, line: i + 1 });
    }
  }
  return violations;
}

/** Run every enabled CUSTOM_RULES entry. Returns false if any rule has NEW violations. */
function runCustomRules() {
  const enabledRules = CUSTOM_RULES.filter((r) => r.enabled);
  if (enabledRules.length === 0) return true;

  const files = CUSTOM_RULE_SCAN_ROOTS.flatMap((root) => walkFiles(join(REPO_ROOT, root)));
  let ok = true;

  for (const rule of enabledRules) {
    const violations = scanCustomRule(rule, files);
    const floor = rule.knownViolations ?? 0;
    const head = `arch [custom:${rule.name}]: ${violations.length} occurrence(s) (ratchet floor ${floor})`;

    if (violations.length > floor) {
      ok = false;
      console.error(`\n  ✗ ${head}:\n`);
      for (const v of violations.slice(0, 40)) console.error(`      ${v.file}:${v.line}`);
      if (violations.length > 40) console.error(`      ... and ${violations.length - 40} more`);
      console.error(
        `\n    ${rule.comment}\n` +
          `\n    This is a RATCHET — it may only ever shrink. If you added occurrences on ` +
          `purpose, that is the bug to fix, not this floor.\n`,
      );
    } else if (violations.length < floor) {
      console.log(
        `  ✓ ${head} — shrank from ${floor}; lower knownViolations in scripts/arch-guard.mjs`,
      );
    } else {
      console.log(`  ✓ ${head}`);
    }
  }

  return ok;
}

// =============================================================================
// ENV READS CHECK — `process.env` reads outside the config loader.
// =============================================================================
// Consumer slice for CUSTOM_RULES item 1 above. Reuses the CUSTOM_RULE_*
// scan scaffolding (walkFiles/toRelPosix) but is NOT a CUSTOM_RULES entry:
// its ratchet is EXACT (per-file counts must match the allowlist exactly in
// BOTH directions), not a ceiling, so fixing a read down without updating the
// allowlist fails the guard just as adding a new one does. That is the only
// way the allowlist stays a trustworthy map of where the remaining 103-file
// sprawl actually lives, instead of a stale number nobody drains.
const ENV_ALLOWLIST_PATH = join(REPO_ROOT, '.arch-guard-env-allowlist.json');
const ENV_READ_RULE = {
  pathPattern: /^orchestrator\/src\//,
  pathExclude: [/^orchestrator\/src\/core\/config\//, /(^|\/)__tests__\//, /\.(test|spec)\.tsx?$/],
  forbidPattern: /\bprocess\.env\b/g,
};

/** Occurrence count of `process.env` per repo-relative file, outside the config loader. */
function scanEnvReadsByFile() {
  const files = CUSTOM_RULE_SCAN_ROOTS.flatMap((root) => walkFiles(join(REPO_ROOT, root)));
  const counts = {};
  for (const abs of files) {
    const rel = toRelPosix(abs);
    if (!ENV_READ_RULE.pathPattern.test(rel)) continue;
    if (ENV_READ_RULE.pathExclude.some((p) => p.test(rel))) continue;
    const content = readFileSync(abs, 'utf8');
    const matches = content.match(ENV_READ_RULE.forbidPattern);
    if (matches && matches.length > 0) counts[rel] = matches.length;
  }
  return counts;
}

/**
 * `{ violations, declaredTotal }`, or null when the allowlist file is absent.
 * `declaredTotal` is the file's own `totalViolations` header (null if absent or
 * non-numeric); `checkEnvReads()` cross-checks it against the per-file map so a
 * hand-edit that drains a site but forgets the header cannot pass silently.
 */
function loadEnvAllowlist() {
  if (!existsSync(ENV_ALLOWLIST_PATH)) return null;
  const parsed = JSON.parse(readFileSync(ENV_ALLOWLIST_PATH, 'utf8'));
  return {
    violations: parsed.violations ?? {},
    declaredTotal: typeof parsed.totalViolations === 'number' ? parsed.totalViolations : null,
  };
}

const sumCounts = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/**
 * Compare today's `process.env` reads (outside the config loader) against
 * `.arch-guard-env-allowlist.json`. Unlike `runCustomRules()`, this is an
 * EXACT ratchet: a file whose actual count is LOWER than the recorded count
 * fails just as one whose count is HIGHER does — so shrinking the sprawl
 * without updating the allowlist is caught, not silently accepted.
 */
function checkEnvReads() {
  const allowlist = loadEnvAllowlist();
  if (allowlist === null) {
    console.error(
      `\n  ✗ arch [env-reads]: missing ${relative(REPO_ROOT, ENV_ALLOWLIST_PATH)}.\n` +
        `\n    This file is the ratchet for \`process.env\` reads outside ` +
        `orchestrator/src/core/config/. Regenerate it with ` +
        `\`node scripts/arch-guard.mjs --env-baseline\` if this is a first setup.\n`,
    );
    return false;
  }

  const recorded = allowlist.violations;
  const recordedTotal = sumCounts(recorded);

  // The file's own header must agree with its per-file map. Draining a site by
  // hand-editing `violations` without lowering `totalViolations` would otherwise
  // leave the allowlist quietly self-contradicting, and the `allowlist total`
  // printed below (computed from the map) would disagree with the file on disk.
  if (allowlist.declaredTotal !== null && allowlist.declaredTotal !== recordedTotal) {
    console.error(
      `\n  ✗ arch [env-reads]: ${relative(REPO_ROOT, ENV_ALLOWLIST_PATH)} is self-inconsistent:\n` +
        `\n      totalViolations says ${allowlist.declaredTotal}, but its own ` +
        `\`violations\` map sums to ${recordedTotal}.\n` +
        `\n    The header and the per-file map must agree. Regenerate the allowlist with ` +
        `\`node scripts/arch-guard.mjs --env-baseline\` rather than hand-editing it.\n`,
    );
    return false;
  }

  const actual = scanEnvReadsByFile();
  const actualTotal = sumCounts(actual);
  const allFiles = new Set([...Object.keys(recorded), ...Object.keys(actual)]);
  const newSites = [];
  const staleSites = [];

  for (const file of allFiles) {
    const rec = recorded[file] ?? 0;
    const act = actual[file] ?? 0;
    if (act > rec) newSites.push({ file, recorded: rec, actual: act });
    else if (act < rec) staleSites.push({ file, recorded: rec, actual: act });
  }

  const head = `arch [env-reads]: ${actualTotal} occurrence(s) (allowlist total ${recordedTotal})`;

  if (newSites.length === 0 && staleSites.length === 0) {
    console.log(`  ✓ ${head}`);
    return true;
  }

  console.error(`\n  ✗ ${head}:\n`);
  for (const s of newSites) {
    console.error(`      NEW      ${s.file}: ${s.actual} occurrence(s), allowlist says ${s.recorded}`);
  }
  for (const s of staleSites) {
    console.error(`      STALE    ${s.file}: ${s.actual} occurrence(s), allowlist says ${s.recorded}`);
  }
  console.error(
    `\n    Reading \`process.env\` directly scatters environment-variable knowledge across the ` +
      `codebase and makes every read un-injectable in tests. \`orchestrator/src/core/config/\` ` +
      `(load.ts, levers.ts, env-registry.ts) is the one place allowed to read it; everywhere else ` +
      `receives config as a value (ControlLevers, a loaded config object, an injected \`opts.env\`).\n` +
      `\n    NEW sites are reads not yet in the allowlist — route them through the config loader ` +
      `instead of adding another one.\n` +
      `    STALE sites are recorded at a HIGHER count than what's actually there — this ratchet is ` +
      `EXACT, not a ceiling: regenerate the allowlist with ` +
      `\`node scripts/arch-guard.mjs --env-baseline\` to lock the shrink in.\n`,
  );
  return false;
}

/** Regenerate `.arch-guard-env-allowlist.json` from today's actual `process.env` reads. */
function envBaseline() {
  const beforeTotal = sumCounts(loadEnvAllowlist()?.violations ?? {});

  const actual = scanEnvReadsByFile();
  const afterTotal = sumCounts(actual);

  const sortedViolations = Object.fromEntries(
    Object.keys(actual)
      .sort()
      .map((file) => [file, actual[file]]),
  );

  writeFileSync(
    ENV_ALLOWLIST_PATH,
    JSON.stringify(
      {
        _comment:
          'Ratchet for `process.env` reads outside orchestrator/src/core/config/ ' +
          '(scripts/arch-guard.mjs checkEnvReads()). EXACT match, not a ceiling: `arch` fails if ' +
          'any file\'s actual count differs from what is recorded here, in EITHER direction — fix a ' +
          'read and regenerate this file (`node scripts/arch-guard.mjs --env-baseline`) in the same ' +
          'change. Counts are occurrences, not lines — a line with two reads counts twice.',
        totalViolations: afterTotal,
        violations: sortedViolations,
      },
      null,
      2,
    ) + '\n',
  );

  const delta = afterTotal - beforeTotal;
  const arrow = delta > 0 ? `GREW by ${delta}  <-- REVIEW THIS` : delta < 0 ? `shrank by ${-delta}` : 'unchanged';
  console.log(
    `  env-reads: ${beforeTotal} -> ${afterTotal} occurrences (${arrow})\n` +
      `  wrote ${relative(REPO_ROOT, ENV_ALLOWLIST_PATH)}\n`,
  );
}

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

    // EXACT RATCHET for `no-cli-to-core` (root tree only — the rule's `from`
    // is scoped to orchestrator/src/cli/). Unlike no-circular above, whose
    // --ignore-known baseline tolerates silent shrink ("a FIXED cycle just
    // leaves a stale entry behind, which is harmless"), this boundary's
    // baseline must track reality exactly: fixing an offender without
    // regenerating .dependency-cruiser-known-violations.json is itself a
    // guard failure — the same discipline checkEnvReads() below already
    // applies to the env-reads allowlist.
    if (tree.name === 'root' && existsSync(baselinePath)) {
      const CLI_TO_CORE_RULE = 'no-cli-to-core';
      const baselineEntries = JSON.parse(readFileSync(baselinePath, 'utf8'));
      const baselineCount = (Array.isArray(baselineEntries) ? baselineEntries : []).filter(
        (v) => v.rule?.name === CLI_TO_CORE_RULE,
      ).length;
      const liveCount = (summary.violations ?? []).filter(
        (v) => v.rule?.name === CLI_TO_CORE_RULE,
      ).length;

      if (liveCount !== baselineCount) {
        ok = false;
        console.error(
          `\n  ✗ arch [${CLI_TO_CORE_RULE}]: ${liveCount} offender(s) found, but ` +
            `${tree.baseline} records ${baselineCount}.\n` +
            `\n    This ratchet is EXACT, not a ceiling: a mismatch in EITHER direction fails —\n` +
            `    fixed an offender without regenerating the baseline, or added a new\n` +
            `    orchestrator/src/cli -> orchestrator/src/core import without recording it. Run\n` +
            `    \`npm run arch:baseline\` in the same change that fixes or adds one.\n`,
        );
      } else {
        console.log(
          `  ✓ arch [${CLI_TO_CORE_RULE}]: ${liveCount} offender(s), matches baseline exactly`,
        );
      }
    }
  }

  if (totalModules < 1000) {
    console.error(
      `\n  ✗ arch: only ${totalModules} modules inspected across all trees. ` +
        `TypeScript is very likely not being parsed.\n`,
    );
    ok = false;
  }

  if (!runCustomRules()) ok = false;
  if (!checkEnvReads()) ok = false;

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
else if (mode === '--env-baseline') envBaseline();
else if (mode === undefined || mode === '--check') check();
else {
  console.error(
    `arch-guard: unknown mode "${mode}". Use --check (default), --baseline, --env-baseline, or --graph.`,
  );
  process.exit(2);
}
