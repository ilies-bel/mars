# Code-Splitting Inventory

Planning document. **No code moves as part of this document.** Base commit
`69d4b45d`. Measured with `wc -l` and `rg` on that commit; folder/cycle facts
from dependency-cruiser 18.1.0.

Companion documents: `docs/adr/0023-*` (CLI Command seam), `docs/adr/0052-*`
(Arc aggregate root, sole writer), `docs/adr/0055-*` (thin displays),
`docs/adr/0056-*` (engine → domain → adapters), and
`docs/architecture/PRD-ddd-restructure.md` + `aggregate-catalog.md`.

CLAUDE.md rule that governs every row below: **every change is a hard cut.** No
compat shim, no re-export barrel left behind "for now", no deprecation alias. A
split lands with every call site updated in the same change.

---

## 0. Facts this plan is built on

| Fact | Value |
| --- | --- |
| Install roots | `/`, `/orchestrator`, `/ui` — **not** a pnpm workspace |
| Build/test invocation | `npm --prefix orchestrator run <x>`, `npm --prefix ui run <x>` |
| Files | 1,241 |
| Import edges | 3,629 |
| Source | 142,944 LOC / 565 files |
| Tests | 177,444 LOC / 676 files |
| Folders in an import cycle | 28 of 49 |
| Largest SCC | 22 folders (core/lib, core/daemon, core, cli/commands, cli, workflows, workflows/primitives, core/lib/git, core/workers, core/daemon/view, core/daemon/rpc, core/daemon/spend-control, core/store, outbox, outbox/subscribers, internal-bus, init, ideas, bus, core/lib/deployment, core/mcp, orchestrator/src root) |
| Second SCC | 6 folders in `ui` (widgets/chat, hooks, widgets, entities, shared, components) |
| Linter | **none** — no ESLint, no Biome, no oxlint |
| `orchestrator/src/{engine,domain,adapters}` | **do not exist** (verified: `ls` → No such file or directory) |
| Arch test enforcing ADR-0056 | **does not exist** (no dependency-cruiser rule file, no arch test, no linter to host one) |

### 0.1 Measurement discrepancy — read this before quoting line counts

The task brief quotes line counts that do not match `wc -l` on `69d4b45d`. My
numbers are re-measured on the actual base commit and are the ones used
throughout this document.

| File | Brief | Measured on `69d4b45d` | Delta |
| --- | ---: | ---: | ---: |
| `orchestrator/src/core/daemon/server.ts` | 5,753 | **5,972** | +219 |
| `orchestrator/src/core/arc.ts` | 3,243 | **3,366** | +123 |
| `orchestrator/src/workflows/primitives/index.ts` | 3,104 | **3,436** | +332 |
| `orchestrator/src/core/daemon/http-server.ts` | 2,525 | **2,683** | +158 |
| `orchestrator/src/core/queue.ts` | 2,082 | **2,173** | +91 |
| `orchestrator/src/core/app-services.ts` | 1,466 | **1,511** | +45 |
| `ui/src/pages/ChatPage.tsx` | 3,020 | **3,018** | −2 |
| `ui/src/widgets/TaskDetailDrawer.tsx` | 1,918 | **1,923** | +5 |
| `orchestrator/src/cli.ts` | 1,651 | **1,651** | 0 |

The backend files are uniformly *larger* than the brief states while the UI
files are within rounding. Most likely the brief's source-LOC figures exclude
comment and blank lines. **Decision needed:** which convention the eventual
tracking dashboard uses. Everything below is raw `wc -l`.

---

## 1. Section A — CLI commands (ADR-0023)

### 1.1 How much of ADR-0023 actually landed

Verified by reading `orchestrator/src/cli/command.ts` (104 lines),
`orchestrator/src/cli/registry.ts` (81), `orchestrator/src/cli/dispatch.ts` (136)
and `orchestrator/src/cli/commands/index.ts` (96).

| ADR-0023 clause | Status | Evidence |
| --- | --- | --- |
| `run(args, deps) -> CommandResult{code, value?}` | **LANDED** | `Command` interface, `cli/command.ts:95-101` |
| Flat path-keyed registry, leaf granular | **LANDED** | `buildRegistry` / `route`, `cli/registry.ts:24-63`; ~190 leaf paths registered |
| Grouping computed, not an object | **LANDED** | `groupByTopLevel`, `cli/registry.ts:66-75` |
| Transport injected (`deps.daemon`) | **LANDED** | `DaemonClient` in `cli/command.ts:33-49` |
| Store injected (ADR-0021) | **LANDED** | `CommandDeps.store`, `cli/command.ts:60` |
| No `process.exit` in commands | **LANDED, one exception** | Only `cli/commands/shared.ts` contains `process.exit` (1 occurrence). Every other non-test file in `cli/commands/` has zero. |
| **One file per leaf** | **NOT LANDED** | 190 leaves live in 42 group-named files. This is the entire remaining gap. |

So the seam is real and the contract is honoured. The gap is purely **file
granularity**: ADR-0023 says the unit is the leaf (`proposal add`), and the
filesystem still says the unit is the group (`proposal.ts`, 928 lines,
21 leaves).

`deps.stateStore` is still declared `unknown` and optional
(`cli/command.ts:62`) — the StateStore half of ADR-0021 never landed on this
seam. Flagged for Section D; it is not a splitting blocker.

### 1.2 Target layout

```
orchestrator/src/cli/commands/
  <group>/
    index.ts          <- `export const <group>Commands = [...]` only; no logic
    <leaf>.ts         <- one Command object, one default-ish named export
    shared.ts         <- group-local helpers ONLY when >1 leaf in the group uses them
  _root/              <- ungrouped single-token leaves (`where`, `sweep`, `triage`, …)
```

Naming rule: the file is the leaf's last token, kebab-cased
(`proposal add` → `proposal/add.ts`; `daemon set-cap` → `daemon/set-cap.ts`).
The group's bare path (`proposal` with no subcommand — the usage-printer leaf)
becomes `proposal/usage.ts`, **not** `proposal/index.ts`, so `index.ts` stays a
pure assembly file with zero behaviour.

Exported symbol rule: `export const <camelLeaf>Command: Command`
(`proposalAddCommand`, `daemonSetCapCommand`). `index.ts` re-exports nothing but
the array.

### 1.3 Per-group inventory

`start` is the line of the `path:` field, verified by grep. A leaf's span runs
from its `const …Command: Command = {` declaration (typically 3–8 lines above
`start`, carrying its jsdoc) to the line before the next declaration. Spans are
therefore stated as start-to-start; the mover reads the real boundary from the
declaration comment.

Columns: `exit?` = contains `process.exit`; `dyn` = count of `await import(` in
the whole file (per-leaf attribution needs the mover to check — noted where the
file total is high).

#### `proposal.ts` — 928 lines, 21 leaves → `commands/proposal/`

| Leaf | start | → target | exported symbol |
| --- | ---: | --- | --- |
| `proposal add` | 118 | `proposal/add.ts` | `proposalAddCommand` |
| `proposal show` | 141 | `proposal/show.ts` | `proposalShowCommand` |
| `proposal set` | 166 | `proposal/set.ts` | `proposalSetCommand` |
| `proposal add-user-story` | 205 | `proposal/add-user-story.ts` | `proposalAddUserStoryCommand` |
| `proposal remove-user-story` | 227 | `proposal/remove-user-story.ts` | `proposalRemoveUserStoryCommand` |
| `proposal promote` | 293 | `proposal/promote.ts` | `proposalPromoteCommand` |
| `proposal slice` | 351 | `proposal/slice.ts` | `proposalSliceCommand` |
| `proposal dismiss` | 391 | `proposal/dismiss.ts` | `proposalDismissCommand` |
| `proposal delete` | 417 | `proposal/delete.ts` | `proposalDeleteCommand` |
| `proposal list` | 443 | `proposal/list.ts` | `proposalListCommand` |
| `proposal block` | 475 | `proposal/block.ts` | `proposalBlockCommand` |
| `proposal unblock` | 503 | `proposal/unblock.ts` | `proposalUnblockCommand` |
| `proposal blockers` | 535 | `proposal/blockers.ts` | `proposalBlockersCommand` |
| `proposal block-task` | 560 | `proposal/block-task.ts` | `proposalBlockTaskCommand` |
| `proposal unblock-task` | 597 | `proposal/unblock-task.ts` | `proposalUnblockTaskCommand` |
| `proposal task-blockers` | 631 | `proposal/task-blockers.ts` | `proposalTaskBlockersCommand` |
| `proposal ship-summary` | 656 | `proposal/ship-summary.ts` | `proposalShipSummaryCommand` |
| `proposal approve` | 769 | `proposal/approve.ts` | `proposalApproveCommand` |
| `proposal take` | 798 | `proposal/take.ts` | `proposalTakeCommand` |
| `proposal reslice` | 851 | `proposal/reslice.ts` | `proposalResliceCommand` |
| `proposal` (usage) | 897 | `proposal/usage.ts` | `proposalUsageCommand` |

