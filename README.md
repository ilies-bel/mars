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

## Documentation

- [`VISION.md`](./VISION.md) — what Mars is and is not
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system layout
- [`docs/CONTRACTS.md`](./docs/CONTRACTS.md) — typed contracts between components
- [`design/`](./design/) — design notes
- [`agents/`](./agents/) — agent definitions

## License

MIT — see [`LICENSE`](./LICENSE).
