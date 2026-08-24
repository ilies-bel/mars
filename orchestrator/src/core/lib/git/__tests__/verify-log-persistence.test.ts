/**
 * Every downstream consumer of verify output is capped: `failureExcerpt`
 * keeps 1000 head + 2000 tail chars, `truncateFailure` keeps 2000 tail
 * chars. A full-suite `tsc` or `vitest` run routinely prints an order of
 * magnitude more than that, so the one diagnostic a recovery coder needs
 * can be exactly what truncation dropped — the failure loop this feature
 * exists to break.
 *
 * These tests exercise the observable contract of that fix through the
 * public `verifyChanges` API against real binaries (`sh`):
 *   - a step run under a trace context with a task id reports a `logPath`,
 *     and the file at that path holds the FULL, untruncated output;
 *   - the log holds the raw subprocess bytes, with no orchestrator marker
 *     mixed in;
 *   - gate names carrying path-hostile characters (`typecheck:orchestrator`)
 *     still produce a readable, writable filename;
 *   - without a task id there is no log and no `logPath` — best-effort, never
 *     a verify failure.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyChanges } from '../verify'
import { nullTraceStore } from '../../run-tool'
import { __resetContextCacheForTests } from '../../../context'

/** ~10 KB of distinctive output — far past every excerpt cap in the codebase. */
const BULKY_OUTPUT_CMD =
  'i=1; while [ $i -le 400 ]; do echo "line-$i-paddingpaddingpadding"; i=$((i+1)); done'

describe('verify step logs — full untruncated output persisted under .mars/verify-logs', () => {
  let repoDir: string
  let workDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-log-repo-'))
    workDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-log-work-'))
    process.env.MARS_REPO = repoDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    __resetContextCacheForTests()
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  })

  it('a failing step reports a logPath whose file holds the complete output', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      traceCtx: { taskId: 'mars-abc123', store: nullTraceStore },
      steps: [
        {
          name: 'typecheck',
          cmd: 'sh',
          args: ['-c', `${BULKY_OUTPUT_CMD}; echo CYCLE_DIAGNOSTIC >&2; exit 1`],
          required: true,
        },
      ],
    })

    expect(result.passed).toBe(false)
    const step = result.steps.find((s) => s.name === 'typecheck')!
    expect(step.logPath).toBeDefined()
    expect(existsSync(step.logPath!)).toBe(true)

    const log = readFileSync(step.logPath!, 'utf8')
    // The whole run survives: first line, last line, and the stderr
    // diagnostic that a head-truncating excerpt would have dropped.
    expect(log).toContain('line-1-padding')
    expect(log).toContain('line-400-padding')
    expect(log).toContain('CYCLE_DIAGNOSTIC')
    // Materially larger than failureExcerpt's 1000 head + 2000 tail budget.
    expect(log.length).toBeGreaterThan(3000)
    // And it really is the full stream, not a re-excerpted copy.
    expect(log).not.toContain('middle elided')
  })

  it('logs the raw subprocess bytes, without the orchestrator failure marker', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      traceCtx: { taskId: 'mars-raw01', store: nullTraceStore },
      steps: [
        {
          name: 'unit',
          // Exit 137 makes runVerifyStep prefix `output` with a SIGKILL note.
          cmd: 'sh',
          args: ['-c', 'echo plain-child-output; exit 137'],
          required: true,
        },
      ],
    })

    const step = result.steps.find((s) => s.name === 'unit')!
    expect(step.output).toMatch(/SIGKILL/)

    const log = readFileSync(step.logPath!, 'utf8')
    expect(log).toContain('plain-child-output')
    expect(log).not.toMatch(/SIGKILL/)
  })

  it('a passing step is logged too, so a green run is still inspectable', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      traceCtx: { taskId: 'mars-pass01', store: nullTraceStore },
      steps: [
        { name: 'knip', cmd: 'sh', args: ['-c', 'echo all-clear'], required: true },
      ],
    })

    expect(result.passed).toBe(true)
    const step = result.steps.find((s) => s.name === 'knip')!
    expect(readFileSync(step.logPath!, 'utf8')).toContain('all-clear')
  })

  it('a gate name with a colon still yields a writable log file', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      traceCtx: { taskId: 'mars-colon1', store: nullTraceStore },
      steps: [
        {
          name: 'typecheck:orchestrator',
          cmd: 'sh',
          args: ['-c', 'echo scoped-gate-ran; exit 3'],
          required: true,
        },
      ],
    })

    const step = result.steps.find((s) => s.name === 'typecheck:orchestrator')!
    expect(step.logPath).toBeDefined()
    // The colon must not survive into the filename.
    expect(step.logPath).not.toContain(':')
    expect(readFileSync(step.logPath!, 'utf8')).toContain('scoped-gate-ran')
  })

  it('writes logs under the shared repo .mars, not the verify cwd', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      traceCtx: { taskId: 'mars-loc001', store: nullTraceStore },
      steps: [{ name: 'lint', cmd: 'sh', args: ['-c', 'echo x'], required: true }],
    })

    // Worktrees are removed on merge; anchoring logs to the repo-level
    // `.mars/` is what keeps them readable by a later recovery coder.
    expect(result.steps.find((s) => s.name === 'lint')!.logPath).toBe(
      resolve(repoDir, '.mars', 'verify-logs', 'mars-loc001-lint.log'),
    )
  })

  it('omits logPath entirely when there is no task id to attribute the log to', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      traceCtx: { store: nullTraceStore },
      steps: [
        { name: 'anon', cmd: 'sh', args: ['-c', 'echo nope; exit 1'], required: true },
      ],
    })

    expect(result.passed).toBe(false)
    expect(result.steps.find((s) => s.name === 'anon')!.logPath).toBeUndefined()
    expect(existsSync(resolve(repoDir, '.mars', 'verify-logs'))).toBe(false)
  })

  it('runs without a trace context at all — logging is never load-bearing', async () => {
    const result = await verifyChanges({
      cwd: workDir,
      steps: [{ name: 'no-trace', cmd: 'sh', args: ['-c', 'echo ok'], required: true }],
    })

    expect(result.passed).toBe(true)
    expect(result.steps.find((s) => s.name === 'no-trace')!.logPath).toBeUndefined()
  })
})