Lines 1–117 are imports + shared helpers → `proposal/shared.ts`. `exit?` no,
`dyn` 0. Six blocker-shaped leaves (`block`, `unblock`, `blockers`,
`block-task`, `unblock-task`, `task-blockers`) share formatting helpers — those
go to `proposal/shared.ts`, not duplicated.

#### `lifecycle.ts` — 839 lines, 12 leaves → `commands/lifecycle/`

All are single-token top-level verbs, so they land in `commands/_root/`, not a
`lifecycle/` folder — "lifecycle" is a filename, not a command namespace, and
keeping it as a folder would re-import the grouping fiction ADR-0023 removed.

| Leaf | start | → target | exported symbol |
| --- | ---: | --- | --- |
| `show` | 25 | `_root/show.ts` | `showCommand` |
| `remerge` | 182 | `_root/remerge.ts` | `remergeCommand` |
| `purge` | 205 | `_root/purge.ts` | `purgeCommand` |
| `unblock` | 237 | `_root/unblock.ts` | `unblockCommand` |
| `recover` | 276 | `_root/recover.ts` | `recoverCommand` |
| `sync` | 372 | `_root/sync.ts` | `syncCommand` |
| `drop` | 426 | `_root/drop.ts` | `dropCommand` |
| `block` | 485 | `_root/block.ts` | `blockCommand` |
| `list` | 527 | `_root/list.ts` | `listCommand` |
| `update` | 599 | `_root/update.ts` | `updateCommand` |
| `land` | 688 | `_root/land.ts` | `landCommand` |
| `release` | 742 | `_root/release.ts` | `releaseCommand` |

`dyn` 8 across the file — `show` (large, 25–181) and `recover` are the likely
holders; the mover verifies per-leaf. Task-row rendering helpers in lines 1–24
plus whatever `show` inlines → `_root/shared/task-render.ts` (candidate for
promotion to `cli/render/` in Section D).

**Naming collision to resolve:** `_root/purge.ts` (from `lifecycle.ts:205`) vs
the existing `commands/purge.ts` which holds only `purge log` (line 11). The
existing `purge.ts` header even says so: *"The `purge` verb itself lives in
`lifecycle.ts`"*. Target: `purge/usage.ts`… no — `purge` is a real leaf with
behaviour, so target `purge/index.ts` is banned by the rule above. **Resolution:
create `commands/purge/` with `purge/purge.ts` (the verb, from lifecycle) and
`purge/log.ts`, and `purge/index.ts` as assembly only.** Same shape applies to
`worktree` (see `misc.ts` and `worktree.ts` below).

#### `workflow.ts` — 739 lines, 7 leaves → `commands/workflow/`

| Leaf | start | → target |
| --- | ---: | --- |
| `workflow list` | 207 | `workflow/list.ts` |
| `workflow show` | 239 | `workflow/show.ts` |
| `workflow validate` | 336 | `workflow/validate.ts` |
| `workflow render` | 405 | `workflow/render.ts` |
| `workflow author` | 487 | `workflow/author.ts` |
| `workflow approve` | 645 | `workflow/approve.ts` |
| `workflow` (usage) | 722 | `workflow/usage.ts` |

Lines 1–206 are a large shared preamble (workflow loading, config resolution,
render helpers) → `workflow/shared.ts`. `dyn` 10 — concentrated in `author` and
`validate`. This group has the highest shared-preamble ratio (28% of the file);
do not let `workflow/shared.ts` become the next `misc.ts` — if it exceeds ~200
lines, the excess belongs in `core/lib/` behind a real name.

#### `reflect.ts` — 697 lines, 7 leaves, **two namespaces in one file**

| Leaf | start | → target |
| --- | ---: | --- |
| `reflect` | 15 | `reflect/reflect.ts` |
| `arc list` | 139 | `arc/list.ts` |
| `arc reflect` | 175 | `arc/reflect.ts` |
| `arc purge` | 393 | `arc/purge.ts` |
| `arc` (usage) | 425 | `arc/usage.ts` |
| `reflect session` | 435 | `reflect/session.ts` |
| `reflect workflow-fit` | 596 | `reflect/workflow-fit.ts` |

**Call-out:** `reflect.ts` hosts the entire `arc *` namespace. That is invisible
from the filename and is exactly the discoverability failure ADR-0023 targets.
`dyn` 22 — the highest density in the CLI tree, mostly in `arc reflect`
(175–392) which lazily pulls the deep-reflection machinery. Those dynamic
imports are legitimate startup-cost avoidance and should survive the split
unchanged; do **not** convert them to static imports while splitting, or every
`mars` invocation pays for the reflection stack.

#### `daemon.ts` — 643 lines, 11 leaves → `commands/daemon/`

| Leaf | start | → target |
| --- | ---: | --- |
| `daemon stop` | 83 | `daemon/stop.ts` |
| `daemon kill` | 119 | `daemon/kill.ts` |
| `daemon reload` | 152 | `daemon/reload.ts` |
| `daemon status` | 185 | `daemon/status.ts` |
| `daemon usage` | 245 | `daemon/usage-report.ts` |
| `daemon start` | 264 | `daemon/start.ts` |
| `daemon restart` | 315 | `daemon/restart.ts` |
| `daemon set-cap` | 355 | `daemon/set-cap.ts` |
| `daemon set-lever` | 415 | `daemon/set-lever.ts` |
| `daemon spend-control` | 605 | `daemon/spend-control.ts` |
| `daemon` (usage) | 622 | `daemon/usage.ts` |

Note the name clash: the leaf `daemon usage` (a spend report) and the
group usage-printer both want `usage.ts`. Resolved above — report is
`usage-report.ts`. `daemon set-lever` is the outlier at ~190 lines
(415–604); it carries the whole lever-name validation table, which belongs in
`core/daemon/spend-control/` and not in a CLI file at all.

`normalizeDaemonAliases` currently lives in `cli.ts:1479`; see §1.6.

#### `install.ts` — 565 lines, 6 leaves

| Leaf | start | → target |
| --- | ---: | --- |
| `init` | 121 | `_root/init.ts` |
| `install` | 359 | `_root/install.ts` |
| `uninstall` | 426 | `_root/uninstall.ts` |
| `plugin activate` | 514 | `plugin/activate.ts` |
| `plugin deactivate` | 533 | `plugin/deactivate.ts` |
| `plugin` (usage) | 547 | `plugin/usage.ts` |

`dyn` 22 — second-highest, and here it matters more: `init` (121–358) drives
template expansion from `orchestrator/src/init/templates/`, which is in the
22-folder SCC. Splitting the file does not break that edge; see Section D.

#### `misc.ts` — 552 lines, 21 leaves across **9 unrelated namespaces**

This is the single worst file in the CLI tree and it must not survive the split
in any form. A file named `misc` is an unowned bucket: nothing is findable, no
one owns it, and it accretes.

| Leaf | start | → target | new owner |
| --- | ---: | --- | --- |
| `where` | 15 | `_root/where.ts` | root |
| `ui stop` | 44 | `ui/stop.ts` | ui |
| `ui status` | 55 | `ui/status.ts` | ui |
| `ui` (usage) | 66 | `ui/usage.ts` | ui |
| `kpi snapshot` | 84 | `kpi/snapshot.ts` | kpi |
| `kpi show` | 101 | `kpi/show.ts` | kpi |
| `kpi` (usage) | 117 | `kpi/usage.ts` | kpi |
| `worktree prune` | 129 | `worktree/prune.ts` | worktree |
| `worktree clean` | 153 | `worktree/clean.ts` | worktree |
| `worktree` (usage) | 180 | `worktree/usage.ts` | worktree |
| `project add` | 195 | `project/add.ts` | project |
| `project list` | 211 | `project/list.ts` | project |
| `project remove` | 222 | `project/remove.ts` | project |
| `project` (usage) | 238 | `project/usage.ts` | project |
| `observability prune` | 250 | `observability/prune.ts` | observability |
| `observability` (usage) | 277 | `observability/usage.ts` | observability |
| `db compact` | 289 | `db/compact.ts` | db |
| `db` (usage) | 353 | `db/usage.ts` | db |
| `cut verify` | 365 | `cut/verify.ts` | cut |
| `cut` (usage) | 383 | `cut/usage.ts` | cut |
| `statusline` | 395 | `_root/statusline.ts` | root |
| `triage` | 408 | `_root/triage.ts` | root |
| `sweep` | 457 | `_root/sweep.ts` | root |

`dyn` 25 — the highest in the tree, because every one of these nine namespaces
lazily pulls its own subsystem. That is the tell: `misc.ts` is nine files
wearing one filename. `exit?` no.

`worktree/prune.ts` and `worktree/clean.ts` (from misc) join the existing
`worktree.ts:33` `worktree reclaim` → `worktree/reclaim.ts`. `ui/stop.ts` will
want `cli/ui-stop.ts` (184 lines) and `cli/ui.ts` (147); `cut/verify.ts` wants
`cli/cut-verify.ts` (220). Those three stay where they are — they are
implementation modules the leaf calls, not leaves.

**After this table, delete `misc.ts`. Do not create `commands/misc/`.**

#### `task.ts` — 534 lines, 7 leaves → `commands/task/`

