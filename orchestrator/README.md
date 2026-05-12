# mars

Mastra-driven orchestrator that runs Claude Code in parallel git worktrees. Installable globally; works against any git repo.

## How it works

Each task in the queue runs through a 4-step Mastra workflow:

1. **setup** — `git worktree add` on a fresh `task/<id>` branch off `main`
2. **code** — `claude -p "<prompt>"` runs headless inside the worktree
3. **verify** — typecheck → tests → lint (must all pass)
4. **merge** — fast-forward into `main`. On conflict, the bundled **vcs-supervisor** ("Vega") agent prompt is dispatched via `claude -p` to reconcile intent and verify, then commit. If unresolvable, `git merge --abort` and the task is marked `failed`. Merges are serialized via a file lock; coding runs unlimited-parallel.

## Install

```bash
cd orchestrator
npm install
npm link            # exposes `mars` globally
```

## Usage

```bash
# inside any git repo
mars add "implement X in src/foo.ts"
mars list queued
mars run                    # dispatch all queued tasks in parallel
mars where                  # show resolved repo + state paths

# from anywhere — explicit target
mars --repo /path/to/repo add "fix bug Y"
mars --repo /path/to/repo run

# Mastra Studio (workflow traces, time-travel, logs)
cd orchestrator && npm run dev   # http://localhost:4111
```

## Repo & state resolution

Target repo is resolved in this order:
1. `--repo <path>` flag
2. `MARS_REPO` env var
3. `git rev-parse --show-toplevel` from the current directory

State lives at `<target-repo>/.mars/`:

| File                  | Purpose                       |
| --------------------- | ----------------------------- |
| `queue.db`            | LibSQL task queue             |
| `mastra.db`           | Mastra workflow runs/traces   |
| `worktrees/<task-id>` | Per-task git worktree         |
| `.merge.lock`         | Serializes the merge step     |

Add `/.mars/` to the target repo's `.gitignore`.

## Layout (orchestrator source)

| Path                            | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `src/cli.ts`                    | CLI: `add`, `list`, `run`, `where`                 |
| `src/mastra/context.ts`         | Resolves target repo + state paths                 |
| `src/mastra/index.ts`           | Mastra registration                                |
| `src/mastra/queue.ts`           | LibSQL-backed task queue                           |
| `src/mastra/lib/git.ts`         | All shell side-effects (git, claude, verify)       |
| `src/mastra/workflows/`         | `implementWorkflow`                                |
| `src/mastra/tools/`             | Same primitives wrapped as Mastra tools            |
| `src/prompts/vcs-supervisor.md` | Bundled supervisor spec, inlined into `claude -p`  |

## Prerequisites

- `claude` CLI on PATH (Claude Code).
- Node `>=22.13.0`.

## Env

- `INTEGRATION_BRANCH` — target branch for merges (default `main`).
- `MARS_REPO` — target repo path (overrides cwd-based detection).
- `MARS_REFLECT_DISABLED=1` — skip per-task token/cost capture and
  short-circuit `mars reflect`. Scorers stay attached either way.

### Daemon worker pool

