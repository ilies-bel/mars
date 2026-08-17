/**
 * Tests for runBrowserCheck — the Playwright-driven screenshot capture
 * used by the behaviour-verify primitive.
 *
 * All tests inject fake browser/server deps so no real browser or dev server
 * is required to run the suite. The one exception is the teardown-guarantee
 * test, which spawns a real OS process (sleep 999) and verifies the harness
 * actually kills it by PID — not just that it recorded a call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { runBrowserCheck, type CriterionResult, type QaStepResult } from '../browser-check'
import { isDevServerAlive } from '../../../core/lib/dev-server'
import type { DevServerHandle } from '../../../core/lib/dev-server'
import type { BootPlan } from '../app-boot-discovery'

// ---------------------------------------------------------------------------
// Sandbox directories (fresh per test)
// ---------------------------------------------------------------------------

let tmpWorktree: string
let tmpLogDir: string

beforeEach(() => {
  tmpWorktree = mkdtempSync(join(tmpdir(), 'mars-bvc-wt-'))
  tmpLogDir = mkdtempSync(join(tmpdir(), 'mars-bvc-logs-'))
})

afterEach(() => {
  rmSync(tmpWorktree, { recursive: true, force: true })
  rmSync(tmpLogDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakePlan: BootPlan = {
  cmd: 'npm run dev',
  cwd: '/tmp',
  url: 'http://127.0.0.1:19999',
  reason: 'test fixture',
}

const fakeHandle = (pid = 99999): DevServerHandle => ({
  pid,
  url: 'http://127.0.0.1:19999',
  logPath: '/tmp/bvc-test.log',
  port: 19999,
})

/** Fake browser that succeeds silently (no real navigation or screenshot). */
const silentBrowser = () => ({
  newPage: async () => ({
    goto: async (_url: string) => {},
    screenshot: async (_opts: { path: string }) => {},
    close: async () => {},
  }),
  close: async () => {},
})

// ---------------------------------------------------------------------------
// CriterionResult shape (acceptance criterion 1)
// ---------------------------------------------------------------------------