| Leaf | start | → target |
| --- | ---: | --- |
| `task add` | 118 | `task/add.ts` |
| `task show` | 332 | `task/show.ts` |
| `task priority` | 384 | `task/priority.ts` |
| `task note` | 415 | `task/note.ts` |
| `task check` | 443 | `task/check.ts` |
| `task ask` | 489 | `task/ask.ts` |
| `task` (usage) | 517 | `task/usage.ts` |

`task add` is 214 lines (118–331) — the flag surface (`--files`, `--verify`,
`--done`, `--type`, `--priority`, `--tag`, `--blocked-by`) plus spec assembly.
Split further: `task/add.ts` (the Command) + `task/add-spec.ts` (pure
`ParsedArgs → CreateOriginSpec` builder, unit-testable with zero deps). That
builder is the thing the slicer and the MCP surface both want and neither can
reach today.

#### `doctor.ts` — 363 lines, 1 leaf

`doctor` at 336. Lines 1–335 are the check catalogue. Target:
`doctor/doctor.ts` (thin) + `doctor/checks/*.ts` (one file per check). The
mover enumerates the checks; **NOT VERIFIED — needs a pass** on the exact check
list.

#### Remaining groups (all mechanical, same rule)

| File | lines | leaves | starts | target folder |
| --- | ---: | ---: | --- | --- |
| `action-queue.ts` | 320 | 6 | 125,189,196,230,279,290 | `action-queue/` (list, usage, show, raise, watch, reconcile) |
| `operator.ts` | 290 | 5 | 49,128,231,253,274 | `operator/` (status, set, name-set, name-show, usage) |
| `enrich.ts` | 277 | 7 | 91,116,136,187,213,238,260 | `enrich/` |
| `scorer.ts` | 261 | 6 | 75,108,151,200,223,245 | `scorer/` |
| `verify-gate.ts` | 244 | 5 | 33,89,146,175,229 | `verify-gate/` |
| `tool-promotion.ts` | 226 | 4 | 50,60,125,179 | `tool-promotion/` |
| `run.ts` | 206 | 2 | 157,197 | `run/` (show, usage) |
| `step.ts` | 204 | 3 | 40,135,195 | `step/` (done, reset, usage) |
| `release-notes.ts` | 194 | 4 | 67,150,157,179 | `release-notes/` |
| `diagnose.ts` | 188 | 5 | 24,70,108,139,170 | `diagnose/` |
| `verify.ts` | 171 | 4 | 31,80,132,157 | `verify/` |
| `tool-forge.ts` | 161 | 3 | 13,23,83 | `tool-forge/` |
| `memory.ts` | 160 | 4 | 24,38,91,134 | `memory/` |
| `glossary.ts` | 143 | 5 | 20,59,78,97,128 | `glossary/` |
| `alert.ts` | 126 | 3 | 54,85,92 | `alert/` |
| `adr.ts` | 121 | 4 | 16,39,72,107 | `adr/` |
| `credentials.ts` | 117 | 4 | 20,45,86,103 | `credentials/` |
| `worktree.ts` | 116 | 1 | 33 | `worktree/reclaim.ts` |
| `worker.ts` | 112 | 3 | 18,38,99 | `worker/` |
| `skill-forge.ts` | 110 | 3 | 76,86 (+group) | `skill-forge/` |
| `chat-feedback.ts` | 103 | 2 | 16,28 | `chat-feedback/` |
| `preview-validation.ts` | 100 | ? | — | **NOT VERIFIED — needs a pass** (no `path:` grep hit; check how it registers) |
| `notifications.ts` | 89 | 4 | 16,32,48,64 | `notifications/` |
| `steward.ts` | 88 | 4 | 7,17,38,61 | `steward/` |
| `deploy.ts` | 83 | 2 | 18,74 | `deploy/` |
| `self-update.ts` | 65 | 1 | 22 | `_root/self-update.ts` |
| `purge.ts` | 64 | 1 | 11 | `purge/log.ts` |
| `vision.ts` | 63 | 3 | 14,34,53 | `vision/` |
| `notice.ts` | 51 | 1 | 11 | `notice/add.ts` |
| `merge.ts` | 48 | 1 | 12 | `merge/cancel.ts` |
| `propose.ts` | 46 | 1 | 17 | `_root/propose.ts` |
| `mcp-worker.ts` | 32 | 1 | 14 | `mcp/worker.ts` |

Files at or under ~120 lines with 1–4 leaves (`notice`, `merge`, `propose`,
`mcp-worker`, `vision`, `deploy`, `self-update`) are **already effectively
leaf-granular**. Splitting them is churn with no readability gain. Recommendation:
**apply the folder rule anyway, for one reason only** — an arch rule that says
"every file under `cli/commands/<group>/` exports exactly one `Command`" is
mechanically checkable, and a rule with exceptions is not enforceable. The cost
is ~25 tiny files; the benefit is that the next 190-leaf drift is caught by CI
instead of by a human reading a 928-line file.

#### `shared.ts` — 49 lines, the one `process.exit`

The only `process.exit` left under `cli/commands/`. Read it before splitting: if
it is on a genuinely-unrecoverable path it still violates ADR-0023's "never
calls `process.exit`". Target: convert to a thrown error the adapter maps, or a
`CommandResult{code}`. **NOT VERIFIED — needs a pass** on which helper holds it.
This is a 10-line fix and should land as step 0 of Section D so the "zero
`process.exit` under `cli/commands/`" arch rule can be written at the same time
as the one-Command-per-file rule.

### 1.6 What remains in `cli.ts` (1,651 lines) and where it goes

`cli.ts` is **not** mostly logic. Verified by outline:

| Range | Lines | Content | Target |
| --- | ---: | --- | --- |
| 1–22 | 22 | imports, `swallowEpipe` | `cli/adapter/epipe.ts` (or keep) |
| 32–591 | **560** | the `usage` template literal — the whole top-level help screen | `cli/help/usage.ts`, generated |
| 592–593 | 2 | `HELP_FLAGS` set | `cli/help/flags.ts` |
| 594–1464 | **871** | `COMMAND_HELP: Record<string, string>` — per-command long help, keyed by command name | **delete**; fold each entry into its leaf file |
| 1465–1478 | 14 | `printCommandHelp` | `cli/help/print.ts` |
| 1479–1490 | 12 | `normalizeDaemonAliases` | `cli/commands/daemon/aliases.ts` |
| 1491–1547 | 57 | `findReachableDbTarget` (5 dynamic imports) | `core/lib/db-target.ts` — this is not CLI code |
| 1548–1585 | 38 | `emitCliInvocationTrace` (3 dynamic imports) | `cli/adapter/trace.ts` |
| 1586–1650 | 65 | `main()` | `cli/adapter/main.ts` |
| 1651 | 1 | the single `process.exit(exitCode)` | stays — this is ADR-0023's one mapping site |

**1,431 of 1,651 lines (87%) of `cli.ts` are help text.** This is the headline
finding for Section A. The `usage` blob and `COMMAND_HELP` duplicate
information that already exists as `Command.summary` and `Command.usage` on
every registered leaf (`cli/command.ts:88-92`).

Target: **delete both blobs.** Generate the top-level usage screen from
`groupByTopLevel(registry)` (`cli/registry.ts:66`) and serve per-command help
from the leaf's own `summary`/`usage` fields plus an optional new
`Command.help?: string` for the long form. Each leaf file then carries its own
help text next to its own implementation — which is the whole point of
one-file-per-leaf, and the reason the current split is only half-done: the code
moved out of `cli.ts` and the documentation did not.

This single change takes `cli.ts` from 1,651 to roughly **220 lines**, and it is
independent of every other item in this document — it can land first.

Two consistency risks it also fixes: `COMMAND_HELP` is keyed by command *name*
with no compile-time link to the registry, so an entry for a removed command or
a missing entry for a new one is invisible today. After the move, a leaf without
help is a missing property on a typed object.

---

## 2. Section B — UI

One-file-per-widget is already substantially true: 57 widget files / 8,461 LOC
means a ~148-line average. The real problem is two files, plus a `shared/`
folder doing three jobs, plus the 6-folder `ui` SCC.

### 2.1 Every `ui/src` non-test file over ~350 lines

| File | lines | verdict |
| --- | ---: | --- |
| `ui/src/pages/ChatPage.tsx` | 3,018 | split — §2.2 |
| `ui/src/widgets/TaskDetailDrawer.tsx` | 1,923 | split — §2.3 |
| `ui/src/shared/schemas.ts` | 1,439 | split — §2.4 |
| `ui/src/pages/EventsPage.tsx` | 1,160 | split — §2.5 |
| `ui/src/shared/api.ts` | 1,145 | split — §2.4 |
| `ui/src/widgets/topologyFlowModel.ts` | 916 | split — §2.5 |
| `ui/src/widgets/chat/QueueThreadDetail.tsx` | 895 | split — §2.5 |
| `ui/src/widgets/chat/ContextRail.tsx` | 776 | split — §2.5 |
| `ui/src/widgets/TopologyView.tsx` | 583 | split — §2.5 |
| `ui/src/widgets/PrimitiveDetailDrawer.tsx` | 566 | split — §2.5 |
| `ui/src/widgets/chat/AlertCard.tsx` | 564 | split — §2.5 |
| `ui/src/pages/StewardPage.tsx` | 546 | split — §2.5 |
| `ui/src/widgets/StudioView.tsx` | 487 | borderline — §2.5 |
| `ui/src/shared/routing.ts` | 467 | borderline — §2.4 |
| `ui/src/widgets/ProposalNodeDrawer.tsx` | 422 | borderline — leave |
| `ui/src/widgets/ProjectSelector.tsx` | 405 | borderline — leave |
| `ui/src/components/ai-elements/tool.tsx` | 403 | vendored — leave |
| `ui/src/widgets/ReleaseNotesModal.tsx` | 386 | leave |
| `ui/src/pages/KpiDetailPage.tsx` | 386 | leave |
| `ui/src/shared/actionQueueDetail.ts` | 379 | leave |
| `ui/src/components/ai-elements/prompt-input.tsx` | 377 | vendored — leave |

