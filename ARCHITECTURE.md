# ARCHITECTURE — Mars Framework

> **Status:** v1.0 — locked
> **Date:** 2026-04-27
> **Companion to:** [VISION.md](./VISION.md), [docs/CONTRACTS.md](./docs/CONTRACTS.md)

This document records the tech stack decisions for Mars. VISION.md says *what* and *why*; this file says *what we run it on*. Every choice here is justified against three constraints from VISION.md: **lean by default**, **token-frugal**, **future-proof through boundaries**.

## TL;DR

| Layer | Choice |
|---|---|
| Runtime + toolchain | **Bun** (≥ 1.2) |
| CLI language | TypeScript (strict) |
| CLI distribution | `bun run` in dev, `bun build --compile` for single-binary release |
| Package manager | Bun (`bun install`, `bun.lock`) |
| Test runner | `bun test` |
| Linter / formatter | Biome |
| Schema / validation | Zod |
| CLI argument parsing | Commander |
| Provider SDK | `@anthropic-ai/sdk` (Claude only, behind `Provider` adapter) |
| Plan store (default) | `fs-markdown` adapter (PLAN.md canonical); `beads` adapter optional |
| VCS adapter | `git` via `Bun.$` (no `execa` needed under Bun) |
| UI server | Hono (Bun adapter) |
| UI bundler | Vite |
| UI framework | React 18 + React Flow + Tailwind |
| UI transport | SSE over `/api/events` |
| Event store | Append-only `runs/<ts>/events.jsonl` (no DB) |
| Markdown compiler | Custom + `gray-matter` (front-matter) |
| Process model | One foreground process per command. No daemon. |

## 1. Runtime & toolchain — Bun

**Decision:** Bun is the *only* runtime and toolchain for the CLI, the build, and the test loop. Node is not a target.

### Why Bun

1. **One tool, fewer moving parts.** Bun replaces Node + npm + tsx + ts-node + (often) the test runner. That's four dependencies removed from the harness — directly serves "lean by default."
2. **TypeScript natively.** Bun runs `.ts` directly with no transpile step in dev. `bun run cli/main.ts` is the dev loop. No `tsx`, no `ts-node`.
3. **Fast cold start.** CLIs are short-lived processes. Bun's startup is measurably faster than Node's, which matters when `mars build` spawns subcommands.
4. **`bun build --compile`.** Produces a single self-contained executable. Distribution is one file, no `node_modules` on the user's machine. Fits the "stable interface, swappable internals" principle: we can change everything inside the binary without breaking the install path.
5. **`Bun.$` shell.** First-class shell scripting with proper escaping. The VCS adapter calls `git` through `Bun.$`; no `execa` dependency, no shell-injection footguns.
6. **`Bun.serve` + Web standards.** The UI server uses `Request`/`Response` directly. Hono runs natively on Bun's HTTP layer. No Node `http` shims.
7. **`bun test` is built-in.** Jest-compatible API, no separate runner config. We drop `vitest`.

### What this means concretely

- `package.json` `engines` becomes `{ "bun": ">=1.2.0" }`. The `node` engine field is removed.
- `bun.lock` is committed. `package-lock.json` is removed.
- `tsx` is removed from devDependencies.
- `vitest` is removed from devDependencies; tests use `bun test`.
- `execa` is removed from dependencies; shell calls go through `Bun.$`.
- `tsconfig.json` keeps `"types": ["bun-types"]` and drops `@types/node` (Bun ships its own).
- CI and local dev both run Bun. There is no Node fallback path. (This is a deliberate v0 narrowing — adding Node back later is mechanical if we ever need it.)

### Risk + mitigation

- **Risk:** Bun ecosystem gaps for niche libraries.
  **Mitigation:** Our dependency surface is tiny on purpose (Commander, Zod, gray-matter, Hono, Anthropic SDK). All confirmed Bun-compatible. If a future adapter needs a Node-only library, we isolate it behind the adapter boundary — the rest of the system doesn't care.
