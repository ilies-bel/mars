import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
// orchestrator -> worktree root, which contains docs/adr/ used by `mars adr list`.
const worktreeRoot = resolve(projectRoot, '..')

const STACK_TRACE_MARKERS = [
  /Unhandled error event/,
  /write EPIPE/,
  /Error \[ERR_STREAM_DESTROYED\]/,
  /at process\.emit/,
  /at WriteStream\.\w+/,
  /node:internal\/process/,
]

const expectNoStackTrace = (stderr: string): void => {
  for (const marker of STACK_TRACE_MARKERS) {
    expect(stderr, `unexpected stack trace marker ${marker} in stderr:\n${stderr}`).not.toMatch(
      marker,
    )
  }
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const marsCmd = (subargs: readonly string[]): string =>
  [process.execPath, tsxBin, cliEntry, ...subargs].map(quote).join(' ')

const runShell = (script: string): SpawnSyncReturns<string> =>
  spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env },
    cwd: worktreeRoot,
    timeout: 30_000,
  })

describe('mars CLI silently swallows broken-pipe on stdout/stderr', () => {
  it('produces no stack trace when stdout is piped into head -1', () => {
    const result = runShell(`${marsCmd(['adr', 'list'])} | head -1`)
    expectNoStackTrace(result.stderr)
  })

  it('produces no stack trace when stdout is piped into grep -q (closes on first match)', () => {
    const result = runShell(`${marsCmd(['adr', 'list'])} | grep -qi merge`)
    expectNoStackTrace(result.stderr)
  })

  it('produces no stack trace when stderr is piped (via 2>&1) into head -1', () => {
    // Exercises EPIPE on stderr too: an unknown command writes both
    // streams, and the merge to stdout means head closes the combined
    // pipe early.
    const result = runShell(
      `${marsCmd(['definitely-not-a-real-command'])} 2>&1 | head -1`,
    )
    expectNoStackTrace(result.stderr)
  })

  it("'mars adr list | grep -qi merge && echo OK' still prints OK", () => {
    const result = runShell(
      `${marsCmd(['adr', 'list'])} | grep -qi merge && echo OK`,
    )
    expect(result.stdout.trim()).toBe('OK')
    expect(result.status).toBe(0)
  })

  it('a succeeding mars command keeps its success exit when its output pipe closes early', () => {
    // PIPESTATUS[0] preserves the upstream (mars) exit code regardless
    // of what the downstream reader returned. mars adr list normally
    // exits 0; head -1 closes the pipe after one line so EPIPE fires
    // on subsequent writes.
    const result = runShell(
      `set +e; ${marsCmd(['adr', 'list'])} | head -1 >/dev/null; echo "RC=\${PIPESTATUS[0]}"`,
    )
    expect(result.stdout.trim()).toBe('RC=0')
    expectNoStackTrace(result.stderr)
  })

  it('a failing mars command keeps its failure exit when its output pipe closes early', () => {
    // Unknown-command path writes the multi-line usage to stdout then
    // exits 1. Even if the pipe is closed by head -1 before mars
    // finishes, the exit code (1) must be preserved — the EPIPE
    // handler must not force a 0 or 141.
    const result = runShell(
      `set +e; ${marsCmd(['definitely-not-a-real-command'])} 2>/dev/null | head -1 >/dev/null; echo "RC=\${PIPESTATUS[0]}"`,
    )
    expect(result.stdout.trim()).toBe('RC=1')
  })
})