`ui/src` total non-test: 29,593 lines. The top two files are 17% of it.

`components/ai-elements/*` is vendored (shadcn/ai-elements style). **Do not
split vendored components** — it destroys the ability to re-sync upstream. Note
them as excluded in whatever arch rule gets written.

### 2.2 `ChatPage.tsx` — 3,018 lines → 20 files

This file contains 24 top-level components. It is not a page; it is the chat
feature. Verified outline:

| Symbol | line | lines | → target |
| --- | ---: | ---: | --- |
| `WELCOME_CHIPS`, `SLASH_COMMANDS`, `KIND_ICON` | 109,118,129 | ~30 | `widgets/chat/constants.ts` |
| `HeroSuggestionsProps` / `HeroSuggestions` | 139,156 | 82 | `widgets/chat/HeroSuggestions.tsx` |
| `UIPart` type | 238 | 3 | `widgets/chat/types.ts` |
| `ToolResultBox` | 241 | 7 | `widgets/chat/message/ToolResultBox.tsx` |
| `AlertCardFromSegment` | 248 | 28 | `widgets/chat/message/AlertCardFromSegment.tsx` |
| `ThumbUpSvg` / `ThumbDownSvg` | 276,289 | 26 | `widgets/chat/icons.tsx` |
| `FeedbackControlsProps` / `FeedbackControls` | 302,318 | **188** | `widgets/chat/FeedbackControls.tsx` + `hooks/useMessageFeedback.ts` |
| `AttachmentDisplay` | 490 | 53 | `widgets/chat/message/AttachmentDisplay.tsx` |
| `ChatResponseError` | 543 | 26 | `widgets/chat/message/ChatResponseError.tsx` |
| `ResultFooter` | 569 | 19 | `widgets/chat/message/ResultFooter.tsx` |
| `ThinkingBlock` | 588 | 14 | `widgets/chat/message/ThinkingBlock.tsx` |
| `ToolActivityEntry` / `ToolActivityGroup` | 602,619 | 35 | `widgets/chat/message/ToolActivityGroup.tsx` |
| `HighlightedResponse` | 637 | 79 | `widgets/chat/message/HighlightedResponse.tsx` + `shared/glossaryHighlight.ts` (pure) |
| `renderPart` | 716 | 70 | `widgets/chat/message/renderPart.tsx` |
| `MessageView` | 786 | 75 | `widgets/chat/message/MessageView.tsx` |
| `ThreadItemProps` / `ThreadItem` | 861,868 | **116** | `widgets/chat/ThreadItem.tsx` |
| `ThinkingIndicator` | 977 | 27 | `widgets/chat/ThinkingIndicator.tsx` |
| `LiveAssistantBubble` | 1004 | 47 | `widgets/chat/LiveAssistantBubble.tsx` |
| `ChatConversationProps` / `ChatConversation` | 1051,1075 | **322** | `widgets/chat/ChatConversation.tsx` + `hooks/useConversationScroll.ts` |
| `SlashPaletteProps` / `SlashPalette` | 1373,1380 | 50 | `widgets/chat/SlashPalette.tsx` |
| `sendErrorMessage` | 1423 | 12 | `shared/chatErrors.ts` (pure) |
| `HeroComposerProps` / `HeroComposer` | 1435,1445 | **274** | `widgets/chat/HeroComposer.tsx` |
| `PendingAttachment` / `Composer` | 1761,1769 | **543** | `widgets/chat/Composer.tsx` + `hooks/useAttachments.ts` + `hooks/useSlashPalette.ts` |
| `ThreadSidebarProps` / `ThreadSidebar` | 2304,2316 | **130** | `widgets/chat/ThreadSidebar.tsx` |
| `ChatPage` | 2434 | **584** | `pages/ChatPage.tsx` (kept, thin) + `hooks/useChatSession.ts` |

Four files carry the weight: `Composer` (543), `ChatPage` itself (584),
`ChatConversation` (322), `HeroComposer` (274).

Hooks to extract, named:

| Hook | from | responsibility |
| --- | --- | --- |
| `ui/src/hooks/useChatSession.ts` | `ChatPage` 2434–3018 | thread selection, send/stream lifecycle, live buffer |
| `ui/src/hooks/useAttachments.ts` | `Composer` | `PendingAttachment[]` state, upload, MIME validation |
| `ui/src/hooks/useSlashPalette.ts` | `Composer` + `SlashPalette` | match/active-index/keyboard nav |
| `ui/src/hooks/useConversationScroll.ts` | `ChatConversation` | stick-to-bottom, scroll restoration |
| `ui/src/hooks/useMessageFeedback.ts` | `FeedbackControls` | thumb state + POST |

Pure helpers to colocate (no React, unit-testable, no mock):
`shared/glossaryHighlight.ts` (term matching from `HighlightedResponse`),
`shared/chatErrors.ts` (`sendErrorMessage`), `widgets/chat/types.ts` (`UIPart`,
`ToolActivityEntry`, `PendingAttachment`).

`HeroComposer` (274) and `Composer` (543) are near-duplicates differing in
chrome. Extract the shared behaviour into `useComposer.ts` and keep two thin
presentational shells — **but only after** both are in their own files, so the
duplication is visible and the diff is reviewable. Do not attempt the
deduplication in the same change as the split.

### 2.3 `TaskDetailDrawer.tsx` — 1,923 lines → 14 files

| Symbol | line | → target |
| --- | ---: | --- |
| `StepSpan`, `RunTimelineStep`, `RunTimelineEntry`, `RunTimeline`, `StepCardEntry` | 37–130 | `widgets/task-detail/types.ts` |
| `applyNavigate`, `crumbLabel` | 131,141 | `widgets/task-detail/navigation.ts` (pure, already exported → already unit-tested; check) |
| `TaskDetailDrawerProps`, `LoadState` | 144,223 | `widgets/task-detail/types.ts` |
| `MINI_*` constants, `miniNodeStyle`, `PositionedMiniNode`, `SubgraphLayout`, `buildSubgraphLayout` | 233–353 | `widgets/task-detail/subgraphLayout.ts` (**pure — 120 lines of layout maths with zero React**) |
| `outcomeLabel`, `humanizeCmd`, `deriveStepSummary`, `spanToCard`, `runStepToCard` | 354–447 | `widgets/task-detail/stepCards.ts` (pure) |
| `SECTION_LABEL`, `SectionLabel`, `StringList`, `MetaCell` | 448–483 | `widgets/task-detail/atoms.tsx` |
| `TaskDetailBody` | 484 | **229 lines** → `widgets/task-detail/TaskDetailBody.tsx` |
| `EVAL_METRIC_DESC`, `EvalChip` | 713,719 | `widgets/task-detail/EvalChip.tsx` |
| `StepStatusIcon` | 746 | `widgets/task-detail/StepStatusIcon.tsx` |
| `AgentToolCallRow` | 802 | `widgets/task-detail/AgentToolCallRow.tsx` |
| `ToolInvocationRow` | 852 | `widgets/task-detail/ToolInvocationRow.tsx` |
| `StepCard` | 949 | **205 lines** → `widgets/task-detail/StepCard.tsx` |
| `StepCardList` | 1154 | `widgets/task-detail/StepCardList.tsx` |
| `ProposalStepTimeline` | 1247 | **126 lines** → `widgets/task-detail/ProposalStepTimeline.tsx` |
| `TaskDetailDrawer` | 1373 | **550 lines** → `widgets/TaskDetailDrawer.tsx` (kept, thin) + `hooks/useTaskDetail.ts` |

The 550-line shell at 1373 holds the data loading (`LoadState`), the navigation
trail, and the drawer chrome. Extract `hooks/useTaskDetail.ts` (fetch + trail +
`LoadState`) and the shell drops to roughly 150 lines of layout.

Highest-value extraction here is `subgraphLayout.ts`: 120 lines of pure
geometry currently untestable without mounting a drawer.

### 2.4 `ui/src/shared/` — three jobs in one folder