The daemon dispatches work through per-kind semaphores so a reconcile
storm or a burst of `task add` calls can't spawn one worktree + `claude
-p` per row. Each cap is a positive integer; invalid values fall back to
the default. Tune at runtime with `mars daemon reload` (re-reads the
env vars below without restarting); a kill + restart also picks them up.

- `MARS_MAX_TRIAGE` (default `4`) — concurrent triage workflows.
- `MARS_MAX_IMPLEMENT` (default `4`) — concurrent implement workflows
  (worktree + `claude -p`). The hardware-bound knob; raise cautiously.
- `MARS_MAX_REFINE` (default `2`) — concurrent `mars idea refine`
  (planner) runs.
- `MARS_MAX_STRUCTURED_WRITE` (default `1`) — shared cap for
  `glossary-write` and `adr-add`. Both serialize on `.mars/.merge.lock`
  downstream, so a second slot would just sit waiting.

Excess work queues into in-memory pending sets and drains as slots free
— it is not dropped. Restarting the daemon re-reads `draft` / `queued`
rows from `.mars/queue.db` and re-pends them, so restarts are safe.

Dispatched `claude -p` workers run clean-room: their env is scrubbed of
every `CLAUDE*` session-context var inherited from the daemon's parent
shell, and they load only `project,local` setting sources (the worktree's
own `.claude/settings.json`) — never the host user's `~/.claude/`. MCP is
fully disabled and session files are not persisted to disk.

## Observing Claude runs in Studio

Both Claude dispatches (the `code` step and the `vcs-supervisor` invocation in
`merge`) capture the full Claude Code conversation in two places:

- **Live stream** — each parsed event from `claude -p --output-format stream-json --verbose`
  is forwarded to the workflow's `writer.write(...)`. In Studio, while the run
  is in flight, watch the step's run-stream view to see `claude-event` /
  `vcs-supervisor-event` items arrive in real time.
- **Persisted span metadata** — at step end small span-shaped fields are
  attached to the step span via
  `tracingContext.currentSpan.update({ metadata: { ... } })`. After a run
  completes, open Studio → Run history → click the step → **Metadata** tab.
  The `code` step exposes `claudeSessionId` and `usage`; the full
  conversation is persisted to `task_transcripts.conversation_json` in
  `.mars/queue.db` (LibSQL) instead, which is what `mars deep-reflect` and
  external skills read. The `merge` step still exposes
  `supervisorConversation` and `supervisorConversationBytes` (only
  populated when a conflict triggered the supervisor).

Trim policy: assistant text and reasoning are kept in full. Tool calls with
input larger than 2 KB and tool results larger than 4 KB are replaced with
`{ truncated: true, originalBytes, head }` (first 2 KB of the JSON payload)
to keep persisted conversations small.

## Reflection

Mars captures cheap deterministic signals during every workflow run, then
lets you synthesize them into draft task suggestions on demand.

**Per-task signals (automatic).** After the `code` and `vcs-supervisor`
steps, token and cost totals are summed from the captured Claude
conversation and persisted to the `task_signals` table in `.mars/queue.db`:

```
sqlite3 .mars/queue.db "select * from task_signals where task_id = '<id>'"
```

Columns: `step_id`, `input_tokens`, `output_tokens`, `cache_create_tokens`,
`cache_read_tokens`, `total_cost_usd`, `message_count`. Cache-creation and
cache-read tokens are kept separate from `input_tokens` because they're
priced differently — conflating them would mislead any reflection pass.

The two existing scorers (`verify-passed`, `merge-clean`) are also wired
to their respective steps and persist to `mastra_scorers` in
`.mars/mastra.db` regardless of the disable flag.

**Cross-task synthesis (manual).** `mars reflect` reads the signal corpus,
calls Claude Haiku once with the joined task records, and inserts the
returned suggestions into the `ideas` table as draft rows with
`source='reflection'`. Reflection ideas never auto-dispatch — `mars run`
only picks up rows from `tasks` with `status='queued'`.

```
mars reflect                                       # last 10 completed tasks
mars reflect --since 2026-05-01                    # ISO timestamp window
mars reflect --limit 25
mars idea list --source reflection --status draft  # review proposals
mars idea promote <idea-id>                        # shape & enqueue as a task
```

**Disable.** Set `MARS_REFLECT_DISABLED=1` to skip signal capture and
short-circuit `mars reflect`. The scorers stay attached because they're
deterministic and cheap; the disable flag only kills (a) `task_signals`
writes and (b) the synthesis CLI.

**Cost.** The reflector uses Haiku at roughly $0.005–$0.02 per call. It is
deliberately on-demand, not auto-run per task.

**Deep, single-session post-mortem.** `mars deep-reflect [<task-id>]`
runs a transcript-aware analysis on one task instead of an aggregate
window. The implement workflow persists the full trimmed
`ClaudeEvent[]` conversation (and the concatenated typecheck/test/lint
output) into a `task_transcripts` row in `.mars/queue.db` after each
run. `deep-reflect` walks that transcript event-by-event and surfaces:

- **Dissonant tool calls** — successful tool calls that did not achieve
  the assistant's stated intent (e.g. an `Edit` whose new content
  contradicts the surrounding plan, a `Bash` `git commit` that printed
  "nothing to commit, working tree clean", a verify command that
  reported pass with `0 passed, 0 failed`).
- **Verify-claim mismatches** — assistant said "all tests pass" but the
  recorded verify output shows a typecheck/test failure.
- **Thrashing** — same file Read 5+ times, Edit-then-revert pairs, etc.

```
mars deep-reflect            # auto-pick (failed > expensive done > recent)
mars deep-reflect <task-id>  # explicit
```

Auto-pick rules, in priority order:

1. Most recent `failed` task with a stored transcript.
2. Highest-cost `done` task in the last 7 days whose total cost ≥ 2×
   the median.
3. Most recent `done` task with a transcript.
4. Otherwise prints `no eligible session found` and exits 0.

Suggestions are filtered through `save|absorb|drop` verdicts and only
"save" verdicts land as draft ideas with `source='reflection'` (review
with `mars idea list --source reflection`). The full structured report
is persisted to `.mars/deep-reflections/<task-id>-<iso>.json`
(gitignored).

Model defaults to `opus`; override with `MARS_DEEP_REFLECT_MODEL`. The
timeout is 10 minutes — these analyses can be large. Setting
`MARS_REFLECT_DISABLED=1` disables transcript capture and short-circuits
`mars deep-reflect` along with `mars reflect`.

## Failure handling

- Verify gate fails → task marked `failed`, worktree retained at `.mars/worktrees/<taskId>`.
- Merge conflicts vcs-supervisor cannot reconcile → `git merge --abort`, task `failed`, worktree retained.
- Clean merge (or supervised resolution) → worktree removed, task `done`.

### Recovery, recipes, and escalation

When a normal task fails, the orchestrator computes a **failure
signature** — a human-readable technical key of shape
`<failingStep>/<error-class>` (e.g. `verify:has-diff/no-commits-ahead`,
`merge:preflight/uncommitted-changes`). The mapping from raw error to
class lives in `errorClassRules` in
`src/mastra/lib/failure-signature.ts`.

The handler then takes one of three paths (see ADR
`docs/adr/0002-recipe-per-failure-signature.md` for the contract):

1. **Recipe registered** — a recovery task is enqueued from the recipe
   in `src/mastra/lib/fix-recipes.ts`. The original task becomes
   `blocked`. If the recovery succeeds, the original is re-queued via
   the normal blocker-resolution path.
2. **Recovery itself fails** — the orchestrator does NOT enqueue
   another recovery (recovery has retry budget 0). The recovery is
   marked `failed`, the original stays `blocked`, and an inbox item of
   `kind='recovery-failed'` is raised. The human resolves via
   `mars retry <recovery-id>`, `mars unblock <origin-id>`, or fixing
   the upstream cause.
3. **No recipe for the signature** — the handler does NOT fall back to
   a generic prompt. The original is parked in `blocked`, an
   **Investigator** task is queued (`author='agent:investigator'`)
   whose sole job is to propose a draft recipe in
   `fix-recipes.ts` (and a classifier rule in `failure-signature.ts`
   if the signature ends in `/unclassified`), and an inbox item of
   `kind='no-recipe'` is raised.

To browse outstanding escalations:

```bash
mars inbox list --kind recovery-failed
mars inbox list --kind no-recipe
```

## Inbox

Cross-cutting findings that don't belong to a single task — daemon
desyncs, self-heal investigations, anything raised by a dispatched
agent — land in the inbox at `.mars/state.db`.

CLI surface:

| Command                                  | Purpose                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `mars inbox` / `mars inbox list [state]` | List items by state (default `open`).                    |
| `mars inbox show <id>`                   | Full detail for one item.                                |
| `mars inbox ack <id>`                    | Mark an item acknowledged.                               |
| `mars inbox resolve <id>`                | Mark an item resolved (`--note`, `--root-cause`).        |
| `mars inbox dismiss <id>`                | Mark an item dismissed (`--note`).                       |
| `mars inbox raise --from <-\|path>`      | File a new item from a JSON document.                    |
| `mars inbox watch`                       | Live ink TUI.                                            |

`mars inbox raise --from -` is the **correct** entry point for
dispatched agents (self-heal investigations, anything running inside a
`task/<id>` worktree) to file inbox items. It replaces
the deprecated pattern of writing one-shot `.ts` scripts under
`orchestrator/scripts/raise-*.ts`, which pollute the codebase, tie
agents to the orchestrator's source tree, and have caused merge-target
dirty failures when an uncommitted script was left in the worktree.

The verb reads a JSON document from stdin (or from `--from <path>`),
validates it against the same shape `raiseInboxItem` expects, dedupes
server-side by `(kind, signature)` — re-piping the same payload bumps
`seen_count` instead of creating a duplicate row — and prints the
inbox id on stdout (one line, no decoration). Exit codes: `0` ok, `1`
library error, `2` parse/validation error.

```bash
echo '{
  "kind": "manual.smoketest",
  "category": "orchestrator",
  "priority": "low",
  "title": "smoke test of mars inbox raise",
  "body": "...",
  "payload": {},
  "context": {},
  "raisedBy": "smoketest:agent",
  "signature": "manual.smoketest:1"
}' | mars inbox raise --from -
```

Required fields: `kind`, `category`, `priority` (`urgent|high|normal|low`),
`title`, `body`, `payload`, `context`, `raisedBy`, `signature`. Optional:
`occurrence`. Pass a real `raisedBy` (e.g. `self-heal:<task-id>`) so the source of the
finding is traceable; the empty string defaults to `agent:cli`, but a
missing key is a schema error.

## `mars init` and monorepo recursion

`mars init` walks the target repo from its root and merges every manifest it
finds into a single supervisor set under `.mars/supervisors/`.

- Recurses by default; no flag needed.
- Depth cap: 6 directories below the repo root. Anything deeper is skipped
  with a stderr warning.
- Hardcoded skip list: `.git`, `node_modules`, `.mars`, `.worktrees`, `dist`,
  `build`, `.next`, `target`, `out`.
- Honors `.gitignore` at every level (root and nested).
- Skips git submodule paths (parsed from `.gitmodules`) and other git worktrees
  (`git worktree list --porcelain`).
- **Layout contract**: tech-bearing folders must be siblings, not nested.
  If a manifest is found inside a subtree where another manifest already
  claimed the tech (e.g. `frontend/package.json` and
  `frontend/admin/package.json` both exist), `mars init` exits non-zero
  and prints both offending paths. Restructure so each tech is a sibling.
- Empty repo (no manifests anywhere): `mars init` still emits a baseline
  supervisor and a `manifest.json` with an empty stack.

Flags:

- `--force` — overwrite an existing `.mars/supervisors/manifest.json`.
- `--no-fetch` — skip the upstream specialist fetch from
  `ayush-that/sub-agents.directory`; render minimal templates.
- `--refresh` — force re-fetch of the specialist cache (filesystem walk
  is always fresh regardless).
- `--dry-run` — print the detected stack and proposed supervisors without
  writing.
- `--verbose` — print each discovered manifest and the techs derived from
  it on stderr.
