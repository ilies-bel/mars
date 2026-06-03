import { statSync } from 'node:fs'

/**
 * Classification of the running mars install.
 *
 * - `prod`  A compiled Bun standalone binary distributed via the release
 *           bootstrap (curl-pipe-bash). The binary is self-contained and
 *           several megabytes — it embeds the full Bun runtime. Self-update
 *           can replace it in-place.
 *
 * - `dev`   The tsx wrapper written by install-dev.sh. A small shell shim
 *           (hundreds of bytes) that executes
 *               exec "$TSX_BIN" "$ENTRY" "$@"
 *           so edits in orchestrator/src/** take effect immediately with no
 *           rebuild step. Self-update does not apply; contributors `git pull`.
 */
export type InstallRoute = 'prod' | 'dev'

/**
 * Minimum size in bytes of a compiled Bun standalone binary. Such a binary
 * bundles the Bun runtime plus the entire bundled TypeScript, landing at
 * 5 MiB or more in practice. We use 1 MiB as a conservative lower bound to
 * distinguish it from any shell wrapper or tsx launcher (which are always
 * a few kilobytes at most).
 */
export const PROD_BINARY_MIN_BYTES = 1_048_576 // 1 MiB

/**
 * Detect whether this mars process is a PROD compiled binary or a DEV
 * tsx-wrapper, and return the appropriate {@link InstallRoute}.
 *
 * ## Heuristic (first match wins)
 *
 * 1. **Source-entry signal** — `argv[1]` ends with `.ts`. A compiled binary
 *    never has a TypeScript source file as its entry point; only the dev
 *    install (which calls `tsx cli.ts`) does. This is the strongest signal.
 *
 * 2. **Executable-size signal** — `execPath` file is ≥ {@link PROD_BINARY_MIN_BYTES}.
 *    The Bun standalone binary is several MiB because it embeds the runtime.
 *    Any shell shim or tsx launcher is a few KiB at most. If stat fails (e.g.
 *    in a container that hides the binary) we skip this heuristic.
 *
 * 3. **Safe default** — when neither heuristic fires conclusively we assume
 *    `dev` so that a self-update operation does not attempt to overwrite an
 *    executable it cannot positively identify as the prod binary.
 *
 * @param overrides - Injectable test seams. In production all values are read
 *   from the live Node.js `process` object; pass overrides in tests to drive
 *   both the prod-binary and dev-wrapper shapes without a real binary on disk.
 */
export const classifyInstallRoute = (overrides?: {
  /** `process.argv[1]` — the entry-point path passed to the runtime. */
  argv1?: string | undefined
  /** `process.execPath` — the absolute path to the running executable. */
  execPath?: string
  /** File-size reader for `execPath`. Returns `null` on any read error. */
  statSize?: (path: string) => number | null
}): InstallRoute => {
  const argv1 = overrides?.argv1 !== undefined ? overrides.argv1 : process.argv[1]
  const execPath = overrides?.execPath ?? process.execPath
  const statSize = overrides?.statSize ?? safeStatSize

  // Heuristic 1: running from TypeScript source via tsx → dev install.
  // A compiled binary never presents a .ts file as its entry point.
  if (argv1?.endsWith('.ts')) {
    return 'dev'
  }

  // Heuristic 2: executable size exceeds the prod-binary floor → prod install.
  // The Bun standalone binary embeds the full runtime, making it multi-MiB.
  const size = statSize(execPath)
  if (size !== null && size >= PROD_BINARY_MIN_BYTES) {
    return 'prod'
  }

  // Heuristic 3: inconclusive — default to dev so self-update stays safe and
  // never attempts to overwrite an executable it cannot positively identify.
  return 'dev'
}

/** Read the size of the file at `path`. Returns `null` on any error. */
const safeStatSize = (path: string): number | null => {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}
