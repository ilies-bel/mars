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
