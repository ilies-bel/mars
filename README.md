# Mars Framework

A modular, lean, future-proof AI coding agent team behind a single TypeScript CLI.

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

If `~/.local/bin` is not on your `PATH`, the installer prints the line to add to your shell profile.

Verify:

```sh
mars --version
```

## Dev mode (live source)

While hacking on the CLI, point `mars` at the TypeScript entry directly so edits to `framework/cli/**` are picked up on the next call — no rebuild.

```sh
framework/scripts/install-dev.sh
```

This symlinks `~/.local/bin/mars` to `framework/scripts/mars-dev`, a shim that runs `bun cli/main.ts "$@"` from the framework dir. Honors `MARS_BIN_DIR` like `install.sh`.

After it runs, just use `mars` as normal:

```sh
mars --help
mars feature --help
```

To switch back to the built binary, re-run `install.sh` — it overwrites the same symlink.

## Codebase context (for agents)

`mars context` is a deterministic, no-network, no-LLM tool that gives an
agent structured codebase context. Prefer it over ad-hoc `grep`/`ls`/`find`
calls — the JSON output is a stable contract.

```sh
mars context search "<pattern>" [--path <dir>] [--type <ext>] [--format json|text]
mars context tree [path] [--depth <n>] [--format json|text]
```

- `search` wraps `ripgrep --json` and emits `{ file, line, col, text }[]`.
  Requires `rg` on `PATH` (`brew install ripgrep`).
- `tree` lists files and directories (skipping `.git`, `node_modules`,
  `dist`, `build`, etc.) and emits `{ path, kind, size? }[]`.

## Documentation

- [`VISION.md`](./VISION.md) — what Mars is and is not
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system layout
- [`docs/CONTRACTS.md`](./docs/CONTRACTS.md) — typed contracts between components
- [`design/`](./design/) — design notes
- [`agents/`](./agents/) — agent definitions

## License

MIT — see [`LICENSE`](./LICENSE).
