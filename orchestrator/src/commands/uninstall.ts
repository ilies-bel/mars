/**
 * Core logic for `mars uninstall`.
 *
 * All I/O is injected so the function is fully testable without spawning a
 * subprocess or touching the real filesystem. The CLI entry point is
 * responsible for resolving paths, detecting TTY state, wiring readline, and
 * calling process.exit() based on the returned outcome.
 */

/** The two on-disk locations that `mars uninstall` removes. */
export interface UninstallPaths {
  /** Resolved path to the mars binary (e.g. /usr/local/bin/mars). */
  binPath: string
  /** Resolved path to the mars source clone / installation directory. */
  srcDir: string
}

/** Injectable I/O surface — every non-pure dependency. */
export interface UninstallOptions {
  paths: UninstallPaths
  /** When true, skip the interactive prompt and proceed immediately. */
  yes: boolean
  /** Whether stdin is a real TTY. Inject `process.stdin.isTTY ?? false` in production. */
  isTty: boolean
  /**
   * Read one line of input from the user. Only called when `isTty` is true
   * and `yes` is false.
   */
  readLine: () => Promise<string>
  /**
   * Write the interactive prompt text (no trailing newline). Defaults to
   * `process.stdout.write` in production; inject a recorder in tests.
   */
  writePrompt?: (text: string) => void
}

/** Outcome of the confirmation phase. */
export type UninstallOutcome =
  | 'confirmed' // user said y/Y, or --yes was passed
  | 'aborted' // user answered n / empty / anything other than y|Y
  | 'non-tty-aborted' // stdin is not a TTY and --yes was not given

/**
 * Run the `mars uninstall` confirmation flow.
 *
 * Displays the resolved paths, optionally prompts the user, and returns the
 * outcome. Never deletes anything — deletion is handled in a subsequent slice.
 */
export async function runUninstall(opts: UninstallOptions): Promise<UninstallOutcome> {
  const {
    paths,
    yes,
    isTty,
    readLine,
    writePrompt = (t: string) => {
      process.stdout.write(t)
    },
  } = opts

  // Always show the resolved paths so the user knows what would be removed.
  console.log(`binary:     ${paths.binPath}`)
  console.log(`source dir: ${paths.srcDir}`)
  console.log('')

  // Non-TTY stdin without --yes would hang forever waiting for input.
  // Abort with a clear message so scripts fail fast.
  if (!yes && !isTty) {
    console.error(
      'error: stdin is not a terminal; pass --yes (or -y) to proceed non-interactively',
    )
    return 'non-tty-aborted'
  }

  // --yes skips the interactive prompt entirely.
  if (!yes) {
    writePrompt('Delete these? [y/N] ')
    const answer = await readLine()
    if (answer !== 'y' && answer !== 'Y') {
      console.log('Aborted.')
      return 'aborted'
    }
  }

  // Confirmed — print what would be deleted (actual deletion is a later slice).
  console.log(`would delete: ${paths.binPath}`)
  console.log(`would delete: ${paths.srcDir}`)
  return 'confirmed'
}