- **Risk:** Bun-specific APIs leak into agent code.
  **Mitigation:** Bun APIs (`Bun.$`, `Bun.serve`, `Bun.file`) are only used inside adapters (`framework/adapters/**`). The agent layer and the contract layer use standard Web/TS APIs only. This preserves "agent code never imports `git` or `bd`" — and now also "agent code never imports `Bun`."

### What Bun is *not* used for

- Not used for the UI bundle. Vite is still the bundler for the React app — better dev-server UX, mature React Flow / Tailwind integration. Bun runs the Vite dev server (`bun run vite`) but isn't the bundler.

## 2. CLI

- **Language:** TypeScript, strict mode, ESM only (`"type": "module"`).
- **Argument parsing:** Commander. Chosen for stability and minimal surface; Mars has six top-level commands (`plan`, `build`, `review`, `check`, `audit`, `ui`) and Commander handles them without ceremony.
- **Entry point:** `framework/cli/main.ts`. Compiled with `bun build --compile --target=bun --outfile=dist/mars` for release.
- **Distribution:** single `mars` binary. No global npm install path. The repo's `bin` field points to `dist/cli/main.js` for `bun link` during local dev.

## 3. Validation — Zod

Every adapter contract, every event payload, every config file is parsed through Zod at the boundary. Rationale: the system's correctness depends on declarative intent objects flowing across adapter seams. A typo in a `MarsEvent.kind` is the kind of bug that would silently corrupt the event stream — so we parse, not cast.

Zod schemas live in `framework/contract/`. They are the source of truth; TypeScript types are derived via `z.infer`.

## 4. Adapters

The adapter layer is where Bun-specific code is allowed. Each adapter has one job and one file.

| Adapter | Default impl | Notes |
|---|---|---|
| `Provider` | `claude` | Wraps `@anthropic-ai/sdk`. Streams. Tracks tokens in/out for the event stream. |
| `PlanStore` | `fs-markdown` | Canonical `PLAN.md`. Writes through `Bun.file`. `beads` adapter is optional and syncs from the markdown. |
| `VCS` | `git` | Uses `Bun.$` for `git add` / `git commit` / `git status`. No git library. |
| `FS` | `local` | `Bun.file` + `Bun.write`. |
| `Compiler` | `md` | Custom link checker + Zod schema validation for plans. Uses `gray-matter` for front-matter. |
| `EventSink` | `jsonl` | Append-only writer to `runs/<ts>/events.jsonl`. Single open file handle per run. |

Swapping an adapter is one file change + one config line. That is the contract.

## 5. UI — `mars ui`

- **Server:** Hono on Bun. `app.fetch` plugged into `Bun.serve`. SSE endpoint at `/api/events` tails the active run's `events.jsonl`; static endpoint serves the built Vite bundle.
- **Client:** Vite + React 18 + React Flow (topology view) + Tailwind (layout). Zero state library — all data comes from SSE or from reading `runs/` over `/api/runs`.
- **Boot:** `mars ui` starts Hono in the foreground on port 7777. Ctrl-C stops it. No daemon, no PM2, no background process. This is enforced by the CLI command — there is no `--detach` flag.
- **Read-only:** the UI has no POST routes, period. The CLI is the only control surface (locked in VISION.md).

The UI bundle is built once with `vite build` and served as static files by Hono. Dev mode runs `vite dev` proxied behind Hono on the same port.

## 6. Observability

- **Single source of truth:** `runs/<timestamp>/events.jsonl`.
- **Schema:** versioned via `schemaVersion` on `run.start`. Old traces remain readable as the shape evolves.
- **Rotation:** keep the last 50 runs. `mars build --keep` flags a run as non-rotatable.
- **No DB.** No SQLite, no LevelDB, no in-process store. The append-only file *is* the store. Anything that needs a query layer (search across runs, etc.) is a future viewer's problem and reads from the JSONL.

