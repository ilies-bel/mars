import { execFile } from 'node:child_process'
import { join } from 'node:path'

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

const seatbeltStringLiteral = (path: string): string =>
  `"${path
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`

/**
 * Build the macOS Seatbelt policy used for one chat shell command.
 *
 * Reads stay available for normal command execution, while every write is
 * confined to the repository and its Mars state directory. The explicit
 * `.mars` entry documents that state is a permitted write target even though
 * it is also nested beneath the repository root.
 */
export const buildSeatbeltProfile = (cwd: string): string => {
  const stateDir = join(cwd, '.mars')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${seatbeltStringLiteral(cwd)}))`,
    `(allow file-write* (subpath ${seatbeltStringLiteral(stateDir)}))`,
    // `deny default` keeps every non-loopback socket operation denied.
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ].join('\n')
}

/**
 * Execute a chat shell tool from the repository root. On Darwin,
 * `sandbox-exec` is the default OS boundary: it permits reads and confines
 * writes to the repository and its Mars state directory. Other hosts retain a
 * direct-shell fallback, with a warning, until an equivalent confinement
 * mechanism is available.
 */
export const runShellCommand = (
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ShellResult> =>
  new Promise((resolveResult) => {
    const isDarwin = process.platform === 'darwin'
    if (!isDarwin) {
      console.warn('Chat shell confinement is disabled: sandbox-exec is only available on macOS.')
    }
    const file = isDarwin ? '/usr/bin/sandbox-exec' : '/bin/zsh'
    const args = isDarwin
      ? ['-p', buildSeatbeltProfile(cwd), '/bin/zsh', '-lc', command]
      : ['-lc', command]
    execFile(
      file,
      args,
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