| File | lines | problem | split |
| --- | ---: | --- | --- |
| `shared/schemas.ts` | 1,439 | every zod schema for every endpoint in one module; imported by everything, so it is a hub node in the ui SCC | `shared/schemas/<domain>.ts` — one file per API domain (`task`, `chat`, `actionQueue`, `proposal`, `kpi`, `steward`, `workflow`, `trace`, `primitive`), plus `schemas/index.ts` assembly. Domains should mirror `core/app-services.ts`'s view groups. |
| `shared/api.ts` | 1,145 | one fetch client per endpoint, all in one file, each importing from `schemas.ts` | `shared/api/<domain>.ts` matching the schema split 1:1 |
| `shared/routing.ts` | 467 | route table + params + guards | `shared/routing/routes.ts` + `shared/routing/params.ts` |
| `shared/actionQueueDetail.ts` | 379 | fine | leave |

The `schemas.ts` ↔ `api.ts` pair is the backbone of the 6-folder ui SCC
(`widgets/chat → hooks → widgets → entities → shared → components`). Splitting
them by domain is a **prerequisite for breaking that cycle**, because it lets a
widget import `shared/api/chat` without transitively pulling every other
domain's types.

### 2.5 Remaining files, with concrete decompositions

| File | lines | decomposition |
| --- | ---: | --- |
| `pages/EventsPage.tsx` | 1,160 | `widgets/events/EventFilterBar.tsx`, `widgets/events/EventRow.tsx`, `widgets/events/EventDetailPanel.tsx`, `hooks/useEventStream.ts`, `shared/eventFormat.ts` (pure); page shell ≤200 |
| `widgets/topologyFlowModel.ts` | 916 | already pure, no React — split by concern: `topology/nodes.ts`, `topology/edges.ts`, `topology/layout.ts`, `topology/model.ts` |
| `widgets/chat/QueueThreadDetail.tsx` | 895 | `chat/queue/QueueThreadHeader.tsx`, `chat/queue/QueueThreadBody.tsx`, `chat/queue/QueueThreadActions.tsx`, `hooks/useQueueThread.ts` |
| `widgets/chat/ContextRail.tsx` | 776 | `chat/rail/RailSection.tsx`, `chat/rail/RailTaskList.tsx`, `chat/rail/RailGlossary.tsx`, `hooks/useContextRail.ts` |
| `widgets/TopologyView.tsx` | 583 | `topology/TopologyCanvas.tsx`, `topology/TopologyLegend.tsx`, `topology/TopologyControls.tsx`; model already external |
| `widgets/PrimitiveDetailDrawer.tsx` | 566 | mirror the `task-detail/` shape: `primitive-detail/{types,atoms,PrimitiveBody,PrimitiveRunList}.tsx` + `hooks/usePrimitiveDetail.ts` |
| `widgets/chat/AlertCard.tsx` | 564 | `chat/alert/AlertHeader.tsx`, `chat/alert/AlertActions.tsx`, `chat/alert/AlertDiagnosis.tsx`, `shared/alertCopy.ts` (pure) |
| `pages/StewardPage.tsx` | 546 | `widgets/steward/StewardLedgerTable.tsx`, `widgets/steward/StewardControls.tsx`, `hooks/useSteward.ts` |
| `widgets/StudioView.tsx` | 487 | borderline; extract `hooks/useStudio.ts` only if the shell exceeds 400 after that |

### 2.6 The rule that should replace "one file per widget"

"One file per widget" is already satisfied and did not prevent a 3,018-line
file, because `ChatPage.tsx` is a *page*, not a widget. Propose instead, as an
enforceable arch rule:

1. No file in `ui/src` exceeds 400 lines (excluding `components/ai-elements/**`,
   vendored).
2. No file exports more than one React component whose name is not prefixed by
   the file's own name.
3. `pages/*.tsx` contain layout + one hook call; no `useState` beyond UI-local
   toggles.

Rule 2 is what actually catches `ChatPage.tsx` — 24 top-level components in one
file — and rule 1 alone would not have caught `TaskDetailDrawer.tsx` early
enough to matter.

---

## 3. Section C — Big backend files

### 3.1 `core/daemon/server.ts` — 5,972 lines

Structure: 175–467 are module-level helpers; **`startDaemon` runs from line 468
to the end of the file (~5,500 lines) as a single closure.** Everything inside
closes over `bus`, `sems`, `tracker`, `pause`, `dbClient`, `traceStore`,
`resolveContext()`, and ~40 mutable `let`s. That closure is the reason the file
cannot be split by moving text — every extracted function needs the state
passed explicitly.

Responsibilities identified inside the closure:

| Concern | lines (approx.) | ~size | → target |
| --- | --- | ---: | --- |
| Module helpers: `makeSem`/`acquire`/`release`/`setSemLimit`, `pickWorkflowFor`, `selectBestCandidate`, `isDispatchDirtyMainExempt` | 175–345 | 170 | `core/daemon/semaphore.ts` + `core/daemon/dispatch-policy.ts` — **pure, no closure capture, movable today** |
| Logging: `makeWorkflowLogger`, `writeLog`, `LOG_ROTATE_BYTES` | 346–467 | 120 | `core/daemon/logging.ts` |
| Boot: lockfile/pidfile, `spawnReplacementDaemon`, legacy-mastra removal, `scanRecoveryLeafViolations` | 185–207, 409–450, 468–650 | 250 | `core/daemon/boot/{lock,legacy-cleanup,preflight}.ts` |
| Resource construction: pg handle, `dbClient`, `traceStore`, `bus`, `ViewStreamHub`, flight tracker | 630–960 | 330 | `core/daemon/runtime-context.ts` — returns a `DaemonRuntime` object; this is the seam every other extraction depends on |
| Version/staleness: `sourceSha`, `installRoute`, dev auto-restart, `devStalenessCheck` | 971–990, 4863–4960 | 200 | `core/daemon/staleness.ts` |
| Pause/caps/levers | 1008–1082 | 75 | `core/daemon/capacity.ts` |
| **Dispatch**: `dispatchArcVerification`, `scheduleArcVerification`, `dispatchTriage`, `dispatchImplement`, `dispatchGlossaryWrite`, `dispatchAdrAdd`, `dispatchRefine`, `pickNextImplement` | 1090–2146 | **1,056** | `core/daemon/dispatch/{arc-verify,triage,implement,glossary,adr,refine,pick-next}.ts`. `dispatchImplement` alone is 604 lines (1202–1805) — the single largest function in the repo. |
| **Spend/storm control**: `handleQuotaRejection`, `collectStormContext`, `runStormSteward`, `countStewardCommits`, `raiseStormEscalation`, `stormBreaker`, `handleSignatureStorm` | 2147–2507 | **360** | `core/daemon/spend-control/storm.ts` — folder already exists |
| Dispatch hints, composition client, transcript subscriber, scoring pool | 2508–2697 | 190 | `core/daemon/wiring.ts` |
| **Request handlers** (`handleAdd` … `handleProposalTake`, `handleInit`, `handleStatus`) | 2698–3552 | **854** | `core/daemon/handlers/{task,blocker,lifecycle,proposal,status}.ts` — 25 handlers |
| Reconcile/sync/investigate/diagnose | 3553–3846 | 293 | `core/daemon/self-heal.ts` |
| Lease + step handlers | 3847–4000 | 153 | `core/daemon/handlers/step.ts` |
| RPC deps assembly + socket server | 4001–4163 | 162 | `core/daemon/rpc/deps.ts` (see §3.7 — this is inside a 5-file cycle) |
| Alert sources + app services + chat + HTTP boot | 4164–4640 | 476 | `core/daemon/boot/services.ts` |
| Sweepers/probes/poll/merge worker/update poll | 4640–4970 | 330 | `core/daemon/schedulers.ts` |
| Shutdown + drain loop | 4970–5972 | ~1,000 | `core/daemon/drain.ts` + `core/daemon/shutdown.ts` — **NOT VERIFIED — needs a pass** (outline grep stops at 4961; the last ~1,000 lines were not inspected line-by-line) |

**The split order matters and is not free.** Step 1 is `runtime-context.ts`:
turn the ~40 closed-over locals into an explicit `DaemonRuntime` interface
constructed once and threaded as a parameter. Until that exists, every other
extraction produces a function with a 15-argument signature. Everything above
is blocked on it except the pure module-level helpers (semaphore, dispatch
policy, logging), which can move immediately.

### 3.2 `core/arc.ts` — 3,366 lines, ADR-0052 sole writer

The whole file is one class. Methods, with sizes:

| Method | line | ~lines | writes state? |
| --- | ---: | ---: | --- |
| `ArcInvariantError` | 120 | 7 | no |
| `mapStatusToEvent` (module fn) | 137 | 15 | no |
| input/result types | 152–245 | 93 | no |
| `Arc.load` (static) | 264 | 3 | no |
| `Arc.createOrigin` (static) | 278 | ~610 | **YES** — the origin INSERT |
| `transition` | 889 | 42 | **YES** |
| `parkForHuman` | 931 | 63 | **YES** |
| `releaseLease` | 994 | 35 | **YES** |
| `reprioritize` | 1029 | 54 | **YES** |
| `insertReflection` | 1083 | 81 | **YES** |
| `spawnRecovery` | 1164 | 213 | **YES** |
| `attachToRecovery` | 1377 | 94 | **YES** |
| `spawnMainCommitterRecovery` | 1471 | 128 | **YES** |
| `addBlocker` | 1599 | 59 | **YES** |
| `removeBlocker` | 1658 | 18 | **YES** |
| `clearBlockers` | 1676 | 16 | **YES** |
| `addPendingReviewBlockers` | 1692 | 110 | **YES** |
| `drop` | 1802 | **958** | **YES** |
| `recoverBlocked` | 2760 | **307** | **YES** |
| `propagateRecoveryDone` | 3067 | **277** | **YES** |
| `Arc.deriveChecklist` (static) | 3344 | 22 | no |

