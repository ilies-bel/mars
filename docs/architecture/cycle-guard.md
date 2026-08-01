# The static cycle guard

Import cycles are a build failure as of this change. Because the tree is
already deeply cyclic, the guard ships with a **ratchet**: today's cycles are
recorded as accepted debt, and only *new* ones fail. The recorded set may only
ever shrink.

Nothing was restructured and no cycle was fixed as part of this. This is a
guard, not a cleanup.

## Commands

| Command | What it does |
| --- | --- |
| `npm run arch` | Check. Exits non-zero on any violation not in a baseline. |
| `npm run arch:baseline` | Regenerate the baselines. **Read the warning below first.** |
| `npm run arch:graph` | Write folder-level mermaid graphs into `docs/architecture/`. |

All three run from the repo root and drive `scripts/arch-guard.mjs`.

## Why two configs

`ui/` resolves `@/*` to `ui/src/*` through `ui/tsconfig.json`, and
dependency-cruiser reads a tsconfig's `include` globs relative to
`process.cwd()` — not relative to the tsconfig's own directory. So the ui
cruise must run with `cwd = ui/`, and the root cruise cannot adopt that
tsconfig at all (it hard-errors with `TS18003: No inputs were found`).

Hence:

- `.dependency-cruiser.cjs` — `orchestrator/` + `packages/` + `scripts/`, run
  from the repo root, no tsconfig (this tree needs no path aliases).
- `ui/.dependency-cruiser.cjs` — `ui/src` + `ui/server`, run from `ui/`, with
  `tsconfig.json` for the `@/*` alias.

`scripts/arch-guard.mjs` runs both and joins them into one verdict.

An unresolved alias is the dangerous failure here: dependency-cruiser does not
error on one, it just silently drops the entire subgraph behind it. Both
configs therefore keep `not-to-unresolvable` at `error`.

## The vacuous-pass trap

dependency-cruiser resolves `typescript` **optionally**, with a bare `require`
from inside its own package, and declares no peer dependency on it. If that
resolution fails it does not error — it **silently skips every `.ts`/`.tsx`
file** and exits 0.

Measured on this repo, both outcomes are green:

| | modules cruised | exit code |
| --- | --- | --- |
| typescript resolvable | 1,035 (root) + 324 (ui) | 0 |
| typescript not resolvable | 13 (root) + 0 (ui) | 0 |

Two things defend against this:

1. Root `package.json` carries a pnpm `packageExtensions` entry grafting a
   `typescript` peer dependency onto `dependency-cruiser`, plus `typescript`
   as a root devDependency.
2. **`scripts/arch-guard.mjs` asserts a module-count floor on every run** (900
   root, 250 ui, 1,000 combined). This is the real safety net — it was tested
   by removing both typescript symlinks, and it correctly failed with
   "cruise inspected only 13 modules".

If you ever see the module count collapse, the cause is TypeScript resolution,
not a shrinking codebase.

## The ratchet

`no-circular` is at `error`, but 28 of 49 source folders are already inside an
import cycle — one strongly-connected component alone spans 22 folders. Setting
the rule to `error` with no baseline would fail every build on day one, and the
rule would be deleted within a week.

So today's violations are frozen in:

- `.dependency-cruiser-known-violations.json` — 45 entries (36 cycles, 9 orphans)
- `ui/.dependency-cruiser-known-violations.json` — 3 entries (3 orphans, 0 cycles)

and passed back to the cruise with `--ignore-known`.

> The CLI flag is `--ignore-known`. The documentation's prose calls this
> "known violations" and `--known-violations` is **not** a valid flag — it
> exits with `unknown option`.

The mechanics:

- a **new** cycle is not in the baseline → `npm run arch` fails;
- a **fixed** cycle leaves a stale entry behind → harmless;
- therefore the baseline can only ever **shrink**.

### Regenerating the baseline to add entries is forbidden