This is non-negotiable: introducing a database would couple every viewer to a schema migration story. JSONL with a versioned event shape gives us the same property without the operational weight.

## 7. Testing

- **Runner:** `bun test`. Jest-compatible API.
- **Coverage:** `bun test --coverage`. Target ≥ 80% on `framework/contract/` and `framework/adapters/`. Agent prompts and CLI glue are excluded from the coverage gate (they're tested via end-to-end fixture runs, not unit tests).
- **Fixtures:** end-to-end tests boot the CLI via `Bun.spawn` against a temp working directory, run a canned `mars plan` → `mars build`, and assert on the resulting `events.jsonl`.

## 8. Linting & formatting

- **Biome** for both. One tool, one config (`biome.json`), formatter + linter + import sorter. Replaces ESLint + Prettier.
- Pre-commit hook runs `biome check --write` and `bunx tsc --noEmit`. Bun is fast enough that this is sub-second on the current tree.

## 9. Markdown compiler (`mars check`)

- Resolves every `[text](path)` link in tracked `.md` files; failure = exit non-zero.
- Validates `PLAN.md` against the Zod plan schema.
- Validates the reference graph: every task's `acceptance` must point at a real file or test.
- Pure TypeScript, no external markdown parser beyond `gray-matter` for front-matter. We don't need a full AST — line-based scanning with a link regex is sufficient and stays cheap.

## 10. What we explicitly chose against

| Rejected | Why |
|---|---|
| Node + npm | Two tools where Bun is one. Slower cold start. No `--compile` story. |
| pnpm / yarn | Bun replaces them. Adding a separate package manager defeats the point. |
| `tsx` / `ts-node` | Bun runs TS natively. |
| `execa` | `Bun.$` covers every shell case we have, with proper escaping. |
| Vitest / Jest | `bun test` is built in and Jest-compatible. |
| ESLint + Prettier | Biome is one tool, faster, fewer configs. |
| Express / Fastify | Hono is smaller, runs natively on Bun, uses Web `Request`/`Response`. |
| Next.js / Remix | Mars UI is a local read-only viewer, not a web app. Vite + React + a static bundle is the right size. |
| SQLite for runs | Adds a schema migration story we don't need. JSONL is the contract. |
| Redux / Zustand / TanStack Query | UI state is a stream of events plus a directory listing. No store needed. |
| Daemon / background server | Violates "CLI is the only control surface." `mars ui` runs foreground or not at all. |
| A second LLM provider in v0 | Locked: Claude only. Boundary exists in `Provider` adapter; second provider lands when there's a real reason. |
| `PreCompact` recovery hooks | Locked anti-goal in VISION.md — compaction is failure, not a thing to recover from. |

## 11. Versioning policy

- **Bun:** pin a minor in `engines`, allow patch updates. Bumping the minor is a deliberate PR.
- **TypeScript:** `^5.7`. Strict mode is non-negotiable.
- **Anthropic SDK:** caret on minor, but every bump runs the full fixture suite — provider adapters are the most likely silent-break surface.
- **Hono / Vite / React:** caret on minor.
- **Biome / Zod / Commander / gray-matter:** caret on minor.

Lockfile (`bun.lock`) is committed. `bun install --frozen-lockfile` in CI.

## 12. Open questions deferred

These are not architecture decisions yet — they will be decided when the second real implementation forces them (per principle 5):

- Will `beads` ever become the *canonical* PlanStore instead of `fs-markdown`? Not until we have a use case the markdown can't serve.
- Will Mars ever ship as an npm package? Not until someone needs to install it without Bun. The `bun build --compile` binary is the distribution story for now.
- Will the UI ever support a "headless" mode (TUI / VS Code extension)? The event stream is the contract that makes this trivial, but no work happens until there's a real consumer.

---

*If a decision in this file conflicts with VISION.md, VISION.md wins and this file is wrong. File a `mars retro` defect with `rootCause: 'doc_drift'`.*