#### How to split this without creating a second writer

ADR-0052 says the Arc aggregate root is the **sole writer** of task/arc state.
That constraint is about *who issues the write*, not *how many files the class
body is typed into*. Three moves, in strict order:

**Move 1 — extract pure functions (no writer risk at all).** `mapStatusToEvent`,
`deriveChecklist`, the input/result interfaces, and every decision predicate
buried inside the big methods (which recovery to spawn, whether a blocker set is
settled, what the drop cascade should be) are pure. They compute *what* to
write; they do not write. Targets:

```
core/arc/types.ts          <- UpsertFixTaskInput, …Result, CreateOriginSpec, ProgressEntry, AppendProgressParams
core/arc/status-map.ts     <- mapStatusToEvent
core/arc/checklist.ts      <- deriveChecklist
core/arc/policy/recovery.ts   <- "should we spawn / attach / escalate" decision, pure
core/arc/policy/drop.ts       <- drop cascade computation, pure
core/arc/policy/blockers.ts   <- settled-set / unblock computation, pure
```

This alone takes several hundred lines out and makes the recovery and drop
policies unit-testable without a database.

**Move 2 — split the class body across files using TypeScript's
declaration-merging-free option: `Arc` stays one class, methods become thin
delegates to functions that take the store as an explicit first parameter.**

```ts
// core/arc/index.ts — the ONLY export named Arc
export class Arc {
  async drop(): Promise<DropTaskResult> { return dropArc(this.store, this.arcId) }
  async recoverBlocked(): Promise<RecoverBlockedTaskOutcome> { return recoverBlocked(this.store, this.arcId) }
  …
}
```

```
core/arc/ops/create-origin.ts
core/arc/ops/transition.ts
core/arc/ops/lease.ts            <- parkForHuman, releaseLease
core/arc/ops/priority.ts         <- reprioritize
core/arc/ops/reflection.ts       <- insertReflection
core/arc/ops/recovery.ts         <- spawnRecovery, attachToRecovery, spawnMainCommitterRecovery
core/arc/ops/blockers.ts         <- addBlocker, removeBlocker, clearBlockers, addPendingReviewBlockers
core/arc/ops/drop.ts             <- drop (958 lines — split further inside)
core/arc/ops/recover-blocked.ts  <- recoverBlocked (307)
core/arc/ops/propagate.ts        <- propagateRecoveryDone (277)
```

**The sole-writer invariant is preserved by three enforceable rules, not by
hope:**

1. Everything under `core/arc/ops/**` is **not exported from the package
   surface**. `core/arc/index.ts` exports `Arc`, the types, and nothing else.
   No file outside `core/arc/**` may import from `core/arc/ops/**`.
2. `core/arc/ops/**` files take the store as an explicit parameter and never
   call `getDefaultDomainTaskStore()` / `getDefaultTaskStore()`. Only
   `core/arc/index.ts` resolves the default store (currently `arc.ts:264-265`
   and `:293`).
3. An arch rule (Section D) asserts: no module outside `core/arc/**` imports
   `updateTask`, `enqueueTask`, `dropTask`, `setTaskPriority`, `addBlockers`,
   `removeBlocker`, `clearBlockers`, `unblockTask`, or `reopenTerminalTask`
   from `core/queue.ts`.

Rule 3 is the one that actually matters and **it is very likely violated
today** — `core/queue.ts` exports all of those as free functions
(`queue.ts:1080, 1117, 1568, 1720, 1760, 1782, 1802, 1814, 1821, 1988`), and
`arc.ts:290` itself calls `enqueueTask`'s underlying path. **NOT VERIFIED —
needs a pass:** enumerate current importers of those symbols before writing the
rule; the rule must be written as a failing test first, then the violations
fixed, then the arc split proceeds. If the sole-writer invariant is already
broken, splitting `arc.ts` neither helps nor hurts it — but the split is the
right moment to close it, and doing the split without closing it bakes the
violation into ten files instead of one.

**Move 3 — `drop` (958 lines) is a file of its own and still too big.** It is
the drop cascade: worktree removal, branch removal, blocker-edge cleanup,
dependent handling, action-queue reconciliation, reporting
(`worktree=…; branch=…; edges=…`). Split inside `core/arc/ops/drop/`:
`plan.ts` (pure — compute the cascade), `worktree.ts`, `edges.ts`,
`report.ts`, `index.ts` (orchestrate). The pure `plan.ts` is what lets the
"deleting a row out from under its dependents" hazard in CLAUDE.md become a
test instead of a war story.

### 3.3 `workflows/primitives/index.ts` — 3,436 lines

This file exports the step primitives that ADR-0056 assigns to the **engine**
layer. Six primitives plus a shared preamble:

| Symbol | line | ~lines | → target |
| --- | ---: | ---: | --- |
| `buildSessionKey` | 157 | ~150 | `primitives/session-key.ts` (pure) |
| `traceCache`/`resolveTrace` | 307,316 | 25 | `primitives/context/trace.ts` |
| `worktreeCache`/`resolveWorktree` | 332,348 | 40 | `primitives/context/worktree.ts` |
| `input`, `validationRecorder`, `resolveTaskId`, `buildPhaseCtx`, `spanStore` | 373–497 | 125 | `primitives/context/ctx.ts` |
| `ensureWorktreeCurrent` | 498 | 157 | `primitives/setup/ensure-current.ts` |
| **`setupWorktree`** | 655 | **425** | `primitives/setup-worktree.ts` |
| **`runAgent`** | 1080 | **725** | `primitives/run-agent.ts` (+ `run-agent/{provider,stream,transcript}.ts`) |
| **`review`** | 1805 | **853** | `primitives/review.ts` (+ `review/{gates,report}.ts`) |
| `INTEGRATION_GATE_TIMEOUT_MS` + **`merge`** | 2658,2684 | **599** | `primitives/merge.ts` |
| **`awaitHuman`** | 3283 | **135** | `primitives/await-human.ts` |
| **`finalizeReport`** | 3418 | ~18 | `primitives/finalize-report.ts` |

`index.ts` becomes a re-export barrel of ~15 lines. Note that
`workflows/primitives/` already contains `shared.ts`, `opts-descriptors.ts`,
`app-boot-discovery.ts`, `behaviour-verify.ts`, `browser-check.ts` — the folder
convention exists; `index.ts` simply never adopted it.

`review` (853) and `runAgent` (725) each deserve a sub-folder. `review` is the
verify gate and is the most-referenced primitive from workflow definitions;
`runAgent` carries provider selection (Codex/Claude/Gemini), stream handling,
and transcript persistence — three separable concerns.

### 3.4 `core/daemon/http-server.ts` — 2,683 lines

Verified: lines 685–2683 are **one `startHttpServer` function containing a flat
chain of ~90 `if (req.method === … && req.url === …)` branches.** No router.

| Concern | lines | → target |
| --- | --- | --- |
| Upload constants, MIME tables | 61–95 | `http/upload-policy.ts` |
| `ChatThreadsQuerySchema` + other zod query schemas | 96–505 | `http/schemas.ts` |
| `isRestartTaskError`, `sendJson`, `sendError` | 506–570 | `http/respond.ts` |
| Trace-event filter parsing + `handleEventsRequest` | 571–684 | `http/routes/events.ts` |
| health/liveness | 710–744 | `http/routes/health.ts` |
| failure-kinds, recipes, agents/live | 745–838 | `http/routes/diagnostics.ts` |
| kpis | 894–918 | `http/routes/kpis.ts` |
| **`/view/*` (≈40 branches)** | 919–1578 | `http/routes/view/{tasks,glossary,skills,adrs,stream,progress,step-spans,step-prompt,agent-tool-calls,primitives,sessions,framework-update,proposals,reflect,steward,scorer,workflow-configs,promotion-ledger,loop-ledger,arcs,terminal-events,release-notes,auto-recipe-runs,steward-ledger,wywa-delta,action-queue,chat}.ts` |
| alerts | 1579–1660 | `http/routes/alerts.ts` |
| chat (threads, subjects, history, conversation, config, codex-auth) | 1661–2460 | `http/routes/chat/*.ts` |
| remaining POSTs | 2460–2683 | **NOT VERIFIED — needs a pass** |

The mechanical prerequisite: introduce a real route table
(`http/router.ts` — `Array<{method, pattern, handler}>` matched once) so a
"route file" can register itself. Without it, splitting only moves `if`
branches into imported predicates and the chain stays.

