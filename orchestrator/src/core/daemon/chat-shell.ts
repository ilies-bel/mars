import { execFile } from 'node:child_process'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

const TOOL_OUTPUT_CHAR_CAP = 10_000

const truncate = (value: string): string =>
  value.length > TOOL_OUTPUT_CHAR_CAP
    ? `${value.slice(0, TOOL_OUTPUT_CHAR_CAP)}…[truncated]`
    : value

/**
 * Execute a chat shell tool unconfined as the daemon user from the repository
 * root. See ADR-0090: Worker `codex exec --sandbox` confinement is unchanged.
 */
export const runShellCommand = (
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ShellResult> =>
  new Promise((resolveResult) => {
    execFile(
      '/bin/zsh',
      ['-lc', command],
      { cwd, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0
        resolveResult({
          stdout: truncate(stdout),
          stderr: truncate(error && stderr.length === 0 ? error.message : stderr),
          exitCode,
        })
      },
    )
  })