describe('runBrowserCheck — per-criterion result shape', () => {
  it('returns one CriterionResult per criterion with required fields', async () => {
    const criteria = ['the header renders', 'the submit button is visible']

    const results = await runBrowserCheck(fakePlan, criteria, {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results).toHaveLength(criteria.length)
    for (const r of results) {
      expect(typeof r.criterion).toBe('string')
      expect(['pass', 'fail', 'unverifiable']).toContain(r.verdict)
      // screenshotPath is either a string or null — never undefined.
      expect(r.screenshotPath === null || typeof r.screenshotPath === 'string').toBe(true)
      expect(typeof r.note).toBe('string')
    }
  })

  it('carries the criterion text verbatim in each result', async () => {
    const criteria = ['login banner visible', 'error message renders']

    const results = await runBrowserCheck(fakePlan, criteria, {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results[0].criterion).toBe(criteria[0])
    expect(results[1].criterion).toBe(criteria[1])
  })

  it('stores the screenshot as a relative path under the worktree qa/ dir', async () => {
    const results = await runBrowserCheck(fakePlan, ['any criterion'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    // The path is relative to worktreeDir — should start with qa/
    expect(results[0].screenshotPath).toBe(join('qa', '0.png'))
  })

  it('returns an empty array when criteria is empty', async () => {
    const results = await runBrowserCheck(fakePlan, [], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fail-path: infrastructure failures mark ALL criteria unverifiable
// (acceptance criterion 2 — verdict is NEVER silently 'pass')
// ---------------------------------------------------------------------------

describe('runBrowserCheck — boot/browser failure → all unverifiable', () => {
  it('marks all criteria unverifiable with failure note when dev server fails to start', async () => {
    const results = await runBrowserCheck(fakePlan, ['criterion A', 'criterion B'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => { throw new Error('port already in use') },
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.verdict).toBe('unverifiable')
      expect(r.screenshotPath).toBeNull()
      expect(r.note).toContain('port already in use')
    }
  })

  it('marks all criteria unverifiable when the health check times out', async () => {
    const results = await runBrowserCheck(fakePlan, ['criterion A'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => { throw new Error('health check timed out after 30 s') },
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results).toHaveLength(1)
    expect(results[0].verdict).toBe('unverifiable')
    expect(results[0].screenshotPath).toBeNull()
    expect(results[0].note).toContain('health check timed out')
  })

  it('marks all criteria unverifiable when browser launch fails', async () => {
    const results = await runBrowserCheck(
      fakePlan,
      ['criterion A', 'criterion B', 'criterion C'],
      {
        taskId: 'test-task',
        worktreeDir: tmpWorktree,
        logDir: tmpLogDir,
        deps: {
          startDevServer: async () => fakeHandle(),
          killDevServer: async () => {},
          waitForReady: async () => {},
          openBrowser: async () => { throw new Error('browser executable not found') },
        },
      },
    )

    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.verdict).toBe('unverifiable')
      expect(r.screenshotPath).toBeNull()
      expect(r.note).toContain('browser executable not found')
    }
  })
})

// ---------------------------------------------------------------------------
// Fail-path: dev server process is killed by harness on crash (acceptance
// criterion 3) — uses a REAL spawned process to verify the kill actually fires.
// ---------------------------------------------------------------------------

describe('runBrowserCheck — teardown guarantee', () => {
  it('kills the dev server process when browser launch crashes mid-run', async () => {
    // Spawn a real long-running process so we can verify by PID that the
    // harness-owned finally block genuinely kills it (not just records a call).
    const child = spawn('sleep', ['999'], { detached: true })
    child.unref()
    // Brief wait for OS to assign the PID and for the process to start.
    await new Promise<void>((r) => setTimeout(r, 50))
    const pid = child.pid!

    expect(isDevServerAlive(pid)).toBe(true)

    let killedPid: number | null = null

    await runBrowserCheck(fakePlan, ['criterion 1'], {
      taskId: 'crash-test',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        // Pretend the server is already running at the real PID.
        startDevServer: async () => fakeHandle(pid),
        // Use a real kill implementation (not just a spy) to prove the process
        // is actually reaped — a recording-only mock would satisfy the assertion
        // even if the real kill path were broken.
        killDevServer: async (p) => {
          killedPid = p
          if (p !== null) {
            // Try group kill first (detached process), fall back to direct.
            try { process.kill(-p, 'SIGTERM') } catch { /* ESRCH: group may not exist */ }
            try { process.kill(p, 'SIGTERM') } catch { /* already dead */ }
          }
        },
        waitForReady: async () => {},
        // Crash the browser launch — this is the scenario under test.
        openBrowser: async () => { throw new Error('simulated browser crash') },
      },
    })

    // The harness must have called kill with the correct PID.
    expect(killedPid).toBe(pid)

    // Give the OS a moment to reap the process after SIGTERM.
    await new Promise<void>((r) => setTimeout(r, 100))
    expect(isDevServerAlive(pid)).toBe(false)
  })

  it('calls killDevServer with null when server never started — no orphan leak', async () => {
    let killedWith: number | null | undefined = undefined

    await runBrowserCheck(fakePlan, ['criterion 1'], {
      taskId: 'no-start-test',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => { throw new Error('spawn failed') },
        killDevServer: async (p) => { killedWith = p },
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    // killDevServer MUST be called with null (not skipped), so the finally
    // block is provably reached even when serverHandle is never assigned.
    expect(killedWith).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// QA step contract fields (acceptance criterion for consumer slice
// "Walk each QA step with per-step screenshots and record stop-at")
//
// These tests pin the shape of `steps` and `stopAt` on CriterionResult.
// The base runBrowserCheck implementation (no step-walker) always returns
// `steps: []` and `stopAt: null`; the step-walker consumer layer populates
// them. The tests here verify the fields exist and have the correct defaults.
// ---------------------------------------------------------------------------

describe('runBrowserCheck — QA step contract fields', () => {
  it('returns steps as an empty array and stopAt as null on a successful capture', async () => {
    const results = await runBrowserCheck(fakePlan, ['criterion A', 'criterion B'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    for (const r of results) {
      expect(Array.isArray(r.steps)).toBe(true)
      expect(r.steps).toHaveLength(0)
      expect(r.stopAt).toBeNull()
    }
  })

  it('includes steps and stopAt on unverifiable results from infrastructure failure', async () => {
    const results = await runBrowserCheck(fakePlan, ['criterion A'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      deps: {
        startDevServer: async () => { throw new Error('server failed to start') },
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results[0].verdict).toBe('unverifiable')
    expect(Array.isArray(results[0].steps)).toBe(true)
    expect(results[0].steps).toHaveLength(0)
    expect(results[0].stopAt).toBeNull()
  })

  it('CriterionResult type carries QaStepResult array and stopAt discriminant', () => {
    // Compile-time shape test: build a value that satisfies the full
    // CriterionResult interface including the new QA-step fields.
    // Using an explicit QaStepResult annotation exercises the exported type.
    const step: QaStepResult = { stepIndex: 0, text: 'Navigate to /home', screenshotPath: 'qa/step-0.png', note: 'ok' }
    const result: CriterionResult = {
      criterion: 'header is visible',
      verdict: 'unverifiable',
      screenshotPath: 'qa/0.png',
      note: 'captured',
      steps: [step],
      stopAt: { stepIndex: 1, reason: 'element not found' },
    }
    // Runtime guard that the fields are shaped correctly.
    expect(result.steps[0].stepIndex).toBe(0)
    expect(result.stopAt?.stepIndex).toBe(1)
    expect(result.stopAt?.reason).toBe('element not found')
  })
})

// ---------------------------------------------------------------------------
// artifactsDir option (acceptance criterion for consumer slice
// "Relocate arc QA artefacts out of the worktree")
//
// When the caller supplies `artifactsDir`, screenshots MUST be written there
// and screenshotPath MUST be relative to that directory — not to worktreeDir.
// The legacy <worktreeDir>/qa/ directory must NOT be created in this case.
// ---------------------------------------------------------------------------

describe('runBrowserCheck — artifactsDir option', () => {
  let tmpArtifactsDir: string

  beforeEach(() => {
    tmpArtifactsDir = mkdtempSync(join(tmpdir(), 'mars-bvc-arts-'))
  })

  afterEach(() => {
    rmSync(tmpArtifactsDir, { recursive: true, force: true })
  })

  it('screenshotPath is relative to artifactsDir when that option is provided', async () => {
    const results = await runBrowserCheck(fakePlan, ['criterion A'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      artifactsDir: tmpArtifactsDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    // When artifactsDir is used, the path is just the filename —
    // relative to artifactsDir, not prefixed with 'qa/'.
    expect(results[0].screenshotPath).toBe('0.png')
  })

  it('does not create worktreeDir/qa/ when artifactsDir is provided', async () => {
    await runBrowserCheck(fakePlan, ['criterion A'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      artifactsDir: tmpArtifactsDir,
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    // Artefacts go to artifactsDir; the worktree's qa/ subdirectory must
    // remain absent so the worktree stays clean.
    expect(existsSync(join(tmpWorktree, 'qa'))).toBe(false)
  })

  it('legacy behaviour is unchanged when artifactsDir is absent', async () => {
    const results = await runBrowserCheck(fakePlan, ['any criterion'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      // No artifactsDir — falls back to <worktreeDir>/qa/
      deps: {
        startDevServer: async () => fakeHandle(),
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    // Backward compat: path is still relative to worktreeDir as qa/<index>.png
    expect(results[0].screenshotPath).toBe(join('qa', '0.png'))
  })

  it('unverifiable results carry null screenshotPath even when artifactsDir is set', async () => {
    const results = await runBrowserCheck(fakePlan, ['criterion A'], {
      taskId: 'test-task',
      worktreeDir: tmpWorktree,
      logDir: tmpLogDir,
      artifactsDir: tmpArtifactsDir,
      deps: {
        startDevServer: async () => { throw new Error('boot failed') },
        killDevServer: async () => {},
        waitForReady: async () => {},
        openBrowser: async () => silentBrowser(),
      },
    })

    expect(results[0].verdict).toBe('unverifiable')
    expect(results[0].screenshotPath).toBeNull()
  })
})