Every `/view/*` handler is a one-to-three-line delegate to `appServices.viewX`
(see `core/app-services.ts:171-260`). So the `/view/*` block is ~660 lines of
pure boilerplate over an interface that already exists — it is a strong
candidate for a single table-driven file
(`http/routes/view/table.ts`: `{'/view/tasks': s => s.viewTasks()}`) instead of
27 files. **Recommendation: table, not 27 files.** This is the one place in this
document where more files is the wrong answer.

### 3.5 `core/queue.ts` — 2,173 lines

Currently: constants + type guards + row mappers + SQL + ~35 exported free
functions. Split by role, not by table:

| Concern | lines | → target |
| --- | --- | --- |
| Status/tag/type constants + guards (`TERMINAL_TASK_STATUSES`, `SETTLED_BLOCKER_STATUSES`, `NON_DISPATCHABLE_STATUSES`, `isDispatchableStatus`, `BLOCKER_STATES`, `TASK_TAGS`, `TASK_TYPES`, `MIN/MAX_PRIORITY`, `validatePriority`, `deriveTaskKind`, `assertTaskKindInvariant`) | 59–612 | `core/task/status.ts` + `core/task/tags.ts` + `core/task/priority.ts` — **pure, zero deps, movable today, and the single biggest cycle-breaking win in the repo** |
| `IllegalTransitionError` | 136 | `core/task/errors.ts` |
| Client/schema (`resolveQueueClient`, `ensureQueueSchema`, `migrateQueueSchema`) | 614–641 | `core/store/queue-client.ts` |
| Transcript (`capConversationJson`, `upsertTranscript`, `getTranscript`) | 642–757 | `core/store/transcript-store.ts` — **this is not queue code** |
| Row mapping (`TASK_SEL`, `rowToTask`, `parseQaReport`, `coerceFailedPhase`, `parseStringArray`, `rowToTaskSpec`, `coerceToString`) | 758–1079 | `core/store/task-row.ts` |
| **Writes** (`enqueueTask`, `updateTask`, `reopenTerminalTask`, `setTaskPriority`, `dropTask`, `insertReflectionTask`, `addBlockers`, `addPendingReviewBlockers`, `removeBlocker`, `clearBlockers`, `unblockTask`, `promoteDraftToTriaging`, `promoteDraftToQueued`, `deriveFailureSignature`) | scattered | `core/store/task-writes.ts` — **and then made non-public per §3.2 rule 3** |
| Reads (`getTask`, `listTasks`, `listNonDoneTasks`, `filterExistingTaskIds`, `listTasksPaged`, `listSiblings`, `listBlockers`, `listAllBlockers`, `hasIncompleteBlockers`) | scattered | `core/store/task-reads.ts` |
| Proposal-blocker functions (`addProposalBlockers`, `listProposalBlockers`, `removeProposalBlocker`, `listTasksBlockedByProposal`, `transferProposalBlockerToTask`, `listTasksForProposal`) | 1838–2038 | `core/store/proposal-blocker-store.ts` — **belongs to the Proposal aggregate, not the queue** |

`core/queue.ts` is the top hub of the 22-folder SCC. The pure-constants
extraction (row 1) is what most other modules actually need from it, and it
carries zero imports — extracting it removes the largest number of cycle edges
per line moved of anything in this document.

### 3.6 `core/app-services.ts` — 1,511 lines

`AppServicesDeps` (128) + `AppServices` (171, ~50 methods) + `createAppServices`
(295, ~1,215 lines of a single object literal). Split by the same domains as
`ui/src/shared/schemas.ts` (§2.4), so the API contract has one vocabulary
end-to-end:

```
core/app-services/index.ts         <- createAppServices, composes the below
core/app-services/types.ts         <- AppServicesDeps, AppServices
core/app-services/action-queue.ts  <- viewActionQueue, viewActionQueueHistory, buildSituationReport
core/app-services/alerts.ts        <- viewAlerts, viewAlert, nextActionAlert, startThreadFromAlert
core/app-services/tasks.ts         <- viewTasks, viewTask, viewProgress
core/app-services/proposals.ts     <- viewProposals, viewProposal
core/app-services/trace.ts         <- viewStepSpans, viewRunTimeline, viewStepPrompt, viewAgentToolCalls, viewSessions, viewTerminalEvents
core/app-services/primitives.ts    <- viewPrimitives, viewPrimitive
core/app-services/kpis.ts          <- listKpis, listKpisSeries, listKpiArcs
core/app-services/reflect.ts       <- viewReflect, viewArcs, viewScorerTrend, viewScorerWorkflows
core/app-services/workflow.ts      <- viewWorkflowConfigs, viewPromotionLedger, viewLoopLedger
core/app-services/knowledge.ts     <- viewGlossary, viewSkills, viewAdrs
core/app-services/chat.ts          <- viewChatThreads, viewChatThread, viewChatHistory, viewChatConversation, openSubject
core/app-services/steward.ts       <- viewSteward
core/app-services/release-notes.ts <- viewReleaseNotes, viewFrameworkUpdate
```

Each sub-module is `(deps: AppServicesDeps) => Pick<AppServices, …>`; `index.ts`
spreads them. Note `AppServices` currently uses inline `import('./lib/chat-store')`
types at lines 244–247 — those become real imports in `chat.ts`.

This file is also ADR-0055's single application-service layer, so it is the
seam the daemon, CLI, UI, and TUI all sit on. It participates in a 3-file cycle
(`core/app-services ↔ daemon/http-server ↔ core/lib/primitive-catalog`) — see
§3.7.

### 3.7 The named cycles, and which splits they block

| Cycle | files | fix |
| --- | --- | --- |
| 5-file | `core/daemon/rpc/handlers.ts → rpc/registry.ts → rpc/types.ts → daemon/server.ts → rpc/handlers.ts` | `rpc/types.ts` must not import from `daemon/server.ts`. `DaemonDeps` (built at `server.ts:4014`) should be declared in `rpc/types.ts` and *constructed* in `server.ts`. Move the type; the cycle dies. **Blocks: §3.1 rpc/deps extraction.** |
| 4-file | `core/workers/provider-bin.ts ↔ providers.ts ↔ providers/codex-headless.ts ↔ providers/gemini-headless.ts` | Extract the `Provider` interface + tier→model mapping into `core/workers/provider-types.ts` that nobody imports back from. **Blocks: §3.3 `run-agent` extraction.** |
| 3-file | `daemon/chat-runner ↔ chat-stream-hub ↔ ui-message-chunks` | Extract chunk types into `chat/chunk-types.ts`. **Blocks: §3.4 chat route split.** |
| 3-file | `core/app-services ↔ daemon/http-server ↔ core/lib/primitive-catalog` | `primitive-catalog` should not reach back into `app-services`; invert with a passed-in catalog. **Blocks: §3.6.** |
| 34-file | `core/arc.ts, core/queue.ts, core/lib/action-queue.ts, core/blocker-resolution.ts, core/daemon/kpi-store.ts, core/lib/action-queue-recipes.ts` + 28 more | Start with §3.5 row 1 (pure task constants). Most of these 34 files import `core/queue.ts` only for status constants and type guards. **Blocks: §3.2 in practice** — splitting `arc.ts` into ten files while it sits in a 34-file cycle multiplies the cycle's edge count. |
| 6-folder ui SCC | `widgets/chat, hooks, widgets, entities, shared, components` | §2.4 (domain-split `schemas.ts`/`api.ts`) is the unblock. |

---

## 4. Section D — Sequencing

Every step below depends only on steps above it. No step requires a later one.

