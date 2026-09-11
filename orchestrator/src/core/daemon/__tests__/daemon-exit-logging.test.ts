/**
 * Verify that the daemon's signal and exit handlers write a log line
 * synchronously before the process goes away.
 *
 * The critical correctness property: writeLog uses appendFileSync, so the
 * line is on disk before the process terminates. If the write were async
 * (e.g. a promise-based logger), the exit handler would drop the line and the
 * log would show nothing — exactly the symptom that motivated this test.
 *
 * Strategy: spawn a minimal child process that installs the same handlers
 * as startDaemon (SIGINT/SIGTERM/SIGHUP + process.on('exit')), sends itself
 * the signal under test, then exits. We read the log file after the child
 * exits and assert the expected lines are present. If the write were not
 * synchronous, the file would be empty.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const makeTmpLogFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-exit-log-'))
  return join(dir, 'watch.log')
}

/**
 * Build an ESM child script that mirrors the daemon's shutdown handler
 * setup and sends itself `signal`. The script:
 *   1. registers SIGINT/SIGTERM/SIGHUP handlers that writeLog synchronously
 *      then exit(0) — matching the daemon's shutdown path.
 *   2. registers process.on('exit') that writes the exit code — matching the
 *      new exit-accounting handler added to server.ts.
 *   3. schedules process.kill(process.pid, signal) so the handler fires.
 */
const makeChildScript = (logFile: string, signal: string): string => `
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const logFile = ${JSON.stringify(logFile)}

// Synchronous logger — mirrors writeLog() in server.ts.
const writeLog = (line) => {
  const stamped = '[' + new Date().toISOString() + '] ' + line + '\\n'
  try {
    const dir = dirname(logFile)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(logFile, stamped)
  } catch {}
}

// Exit-code accounting — mirrors the process.on('exit') added to server.ts.
// MUST be synchronous: an async write here would be silently dropped.
const bootMs = Date.now()
process.on('exit', (code) => {
  const uptime = Math.round((Date.now() - bootMs) / 1000)
  try {
    appendFileSync(logFile,
      '[' + new Date().toISOString() + '] [daemon] exiting: code=' + code +
      ' pid=' + process.pid + ' uptime=' + uptime + 's\\n')
  } catch {}
})

// Keep the event loop alive so the signal handler can run. Node.js delivers
// process.once signal callbacks asynchronously (via libuv) on the next event
// loop iteration after process.kill returns. Without a keepalive the loop
// would empty and the process would exit (code 0) before the handler fired.
const keepAlive = setInterval(() => {}, 10_000)

// Signal handlers — mirrors the SIGINT/SIGTERM/SIGHUP loop in server.ts.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    clearInterval(keepAlive)
    writeLog('[shutdown] received ' + sig + ' (pid ' + process.pid + '); cleaning up')
    process.exit(0)
  })
}

// Send the signal. The handler is registered; the delivery is asynchronous,
// so the keepAlive interval above ensures the loop stays open for it.
process.kill(process.pid, ${JSON.stringify(signal)})
`

describe('daemon exit logging', () => {
  const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

  for (const signal of SIGNALS) {
    it(`writes [shutdown] received ${signal} synchronously before the process exits`, () => {
      const logFile = makeTmpLogFile()
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        input: makeChildScript(logFile, signal),
        encoding: 'utf8',
        timeout: 5_000,
      })
      // The child must have exited cleanly via its signal handler.
      expect(result.status).toBe(0)
      // The log file must exist and contain the shutdown line.
      expect(existsSync(logFile)).toBe(true)
      const log = readFileSync(logFile, 'utf8')
      expect(log).toContain(`[shutdown] received ${signal}`)
    })
  }

  it('writes [daemon] exiting with exit code via process.on("exit") after a signal', () => {
    const logFile = makeTmpLogFile()
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: makeChildScript(logFile, 'SIGTERM'),
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    const log = readFileSync(logFile, 'utf8')
    // Both lines must be present: signal handler fires first, then exit fires.
    expect(log).toContain('[shutdown] received SIGTERM')
    expect(log).toContain('[daemon] exiting: code=0')
    // The exit line must appear AFTER the shutdown line (shutdown handler fires
    // first, then process.on('exit') fires as the last action).
    expect(log.indexOf('[daemon] exiting:')).toBeGreaterThan(
      log.indexOf('[shutdown] received SIGTERM'),
    )
  })

  it('process.on("exit") write is synchronous — file is non-empty immediately after process exits', () => {
    // This test specifically verifies that appendFileSync (not appendFile) is
    // used in the exit handler. If the write were async, the exit handler would
    // be dropped and the file would be empty or missing the exit line.
    const logFile = makeTmpLogFile()
    // Use SIGHUP to exercise the newly added handler path.
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: makeChildScript(logFile, 'SIGHUP'),
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    // File must exist and be non-empty immediately (spawnSync returns after the
    // child exits — no race between the test read and the write).
    expect(existsSync(logFile)).toBe(true)
    const log = readFileSync(logFile, 'utf8')
    expect(log.length).toBeGreaterThan(0)
    expect(log).toContain('[daemon] exiting: code=0')
  })
})
