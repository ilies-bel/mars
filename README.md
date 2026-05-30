# Mars Framework

A lean, local-first, no-API-key alternative to managed agent platforms.
Mars runs Claude Code in parallel git worktrees against a single repo,
governed by a TypeScript CLI and a SQLite database that lives next to
the project.

See [`VISION.md`](./VISION.md) for the target state and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for what exists today.

## Install

```sh
curl -sSL https://github.com/ilies-bel/mars/releases/latest/download/get-mars.sh | bash
```

Bootstraps the `mars` CLI for your OS/arch (`darwin`/`linux` ×
`arm64`/`x86_64`). Re-run the same command to upgrade.

### Install from source

```sh
curl -fsSL https://raw.githubusercontent.com/ilies-bel/mars/main/install-dev.sh | bash
```

The source installer:

- installs [Bun](https://bun.sh) if missing,
- clones this repo into `~/.mars` (override with `MARS_HOME`),
- builds a standalone `mars` binary,
- symlinks `~/.local/bin/mars` (override with `MARS_BIN_DIR`).

Re-running the command updates the checkout and rebuilds.

If `~/.local/bin` is not on your `PATH`, the installer prints the line to
add to your shell profile.

Verify:

```sh
mars --version
```


### Uninstall

```sh
mars uninstall           # prompts for confirmation
mars uninstall --yes     # non-interactive, for scripted runs
```

Removes:

- the `mars` wrapper binary (the symlink under `~/.local/bin/`, or
  whatever `MARS_BIN_DIR` points at),
- the source clone at `~/.mars` (or `MARS_HOME`).

Leaves alone:

- per-repo `.mars/` and `.worktrees/` directories inside your projects —
  Mars never touches the working trees of repos it ran against.
- the `PATH` export line the installer told you to add to your shell rc.
  Remove that line from your `~/.bashrc` / `~/.zshrc` / equivalent
  manually if you no longer want `~/.local/bin` on `PATH`.

### Requirements

- **git** — Mars manages worktrees and merges.
- **[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI** on
  `PATH`, authenticated. Every LLM call shells out to `claude -p`; there
  are no provider SDKs or API keys.
- **Bun** — the CLI is built and run with Bun. The installer installs it
  if missing.
- **Node `>=22.13.0`** — only needed if you hack on the orchestrator
  source (`cd orchestrator && npm run dev`).

## Quick start

```sh
# 1 — install the binary (once per machine)
curl -sSL https://github.com/ilies-bel/mars/releases/latest/download/get-mars.sh | bash

# 2 — inside your target repo: scaffold state, activate mars:* skills,
#     and get the dashboard launch command — all in one step
mars init

# 3 — add work and watch it run
mars task add "implement X in src/foo.ts"
# the daemon auto-spawns on the first write and dispatches the task
mars list                                # see current statuses
```

The full CLI reference and runtime details live in
[`orchestrator/README.md`](./orchestrator/README.md).

## Workflow

Mars has two lanes into the executor: a **direct lane** for shaped work
(`mars task add`) and a **shaping lane** for fuzzy work (`mars idea add`
→ slice → tasks). Both end at the same dispatcher.

### Direct lane — shaped work

Use when the change has a clear file, symptom, and fix in one sentence.

```
                       mars task add "<prompt>"
                                 │
                                 ▼
                       tasks row: status=queued
                                 │
                                 ▼
                            (daemon picks)
                                 │
                                 ▼
   ┌───────────────────────────────────────────────────────────┐
   │  Implement workflow (orchestrator/src/mastra/workflows/   │
   │                       implement-workflow.ts)              │
   │                                                           │
   │   1. setup-worktree                                       │
   │      git worktree add -b task/<id>                        │
   │        .mars/worktrees/<id> <integration>                 │
   │      status: queued → running                             │
   │                                                           │
   │   2. run-claude-code                                      │
   │      claude -p "<prompt + plans + supervisors>"           │
   │        --output-format json                               │
   │        --dangerously-skip-permissions                     │
   │      20-min timeout. Captures session_id.                 │
   │                                                           │
   │   3. verify   status: running → verifying                 │
   │      typecheck → tests → lint  (sequential, fail-fast)    │
   │                                                           │
   │   4. merge    acquire .merge.lock (5-min ttl, file lock)  │
   │      git merge task/<id> → integration                    │
   │      on conflict: claude -p with vcs-supervisor.md        │
   │      inlined ("Vega") to reconcile intent + re-verify.    │
   │      unresolvable: merge --abort, status=failed.          │
   │      status: merging → done; worktree removed.            │
   └───────────────────────────────────────────────────────────┘
```

Coding runs unlimited-parallel; the **merge step is serialized** by
`.mars/.merge.lock`. Per-kind concurrency caps (triage / implement /
refine / structured-write) are configurable via `MARS_MAX_*` env vars
and `mars daemon reload`.

### Shaping lane — fuzzy work

Use when the ask is exploratory ("should we…?", introduces a new term,
or touches multiple modules). Conversation only until a PRD exists.

```
   mars idea add "<goal>"        ──►  ideas row: status=draft
            │
            │  /mars:grill <id>   (challenges plan against CONTEXT.md,
            │                     curates glossary + ADRs inline)
            ▼
   /mars:to-prd <id>             ──►  ideas row: status=prd-ready
            │
            ▼
   mars idea slice <id>          ──►  N tracer-bullet tasks
                                       (one per vertical slice,
                                        blocker edges wired)
            │
            ▼
                 each slice flows through the Implement workflow above
```

Blocker edges (`mars block <task> <blocker>`) hold a task in
`status=blocked` until every listed blocker reaches `done`.

### Triage and the action queue

Drafts created with the deprecated `mars add` verb land in
`status=draft`. `mars triage` (Haiku-backed) assesses actionability and
blockers, then either promotes to `queued` or surfaces an action queue item.

The action queue is the single backlog of human attention:

- **`mars action-queue`** — open items, grouped by priority.
- **`mars action-queue raise --from -`** — file an item from JSON on stdin
  (preferred over one-shot scripts).
- **SessionStart hook** — `mars action-queue --lean` injects a compact snapshot
  (top blockers + drafts) at the start of every Claude Code session;
  Claude proposes one specific next action per session.

### Glossary and ADRs (structured writes)

Edits to `CONTEXT.md` (the glossary) and `docs/adr/**` never touch the
working tree directly. They route through the daemon's **structured-
write** path: fresh worktree off `integration` → deterministic edit →
commit → merge through the same lock as the implement workflow.

```sh
mars glossary set "<term>" "<definition>" [--avoid alias1,alias2]
mars glossary remove "<term>"
mars adr add "<title>" "<body|@path>"
```

### Reflection

`mars reflect` synthesises draft ideas from recent completed tasks
(token spend, scorer signals); `mars arc reflect <originId>` walks every
task in one arc's stored `claude -p` transcripts event-by-event to
surface dissonant tool calls and verify-claim mismatches (a one-task
arc collapses to that single transcript). Both write back as drafts in
`ideas` — they never auto-run. Disable signal capture with
`MARS_REFLECT_DISABLED=1`.

### Daemon

`mars daemon <start|stop|status|reload>`. CLI write ops auto-spawn the
daemon on demand (`start --detach`). The daemon polls `queue.db`,
claims rows atomically (`status='queued' AND not in-flight`), and
dispatches into the workflows above. `reload` re-reads
`.mars/daemon.json` (and `MARS_MAX_*` env vars) without restarting.

### Task status machine

```
   draft  ─►  queued  ─►  running  ─►  verifying  ─►  merging  ─►  done
     │          ▲                                                    
     │          │                                                    
     └─ blocked ┘   (released when every blocker reaches `done`)     
                                                                     
   any step on failure  ─►  failed   (worktree retained for triage)
   purge / drop         ─►  dropped  (row + worktree + branch gone)
```

| Status | Meaning |
| --- | --- |
| `draft` | Created but not actionable yet. Cleared by `mars triage` or `mars set-functional/--technical`. |
| `queued` | The claimable state — the daemon picks up tasks directly from `queued`. A task auto-promotes from `draft` to `queued` once its functional and technical plan sections are both non-empty. |
| `blocked` | Has one or more open `task_blockers` edges. |
| `running` / `verifying` / `merging` | In-flight inside the implement workflow. |
| `done` | Merged into the integration branch. |
| `failed` | Any step failed; worktree retained. `mars continue <id>` resumes from the failed phase on the same worktree, `mars restart <id>` wipes and re-runs from setup, `mars purge <id>` deletes. |
| `dropped` | Explicitly discarded; row + worktree + branch removed. |

### Other workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `triage` | `mars triage [<id>]` | Haiku-backed assessment of one draft (or all drafts in parallel): `actionable=true/false`, blocker count, optional auto-promotion to `queued`. |
| `plan` | `mars plan <id>` (or `mars add --draft`) | Calls `claude -p` against a draft's prompt and writes `task_suggestions` rows for the user to accept/dismiss. |
| `slice` | `mars idea slice <id>` | Decomposes a PRD-ready idea into N tracer-bullet vertical-slice tasks with blocker edges wired between dependent slices. |
| `ab` | `mars ab "<instruction>" --variants <file>` | Two-variant experiment pinned to the same base SHA, judged by an LLM rubric. No merge — both worktrees retained. |

### Task lifecycle commands

| Command | Purpose |
| --- | --- |
| `mars continue <id>` | Resume a failed task on its existing worktree, jumping straight into the failed phase (verify or merge). Refuses when the task failed in setup/code or lost its worktree on disk. |
| `mars restart <id>` | Re-queue a failed/done task from setup (cleans worktree + branch first). |
| `mars purge <id>` | Delete a failed/done task entirely (worktree + branch + row). |
| `mars block <task> <blocker>...` | Add blocker edges; task waits until each blocker reaches `done`. |
| `mars unblock <id>` | Phantom-recovery: flip `blocked → failed` and clear every edge for `<id>`. |
| `mars unblock <id> <blocker>...` | Edge-removal: drop the named edges only; status untouched. |
| `mars worktree clean [--dry-run] [--force] [--force-orphans]` | Classify directories under `.mars/worktrees/` against `queue.db` and remove the safe ones (done+merged, failed/dropped+zero-commit, orphan zero-commit). Refuses if the daemon is running unless `--force`. |
| `mars where` | Print resolved repo + state directory. |
| `mars list [status]` | List tasks (optionally filtered by status). |
| `mars show <id>` | Print full detail for a task or idea (tries `queue.db`, then `state.db`). |

### A/B experiments

```sh
mars ab "<instruction>" --variants ./variants.json
```

`variants.json` must contain exactly two entries
(`{ prompt, model?, systemPrompt? }`). Both variants run against the same
base SHA in parallel worktrees, an LLM rubric judges the result, and
both worktrees are **retained** — `ab` never merges. Use to compare
prompt or model choices on a real change.

## UI

`mars init` prints the launch command at the end of its run. You can also
invoke it directly:

```sh
mars ui                              # http://127.0.0.1:7777
mars ui --port 8080 --host 0.0.0.0
```

Read-only Vite + React SPA backed by a small Express + SSE server in
`ui/server/`. Reads `queue.db` directly via `@libsql/client` and re-emits
on every `.mars/` file change.

Kanban columns:

- **BACKLOG** — `queued` with no plan
- **PLANNED** — `queued` with a plan
- **IN PROGRESS** — `running` / `verifying` / `merging`
- **DONE** — `done`, plus `failed` with a red border

The CLI is the only write surface — the UI never mutates state.

## Bundled Claude Code skills

Mars ships slash commands, agents, and session hooks in the framework's
`.claude/` plugin directory. They are activated globally (once per machine)
as part of `mars init` — which writes one entry to `~/.claude/settings.json`
so the `mars:*` skills are available in every Claude Code session on this
machine, not just the current repo.

| Skill | Purpose |
| --- | --- |
| `/mars:grill <id>` | Challenges a draft idea against `CONTEXT.md`, curates glossary + ADRs inline. Conversation only. |
| `/mars:to-prd <id>` | Synthesises the current grill conversation into a PRD and writes it to `state.db`. |
| `/mars:action-queue [<id>]` | Show the action queue grouped by priority and resolve one item. |
| `/mars:unblock <task-id>` | Loads a stopped task + its blockers, proposes 2–3 concrete unblock options. |
| `/mars:reflect` | Synthesise reflection-source draft ideas from recent completed tasks. |
| `/mars:deep-reflect [<id>]` | Single-session post-mortem on one task arc; persists a JSON report under `.mars/deep-reflections/`. |

A `SessionStart` hook also runs `mars action-queue --lean` and injects a
compact snapshot at the top of every Claude Code session.

## Bundled agent

`.claude/agents/vcs-supervisor.md` ("Vega") is dispatched via `claude -p`
when the merge step hits a conflict. It reads both sides, reconciles
intent rather than blindly picking one, and re-runs verification before
committing. Unresolvable conflicts trigger `git merge --abort` and the
task is marked `failed`.

## Repo resolution and environment

Mars resolves the target repo in this order:

1. `--repo <path>` flag
2. `MARS_REPO` env var
3. `git rev-parse --show-toplevel` from the current directory

Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `MARS_REPO` | (unset) | Target repo when `--repo` is not given. |
| `MARS_HOME` | `~/.mars` | Where `install-dev.sh` clones the framework. |
| `MARS_BIN_DIR` | `~/.local/bin` | Where `install-dev.sh` symlinks the `mars` binary. |
| `INTEGRATION_BRANCH` | `main` | Merge target for the implement workflow. |
| `MARS_MAX_TRIAGE` | `4` | Daemon concurrency cap for triage. |
| `MARS_MAX_IMPLEMENT` | `6` | Daemon concurrency cap for implement. |
| `MARS_MAX_REFINE` | `2` | Daemon concurrency cap for refine. |
| `MARS_MAX_STRUCTURED_WRITE` | `1` | Daemon concurrency cap for glossary / ADR writes. |
| `MARS_REFLECT_DISABLED` | (unset) | When `=1`, skip per-task token/cost capture and short-circuit `mars reflect`. Scorers stay attached. |
| `MARS_DEEP_REFLECT_MODEL` | `opus` | Model used by `mars arc reflect`. |
| `MARS_AGENT_NAME` | (unset) | Author tag when an agent invokes `task add` / `idea add`. Also auto-detected from `CLAUDE_CODE` / `CLAUDECODE`. |

`mars daemon reload` re-reads `.mars/daemon.json` and the `MARS_MAX_*`
env vars without restarting.

## `mars init`

The single onboarding command for a new repo. It:

1. **Scaffolds repo state** — walks the target repo, detects the tech stack
   across every manifest, and generates a unified supervisor set under
   `.mars/supervisors/`.
2. **Activates the `mars:*` Claude Code plugin** — registers the framework's
   `.claude/` directory in `~/.claude/settings.json` so slash commands,
   agents, and session hooks are available in every Claude Code session on
   this machine (one-time, global; idempotent on repeat runs).
3. **Prints the dashboard launch command** — tells you how to open the
   read-only Kanban UI once the daemon is running.

```sh
mars init                # scaffold + activate plugin + print dashboard hint
mars init --verbose      # also list each manifest + techs on stderr
mars init --dry-run      # print without writing
mars init --force        # overwrite existing supervisors
mars init --refresh      # invalidate the specialist cache and refetch
mars init --no-fetch     # use only fallback templates, skip HTTPS
```

Recursion is the default. The walker stops at depth 6 and skips `.git`,
`node_modules`, `.mars`, `.worktrees`, `dist`, `build`, `.next`, `target`,
`out`, plus anything ignored by a `.gitignore` or registered as a git
submodule. Tech-bearing manifests must be siblings, not nested — `mars
init` errors out if it sees `frontend/package.json` AND
`frontend/admin/package.json`. Empty repos still get a baseline supervisor
plus an empty-stack `manifest.json`.

Specialist knowledge is fetched once from
[`ayush-that/sub-agents.directory`](https://github.com/ayush-that/sub-agents.directory)
over plain HTTPS and cached for 7 days at
`.mars/cache/sub-agents/trees.json`. No API keys involved.

## State

Everything Mars touches in a target repo lives under `.mars/`:

| Path | Purpose |
| --- | --- |
| `queue.db` | LibSQL: `tasks`, `task_blockers`, `task_suggestions`, `action_queue_items` |
| `state.db` | LibSQL: `ideas`, `idea_user_stories` (PRD-shaped drafts) |
| `mastra.db` | Mastra observability (workflow runs, spans, transcripts) |
| `supervisors/*.md` | Generated supervisor system prompts |
| `supervisors/manifest.json` | Supervisor registry |
| `cache/sub-agents/trees.json` | 7-day cached specialist index |
| `worktrees/<task-id>/` | Per-task git worktree on branch `task/<id>` |
| `.merge.lock` | Serializes the merge step (5-min ttl) |
| `daemon.json` | Daemon config (concurrency caps, poll interval) |

Add `/.mars/` to the target repo's `.gitignore`.

## Documentation

- [`VISION.md`](./VISION.md) — what Mars is, the canonical loop, non-goals.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components, state, drift between
  docs and code.
- [`CONTEXT.md`](./CONTEXT.md) — domain glossary. Edit via
  `mars glossary set/remove` only.
- [`docs/adr/`](./docs/adr/) — Architecture Decision Records. Add via
  `mars adr add` only.
- [`orchestrator/README.md`](./orchestrator/README.md) — CLI reference and
  workflow internals.
- [`orchestrator/AGENTS.md`](./orchestrator/AGENTS.md) — boundaries for
  agents working inside the orchestrator (no LLM SDKs, route everything
  through `claude -p`, `mars init` recursion contract).
- [`CLAUDE.md`](./CLAUDE.md) — project instructions for Claude Code:
  triage lanes, session-start protocol, structured-write rules.
- [`design/`](./design/) — UI design drafts (`design/ui.pen`); not shipped
  at runtime.
- [`.agents/`](./.agents/) — bundled agent skills (e.g. embedded Mastra
  skill).
- [`.claude/skills/`](./.claude/skills/) — bundled `/mars:*` Claude Code
  slash commands.

## License

MIT — see [`LICENSE`](./LICENSE).