If `npm run arch` fails, you added a cycle. Break it. Running
`npm run arch:baseline` to make the failure go away defeats the entire
mechanism and is the one thing this design exists to prevent.

The only legitimate regenerations are:

1. you *fixed* cycles and want the stale entries dropped (the file shrinks); or
2. you switched on a genuinely **new** rule — e.g. the ADR-0056 layer stubs —
   in which case say so explicitly in the commit message.

Three things enforce this beyond good intentions: `arch:baseline` prints a
boxed warning and reports the before/after entry count with a `GREW by N
<-- REVIEW THIS` marker; the CI job compares each baseline's entry count
against the PR base and fails if it grew; and the failure message from
`npm run arch` says so directly.

## What is and is not guarded

**Guarded.** Runtime import cycles among first-party modules in
`orchestrator/`, `packages/`, `scripts/`, `ui/src`, `ui/server`.

**Deliberately not guarded — type-only cycles.** `no-circular` carries
`viaOnly: { dependencyTypesNot: ['type-only'] }`, so a cycle that exists purely
because two modules import each other's *types* is not an error. Those are
erased at compile time and are not a runtime hazard, and flagging them would
bury the genuine cycles in noise — the fast path to the rule being disabled.

This is a real trade-off and the numbers are not small. On the root tree:

- **36** cycles with the type-only filter on (what is enforced);
- **97** cycles with it off.

So 61 type-only cycles are currently invisible to the guard. To change this,
delete the `viaOnly` line in both configs and regenerate the baselines once.
**This is a decision worth making deliberately** rather than inheriting.

**Not guarded — missing npm packages.** `includeOnly` scopes each cruise to
first-party paths, so `not-to-unresolvable` only fires on first-party imports.
A missing external package will not be flagged. That is intentional: it lets
the CI job run off the root install alone, with no `orchestrator/node_modules`
or `ui/node_modules`.

**Warn, not error — orphans.** `no-orphans` reports unreachable modules at
`warn`. They are a cleanup prompt, not a build break. Tests, templates, bin
entry points and tool configs are excluded.

## ADR-0056 layer rules — stubbed, not active

ADR-0056 ("One library, three logical layers") specifies `adapters -> domain ->
engine`, downward-only, and says it is arch-test enforced. **It is not.** None
of those folders exist; the decision was written and never implemented, and no
arch test was ever built.

Both configs carry the layer rules pre-written and **commented out**, against
the ADR's own vocabulary — including `domain` importing no `process`/`http`/
`tty`, and the UI being a thin adapter per ADR-0055. When the folders land,
uncomment them, regenerate the baselines once, and note it in the commit
message (this is case 2 above).

## CI

The `arch` job in `.github/workflows/ci.yml` follows the existing job style
(`pnpm/action-setup@v4` at `10.28.2`, `actions/setup-node@v4` on Node 22, pnpm
cache, `pnpm install --frozen-lockfile`). It runs the ratchet-direction check
and then `pnpm run arch`.

## Verification performed

Measured on `69d4b45d`, real exit codes:

| Check | Result |
| --- | --- |
| `npm run arch` on a clean tree | **exit 0** — 1,359 modules, 0 new errors |
| New cycle planted in `orchestrator/src` | **exit 1** — reported the exact cycle |
| New cycle planted in `ui/src` via `@/` imports | **exit 1** — also proves the alias resolves |
| Scratch files deleted | **exit 0** again |
| Both typescript symlinks removed | **exit 1** — "inspected only 13 modules" |
| `pnpm install --frozen-lockfile` | **exit 0** |
| `ci.yml` parses as YAML | jobs list confirmed |

**NOT VERIFIED — needs a pass:** the CI job has never executed on a GitHub
runner. The YAML parses and every shell/node snippet in it was run locally, but
the `github.event.pull_request.base.sha` branch of the ratchet-direction check
is exercised only on a real pull request. Watch the first PR that touches this.
