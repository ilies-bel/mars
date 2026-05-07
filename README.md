# Mars Framework

A lean, local-first, no-API-key alternative to managed agent platforms.
Mars runs Claude Code in parallel git worktrees against a single repo,
governed by a TypeScript CLI and a SQLite database that lives next to
the project.

See [`VISION.md`](./VISION.md) for the target state and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for what exists today.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/ilies-bel/mars/main/install.sh | bash
```

The installer:

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

## Quick start

From inside any git repo:

```sh
mars init                                # detect stack, generate supervisors
mars add --draft "implement feature X"   # enqueue a draft
# refine the plan via the chat skill (/mars:feature:chat) inside Claude Code
mars watch                               # daemon dispatcher (poll queue.db)
```

The full CLI reference and runtime details live in
[`orchestrator/README.md`](./orchestrator/README.md).

## `mars init`

Walks the target repo, detects the tech stack across every manifest, and
generates a unified supervisor set under `.mars/supervisors/`.

```sh
mars init                # walk the repo, write supervisors
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
| `queue.db` | LibSQL: tasks, questions, suggestions |
| `mastra.db` | Mastra observability (workflow runs, spans) |
| `supervisors/*.md` | Generated supervisor system prompts |
| `supervisors/manifest.json` | Supervisor registry |
| `cache/sub-agents/trees.json` | 7-day cached specialist index |
| `worktrees/<task-id>/` | Per-task git worktree |
| `.merge.lock` | Serializes the merge step |

Add `/.mars/` to the target repo's `.gitignore`.

## Documentation

- [`VISION.md`](./VISION.md) — what Mars is, the canonical loop, non-goals.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components, state, drift between
  docs and code.
- [`orchestrator/README.md`](./orchestrator/README.md) — CLI reference and
  workflow internals.
- [`orchestrator/AGENTS.md`](./orchestrator/AGENTS.md) — boundaries for
  agents working inside the orchestrator (no LLM SDKs, route everything
  through `claude -p`, `mars init` recursion contract).
- [`CLAUDE.md`](./CLAUDE.md) — project instructions for Claude Code,
  including Beads issue-tracker integration.
- [`design/`](./design/) — UI design notes (`design/ui.pen`).
- [`.agents/`](./.agents/) — bundled agent skills (e.g. embedded Mastra
  skill).

## License

MIT — see [`LICENSE`](./LICENSE).
