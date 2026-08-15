# Verify Gates

This file documents the verify gates registered for this repository. Gates are
stored in the `verify_gates` table of the embedded PostgreSQL database. A fresh
checkout must rehydrate them using the commands below; gates are not committed
to source — they live in the database.

## Registered gates

| scope | name | cmd | args | required | rationale |
|-------|------|-----|------|----------|-----------|
| `ui` | `lint-tokens` | `npm` | `["run","lint:tokens"]` | `true` | Enforces ADR-0083: UI components must only reference semantic tokens. Raw palette classes (`bg-iron`, `text-flame`, …) are forbidden in `src/**/*.tsx`. Any coder that introduces a raw palette class during a visual pass is caught at verify time with the `verify/lint-tokens` signature instead of `verify/unclassified`. |
| `ui` | `vite-build` | `npm` | `["run","build"]` | `true` | Runs `tsc -b && vite build && tsc -p tsconfig.server.json` inside `ui/`. Catches TypeScript errors, missing imports, and bundling failures before merge. Any coder that breaks the UI compilation is caught at verify time with the `verify/vite-build` signature. Run from the `ui/` directory. |
| `e2e` | `smoke` | `npm` | `["run","test:e2e"]` | `true` | Runs the Playwright SPA smoke test suite (`ui/e2e/`) against the production build. Catches routing, hydration, and critical-path regressions that unit tests cannot observe. The consumer slice adds `playwright.config.ts` and the `test:e2e` npm script in `ui/package.json` before this gate is registered. |

## Rehydrating in a fresh checkout

Run these commands from the repository root after `mars init`:

```sh
# lint-tokens — ban raw palette classes in ui/src (ADR-0083)
mars verify-gate add \
  --scope ui \
  --name lint-tokens \
  --cmd npm \
  -- run lint:tokens

# vite-build — full TypeScript + Vite compile of the UI (run from ui/)
mars verify-gate add \
  --scope ui \
  --name vite-build \
  --cmd npm \
  -- run build

# smoke — Playwright SPA smoke tests (run from ui/; requires playwright.config.ts)
mars verify-gate add \
  --scope e2e \
  --name smoke \
  --cmd npm \
  -- run test:e2e
```

> **Note:** `--required` is the default; omit `--optional` to keep the gate
> required. `--tier task` is also the default.

## Adding a new gate

```sh
mars verify-gate add \
  --scope <scope> \
  --name <name> \
  --cmd <cmd> \
  [--tier task|integration] \
  [--optional] \
  -- [<args...>]
```

Then document it in the table above with its rationale so the next clone can
rehydrate it.