| # | Step | Depends on | Blocked by a cycle? | Effort |
| ---: | --- | --- | --- | --- |
| 0 | Choose the LOC convention (§0.1) and pick a measurement command; record it. | — | no | minutes |
| 1 | Remove the last `process.exit` from `cli/commands/shared.ts`. | — | no | S |
| 2 | **Delete `cli.ts`'s `usage` + `COMMAND_HELP` (1,431 lines); generate help from the registry.** `cli.ts` → ~220 lines. | — | no | M — highest value/effort ratio in the document |
| 3 | Extract pure constants from `core/queue.ts` → `core/task/{status,tags,priority,errors}.ts`; update every importer. | — | **breaks** the 34-file cycle | M |
| 4 | Extract pure module-level helpers from `daemon/server.ts` → `semaphore.ts`, `dispatch-policy.ts`, `logging.ts`. | — | no | S |
| 5 | Move `DaemonDeps` type to `rpc/types.ts`. | — | **breaks** the 5-file rpc cycle | S |
| 6 | Extract `Provider` types → `core/workers/provider-types.ts`. | — | **breaks** the 4-file provider cycle | S |
| 7 | Extract chat chunk types → `chat/chunk-types.ts`. | — | **breaks** the 3-file chat cycle | S |
| 8 | Split `ui/src/shared/schemas.ts` + `api.ts` by domain. | — | **breaks** the 6-folder ui SCC | M |
| 9 | Write the arch test harness. No linter exists, so this is a **test**, not a lint rule: a vitest suite running dependency-cruiser 18.1.0 programmatically, asserting (a) no cycles among the folders fixed in 3/5/6/7/8, (b) ADR-0056 layer direction as folders appear, (c) one `Command` per file under `cli/commands/**`, (d) no `process.exit` under `cli/commands/**`, (e) nobody outside `core/arc/**` imports the write functions, (f) no `ui/src` file >400 lines outside `components/ai-elements/**`. Rules start as allow-listed known violations that only shrink. | 3,5,6,7,8 | no | L — **do this before any bulk move**; it is the only thing that keeps the split from re-drifting, and there is no linter to fall back on |
| 10 | Split `cli/commands/misc.ts` into its 9 namespaces; delete `misc.ts`. | 2, 9 | no | M |
| 11 | Split the remaining CLI groups leaf-by-leaf (§1.3), largest first: `proposal`, `lifecycle`, `workflow`, `reflect`, `daemon`, `install`, `task`. | 2, 9, 10 | no | L, but embarrassingly parallel — one task per group |
| 12 | Split `ChatPage.tsx` (§2.2). | 8, 9 | no | L |
| 13 | Split `TaskDetailDrawer.tsx` (§2.3). | 8, 9 | no | M |
| 14 | Split the remaining ui files >400 lines (§2.5). | 8, 9 | no | L, parallel |
| 15 | Split `workflows/primitives/index.ts` (§3.3). | 6 | no | M |
| 16 | Split `core/app-services.ts` by domain (§3.6). | 8 (shared vocabulary), cycle fix for primitive-catalog | yes — §3.7 row 4 | M |
| 17 | Introduce `http/router.ts` route table; move `/view/*` to a table (§3.4). | 16 | no | M |
| 18 | Split the rest of `http-server.ts` into route files. | 17 | no | M |
| 19 | Split `core/queue.ts`'s remaining concerns (writes/reads/transcript/rows/proposal-blockers) (§3.5). | 3 | no | M |
| 20 | **Audit the sole-writer invariant**: enumerate importers of `updateTask`/`enqueueTask`/`dropTask`/… outside `core/arc.ts`. Write the arch rule as a failing test, fix violations. | 19 | no | M — **must precede 21** |
| 21 | Split `core/arc.ts` (§3.2): pure policy first, then `ops/`, then `ops/drop/`. | 3, 19, 20, 9 | yes — needs step 3's cycle fix landed | L |
| 22 | Build `core/daemon/runtime-context.ts` (`DaemonRuntime`). | 4, 5 | no | L — the hard one |
| 23 | Extract dispatch, handlers, storm, self-heal, schedulers, drain from `daemon/server.ts`. | 22 | no | L, parallel after 22 |
| 24 | With `engine`/`domain`/`adapters` shapes now visible, create the ADR-0056 folders and move; turn arch rule (b) from allow-listed to strict. | 9, 21, 23 | no | L |

**Blocked-on-cycle-breaking, explicitly:** steps 16 and 21. Everything else is
either a cycle fix itself (3, 5, 6, 7, 8) or independent of the cycles.

**Do not start at step 21 or 23** even though `arc.ts` and `server.ts` are the
biggest files. They are the most-coupled, the most invariant-carrying, and the
most expensive to get wrong. Steps 2, 3, 4 deliver ~1,700 lines of reduction and
the largest cycle break for a fraction of the risk.

**ADR-0056 note.** The engine/domain/adapters folders do not exist and no arch
test was ever built. This document does **not** propose creating those three
folders first and moving files into them. The reason: the file-level splits in
Sections A–C are what make the layer boundaries visible. Creating the folders
first means guessing which layer a 5,972-line file belongs to — it belongs to
all three. Step 24 creates them last, when each moved file has one obvious home.
That is a sequencing claim, not a disagreement with ADR-0056.

---

## 5. Section E — Tests

Tests are 177,444 LOC / 676 files against 142,944 LOC / 565 source files — a
1.24:1 ratio. Measured largest:

| Test file | lines |
| --- | ---: |
| `orchestrator/src/workflows/__tests__/slice-workflow.test.ts` | 4,032 |
| `orchestrator/src/core/lib/__tests__/queue-fix-tasks.test.ts` | 2,059 |
| `orchestrator/src/core/lib/__tests__/fix-recipes.test.ts` | 1,748 |
| `orchestrator/src/core/lib/__tests__/run-worker-with-span.test.ts` | 1,603 |
| `orchestrator/src/core/lib/__tests__/git.test.ts` | 1,422 |
| `orchestrator/src/core/lib/__tests__/blocker-resolution.test.ts` | 1,411 |
| `orchestrator/src/core/daemon/__tests__/chat-runner.test.ts` | 1,316 |
| `orchestrator/src/core/lib/__tests__/worktree-install.test.ts` | 1,276 |
| `orchestrator/src/core/lib/__tests__/kpi-compute.test.ts` | 1,194 |
| `orchestrator/src/outbox/subscribers/action-queue-raisers.test.ts` | 1,104 |
| `orchestrator/src/outbox/subscribers/recovery-spawn.test.ts` | 1,063 |
| `orchestrator/src/core/daemon/view/__tests__/action-queue.test.ts` | 1,016 |
| `orchestrator/src/core/lib/__tests__/main-dirty.test.ts` | 1,000 |
| `orchestrator/src/core/lib/action-queue.test.ts` | 980 |

### Recommendation: **mostly OUT of scope, with three carve-outs.**

**Out of scope — the bulk.** Splitting a test file changes no behaviour, buys no
architecture, and costs the one thing that makes the source split safe: a green
suite you trust across the move. During steps 1–24 the test suite is the only
safety net (there is no linter and no type-level arch enforcement until step 9).
Refactoring the net while walking the tightrope is the wrong order. A 4,032-line
test file is unpleasant to read and completely harmless to run.

Note also that test file placement is inconsistent — `__tests__/` folders in
some places (`core/lib/__tests__/`), colocated `.test.ts` in others
(`outbox/subscribers/recovery-spawn.test.ts`, `core/lib/action-queue.test.ts`,
`cli/commands/task.test.ts`). Normalising that is a separate, purely-mechanical
change and should be its own task, after step 24.

**Carve-out 1 — tests move with their subject, always.** When `proposal.ts`
splits into 21 leaf files, `cli/commands/__tests__/proposal.test.ts` (if it
exists) splits alongside, or the split is not done. A test file left pointing at
a deleted module is a hard cut violation. This is not "splitting tests as a
project"; it is part of each source split's definition of done.

**Carve-out 2 — `slice-workflow.test.ts` (4,032) is in scope, at step 11-ish.**
It is 2.2× the size of its subject (`workflows/slice-workflow.ts`, 1,818). That
inversion means the test is doing integration work the source does not expose a
seam for. Split it by scenario
(`slice-workflow/{happy-path,blockers,recovery,structured-spec,edge-cases}.test.ts`)
**and** treat the split as a design signal: whatever fixture setup is duplicated
across the five files is the seam `slice-workflow.ts` is missing.

**Carve-out 3 — new tests are required, not optional, for exactly three splits.**
Each of these extracts pure logic that has never been directly testable, and the
split is worthless if nobody writes the test that the extraction enables:

| Extraction | new test |
| --- | --- |
| `core/arc/policy/drop.ts` (§3.2 Move 3) | drop-cascade planning, incl. the dangling-edge hazard from CLAUDE.md |
| `ui/src/widgets/task-detail/subgraphLayout.ts` (§2.3) | 120 lines of geometry, currently needs a mounted drawer |
| `cli/commands/task/add-spec.ts` (§1.3) | `ParsedArgs → CreateOriginSpec`, the full `--files/--verify/--done/--type/--priority/--tag/--blocked-by` matrix |

And one net-new suite that is not a split at all: **step 9's arch test.** It has
no existing counterpart and is the load-bearing deliverable of this whole plan.

---

## 6. Open decisions for the human

1. **LOC convention** (§0.1) — raw `wc -l` or comment-stripped. All numbers here
   are raw.
2. **Tiny CLI files** (§1.3) — apply the one-Command-per-file rule to the ~25
   files already at 1–2 leaves and under 120 lines, or exempt them? This plan
   recommends applying it, on enforceability grounds, and notes the cost.
3. **`/view/*` HTTP routes** (§3.4) — 27 route files, or one table? This plan
   recommends the table and is the only place it argues for fewer files.
4. **Sole-writer audit before or after the arc split** (§3.2 rule 3, step 20) —
   this plan sequences the audit first and will not split `arc.ts` until it
   passes.
5. **ADR-0056 folders last** (step 24) — confirm this does not read as
   contradicting the ADR. The layers are accepted; only their creation order is
   being argued.

## 7. Sections marked NOT VERIFIED

| Where | What |
| --- | --- |
| §1.3 `doctor.ts` | the exact check list inside lines 1–335 |
| §1.3 `preview-validation.ts` | no `path:` grep hit — how does it register a Command? |
| §1.3 `shared.ts` | which helper holds the one `process.exit` |
| §1.3 `lifecycle.ts` | per-leaf attribution of the 8 dynamic imports |
| §3.1 `daemon/server.ts` 4970–5972 | ~1,000 lines not inspected line-by-line (drain loop + shutdown) |
| §3.4 `http-server.ts` 2460–2683 | trailing POST handlers not enumerated |
| §3.2 rule 3 | current importers of `core/queue.ts` write functions — the sole-writer invariant may already be broken |
