/**
 * uninstall — core logic for `mars uninstall`.
 *
 * Deletes the wrapper binary first, then the source clone directory, with
 * graceful partial-state handling.  All side effects (filesystem I/O,
 * user confirmation, logging) are injected so the function is fully
 * testable without touching the real filesystem.
 */

export interface UninstallDeps {
  /** Return true when the given path exists on disk. */
  exists: (p: string) => boolean
  /** Remove a single file. */
  removeFile: (p: string) => Promise<void>
  /** Recursively remove a directory. */
  removeDir: (p: string) => Promise<void>
  /** Prompt the user; return true to proceed, false to cancel. */
  confirm: () => Promise<boolean>
  /** Emit a human-readable line of output. */
  log: (msg: string) => void
}

export type UninstallOutcome =
  | 'cancelled'
  | 'full-success'
  | 'source-already-absent'
  | 'wrapper-already-absent'

export interface UninstallResult {
  outcome: UninstallOutcome
}

/**
 * Run the uninstall sequence.
 *
 * Deletion order: wrapper first, then source clone.  Per-repo .mars/ and
 * .worktrees/ directories are never touched — only the two paths passed in.
 *
 * @param wrapperPath  Absolute path to the installed `mars` wrapper binary.
 * @param cloneDir     Absolute path to the source clone (the repo root).
 * @param deps         Injected I/O dependencies.
 */
export async function runUninstall(
  wrapperPath: string,
  cloneDir: string,
  deps: UninstallDeps,
): Promise<UninstallResult> {
  const confirmed = await deps.confirm()
  if (!confirmed) {
    return { outcome: 'cancelled' }
  }

  const wrapperExists = deps.exists(wrapperPath)
  const cloneExists = deps.exists(cloneDir)

  // --- wrapper (always first) ---
  if (wrapperExists) {
    await deps.removeFile(wrapperPath)
  } else {
    deps.log(`wrapper already absent: ${wrapperPath}`)
  }

  // --- source clone (always second, after wrapper) ---
  if (cloneExists) {
    await deps.removeDir(cloneDir)
  } else {
    deps.log(`source clone already absent: ${cloneDir}`)
  }

  // --- outcome + PATH reminder ---
  if (!wrapperExists && cloneExists) {
    deps.log(
      `Done. Note: your shell rc may still export the install bin directory on PATH. ` +
        `Remove or update that export in ~/.bashrc / ~/.zshrc if you no longer want it.`,
    )
    return { outcome: 'wrapper-already-absent' }
  }

  if (wrapperExists && !cloneExists) {
    deps.log(
      `Done. Note: your shell rc may still export the install bin directory on PATH. ` +
        `Remove or update that export in ~/.bashrc / ~/.zshrc if you no longer want it.`,
    )
    return { outcome: 'source-already-absent' }
  }

  deps.log(
    `Uninstalled. Note: your shell rc may still export the install bin directory on PATH. ` +
      `Remove or update that export in ~/.bashrc / ~/.zshrc if you no longer want it.`,
  )
  return { outcome: 'full-success' }
}
