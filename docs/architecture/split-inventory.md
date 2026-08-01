# Code-Splitting Inventory

Planning document. **No code moves as part of this document.** Base commit
`69d4b45d`. Measured with `wc -l`, `rg`, and dependency-cruiser 18.1.0.

Companion documents: `docs/adr/0023-*` (CLI command seam),
`docs/adr/0052-*` (Arc aggregate root), `docs/adr/0055-*` (thin displays),
`docs/adr/0056-*` (engine → domain → adapters), and
`docs/architecture/PRD-ddd-restructure.md`.

## 0. Repo facts this plan is built on

| Fact | Value |
| --- | --- |
| Install roots | `/`, `/orchestrator`, `/ui` — **not** a pnpm workspace |
| Files | 1,241 |
| Import edges | 3,629 |
| Source | 142,944 LOC / 565 files |
| Tests | 177,444 LOC / 676 files |
| Folders in an import cycle | 28 of 49 |
| Largest SCC | 22 folders (orchestrator core/cli/workflows/daemon/outbox/bus/…) |
| Second SCC | 6 folders in `ui` (widgets/chat, hooks, widgets, entities, shared, components) |
| Linter | **none** — no ESLint, no Biome, no oxlint |

Commands: `npm --prefix orchestrator run <x>`, `npm --prefix ui run <x>`.

---

## 1. Section A — CLI commands (ADR-0023 leaf-granularity)

STATUS: skeleton — filled in below.

## 2. Section B — UI files over ~400 lines

STATUS: skeleton — filled in below.

## 3. Section C — Big backend files

STATUS: skeleton — filled in below.

## 4. Section D — Sequencing

STATUS: skeleton — filled in below.

## 5. Section E — Tests

STATUS: skeleton — filled in below.
