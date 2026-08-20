/**
 * browser-check.ts — Playwright-driven screenshot capture for Definition-of-Done criteria.
 *
 * Starts the dev server from a BootPlan, opens a headless Chromium browser,
 * navigates to the app, and captures a screenshot for each DoD criterion.
 *
 * All verdicts in the returned array are 'unverifiable' — this function
 * captures screenshot evidence, not automated judgements. The screenshots
 * are attached to the behaviour-verify trace for human or downstream LLM review.
 *
 * Teardown is guaranteed: the dev server is killed in a `finally` block
 * regardless of whether the browser launch succeeded or failed.
 *
 * CI browser cache: set PLAYWRIGHT_BROWSERS_PATH to a persistent cache
 * directory (e.g. ~/.cache/ms-playwright) so
 * `npx playwright install --with-deps chromium` is not re-run on every CI job.
 *
 * QA artefact storage:
 * By default screenshots are written to `<worktreeDir>/qa/<criterionIndex>.png`
 * and `screenshotPath` is the path relative to `worktreeDir`. Pass
 * `artifactsDir` to redirect artefacts to a stable, non-ephemeral directory
 * (e.g. a `.mars/` state directory) — in that case `screenshotPath` is relative
 * to `artifactsDir`. Callers that relocate artefacts out of the worktree must
 * pass `artifactsDir`.
 */

import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// ---------------------------------------------------------------------------
// QA step-list contract
// ---------------------------------------------------------------------------

/**
 * A list of numbered QA steps for one behaviour criterion.
 * Passed to {@link runQaWalk} so the verifier can walk them step by step
 * and capture per-step screenshots.
 */
export interface QaStepList {
  /** The DoD criterion text this step list targets. */
  criterion: string
  /**
   * Ordered steps for walking this criterion. `index` values must be unique
   * within the list; by convention they are 1-based.
   */
  steps: Array<{ index: number; text: string }>
}

import { startDevServer, killDevServer } from '../../core/lib/dev-server'
import type { DevServerHandle, StartDevServerOptions } from '../../core/lib/dev-server'
import { acquireSemaphore, releaseSemaphore } from '../../core/lib/semaphore'
import type { BootPlan } from './app-boot-discovery'

// How long to wait for the shared `browser` permit before proceeding
// anyway — the semaphore is advisory, so a stuck user-level browser skill
// session must not hang (or fail) a Mars task indefinitely.
const BROWSER_SEMAPHORE_WAIT_SEC = 20

// ---------------------------------------------------------------------------
// Minimal structural browser types
// Real Playwright Browser/Page types satisfy these structurally, so tests can
// provide plain objects without importing from @playwright/test.
// ---------------------------------------------------------------------------

interface MinimalPage {
  goto(url: string): Promise<unknown>
  screenshot(opts: { path: string }): Promise<unknown>
  close(): Promise<void>
}

interface MinimalBrowser {
  newPage(): Promise<MinimalPage>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-step result when the verifier walks an explicit numbered QA step list
 * for a criterion. Populated by the step-walker consumer; empty by default
 * when `runBrowserCheck` is called without an explicit step list.
 *
 * This is the *walk evidence* for one step. The authored prose step itself is
 * `QaStep` in the shared QA step-list contract (`core/lib/arc-verifier.ts`),
 * which is deliberately a distinct type — and a distinct name — from this one.
 */
export interface QaStepResult {
  /** Zero-based step index within the criterion's step list. */
  stepIndex: number
  /** The step's prose description. */
  text: string
  /**
   * Screenshot path captured for this step. Relative to the active artefacts
   * directory (either `artifactsDir` when provided, or `<worktreeDir>/qa/`).
   * Null when the screenshot was not captured for this step — e.g. the walk
   * stopped before reaching it, or capture failed after it executed.
   */
  screenshotPath: string | null
  /** Operator note for this step's outcome. */
  note: string
}

/** Per-criterion result returned by {@link runBrowserCheck} and {@link runQaWalk}. */
export interface CriterionResult {
  /** The DoD criterion text (verbatim from the criteria array). */
  criterion: string
  /**
   * Tri-state verdict. All automated verdicts from this function are
   * 'unverifiable' — screenshot capture is not AI evaluation.
   * 'fail' and 'pass' are reserved for future layers that evaluate evidence.
   */
  verdict: 'pass' | 'fail' | 'unverifiable'
  /**
   * Path to the screenshot for this criterion as a whole, or null when no
   * screenshot was captured.
   *
   * When `steps` is non-empty this is the screenshot from the final step
   * reached (the step-level screenshots are in `steps[n].screenshotPath`).
   *
   * Relative to `artifactsDir` when that option is provided; otherwise
   * relative to `worktreeDir` (legacy: `qa/<index>.png`).
   */
  screenshotPath: string | null
  /** Free-text note explaining the verdict or capture outcome. */
  note: string
  /**
   * Per-step walk results when the verifier walked an explicit QA step list.
   * Empty array when the criterion was verified without a step-by-step walk
   * (the default `runBrowserCheck` behaviour), e.g. because the app did not
   * boot or the caller supplied no step list.
   */
  steps: ReadonlyArray<QaStepResult>
  /**
   * Which step stopped the walk and why; null when the walk completed normally
   * or when no step list was walked. Populated by the step-walker layer.
   */
  stopAt: { stepIndex: number; reason: string } | null
  /**
   * 0-based sentinel or 1-based step index at which the walk stopped, or
   * `null` when the walk was never attempted or completed all steps.
   *
   * `0` is a sentinel meaning the walk did not start (server never ready,
   * browser failed to launch before any step ran).  When a step at position N
   * failed, `stoppedAtStep` equals that step's `index` value.
   *
   * Populated only by {@link runQaWalk}. Always `null` from
   * {@link runBrowserCheck}.
   */
  stoppedAtStep: number | null
  /**
   * Why the walk stopped, or `null` when no walk was attempted.
   *
   * - `'server-not-ready'` — dev server never became healthy.
   * - `'browser-launch'`   — browser or page could not be opened.
   * - `'navigation'`       — `page.goto` threw during a step.
   * - `'completed'`        — every step was reached (some screenshots may be
   *                          null if screenshot capture failed at a step).
   *
   * Populated only by {@link runQaWalk}. Always `null` from
   * {@link runBrowserCheck}.
   */
  stopReason: 'server-not-ready' | 'browser-launch' | 'navigation' | 'completed' | null
}

/**
 * Injectable side-effect seams. Defaults to real implementations.
 * Override for tests so no real browser or dev server is needed.
 */
export interface BrowserCheckDeps {
  startDevServer: (opts: StartDevServerOptions) => Promise<DevServerHandle>
  killDevServer: (pid: number | null) => Promise<void>
  /** Poll `url` until the dev server responds with a non-5xx HTTP status. */
  waitForReady: (url: string) => Promise<void>
  /** Launch a headless browser. The real default uses Playwright Chromium. */
  openBrowser: () => Promise<MinimalBrowser>
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

const defaultWaitForReady = async (url: string): Promise<void> => {
  const TIMEOUT_MS = 30_000
  const POLL_MS = 250
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      // Any non-server-error response means the server is ready.
      if (res.status < 500) return
    } catch {
      // Server not ready yet — keep polling.
    }
    await new Promise<void>((r) => setTimeout(r, POLL_MS))
  }
  throw new Error(
    `dev server at ${url} did not become healthy within ${TIMEOUT_MS / 1000} s`,
  )
}

const defaultOpenBrowser = async (): Promise<MinimalBrowser> => {
  // Dynamic import keeps @playwright/test out of the cold-start require chain
  // and off the import graph when browser checks are skipped.
  const { chromium } = await import('@playwright/test')
  return chromium.launch({ headless: true })
}

const defaultDeps: BrowserCheckDeps = {
  startDevServer,
  killDevServer,
  waitForReady: defaultWaitForReady,
  openBrowser: defaultOpenBrowser,
}

// ---------------------------------------------------------------------------
// runBrowserCheck
// ---------------------------------------------------------------------------

/**
 * Launch the app from `bootPlan`, open a headless browser, and capture a
 * screenshot for every entry in `criteria`. Returns one {@link CriterionResult}
 * per criterion. All verdicts are 'unverifiable' — the function produces
 * screenshot evidence for later review, not automated judgements.
 *
 * When the dev server fails to start, health check fails, or browser launch
 * fails, every criterion is returned as 'unverifiable' with the failure reason
 * in `note`. The verdict is never silently 'pass' on infrastructure failure.
 *
 * Dev-server teardown is guaranteed: {@link killDevServer} is called in a
 * `finally` block on both the success and failure paths.
 *
 * Screenshots are written to `<artifactsDir>/<criterionIndex>.png` when
 * `artifactsDir` is provided, otherwise to
 * `<worktreeDir>/qa/<criterionIndex>.png`. `screenshotPath` on each result is
 * the path relative to `artifactsDir` (or relative to `worktreeDir` when
 * `artifactsDir` is absent).
 *
 * @param bootPlan          - Discovered dev-server boot plan.
 * @param criteria          - DoD criterion strings; one result per entry.
 * @param opts.taskId       - Task id used to name the dev-server log file.
 * @param opts.worktreeDir  - Worktree root; used as the screenshot base when
 *                            `artifactsDir` is not provided (legacy path).
 * @param opts.logDir       - Directory for dev-server stdout/stderr logs.
 * @param opts.artifactsDir - When provided, screenshots are written here and
 *                            `screenshotPath` values are relative to this
 *                            directory. Use a stable `.mars/` state path so
 *                            artefacts survive worktree deletion after merge.
 * @param opts.deps         - Injectable overrides for all side effects (tests).
 */
export async function runBrowserCheck(
  bootPlan: BootPlan,
  criteria: readonly string[],
  opts: {
    taskId: string
    worktreeDir: string
    logDir: string
    /**
     * Directory where QA artefacts (screenshots) are written. When provided,
     * screenshots go here and `screenshotPath` on each result is relative to
     * this directory. When absent the legacy `<worktreeDir>/qa/` location is
     * used and `screenshotPath` is relative to `worktreeDir`.
     *
     * Use this option to relocate artefacts outside the git-tracked worktree
     * so screenshots are not committed with the task branch. Pass a stable
     * `.mars/` state directory (e.g. `join(marsStateDir, 'qa', arcId)`) so QA
     * artefacts also persist after the worktree is pruned following a
     * successful merge.
     */
    artifactsDir?: string
    deps?: Partial<BrowserCheckDeps>
  },
): Promise<CriterionResult[]> {
  const { taskId, worktreeDir, logDir } = opts
  const deps: BrowserCheckDeps = { ...defaultDeps, ...opts.deps }

  // Screenshot storage: when `artifactsDir` is provided artefacts land in a
  // stable location outside the worktree (e.g. `.mars/qa/<arcId>/`); otherwise
  // fall back to the legacy `<worktreeDir>/qa/` path. The base used for
  // relative-path computation follows, so `screenshotPath` is always relative
  // to whichever directory actually holds the screenshots — and the legacy
  // `qa/<i>.png` form is preserved for existing consumers and tests.
  const qaDir = opts.artifactsDir ?? join(worktreeDir, 'qa')
  const screenshotBase = opts.artifactsDir ?? worktreeDir
  mkdirSync(qaDir, { recursive: true })

  const allUnverifiable = (reason: string): CriterionResult[] =>
    criteria.map((criterion) => ({
      criterion,
      verdict: 'unverifiable' as const,
      screenshotPath: null,
      note: reason,
      steps: [],
      stopAt: null,
      stoppedAtStep: null,
      stopReason: null,
    }))

  let serverHandle: DevServerHandle | null = null

  try {
    serverHandle = await deps.startDevServer({
      command: bootPlan.cmd,
      cwd: bootPlan.cwd,
      taskId,
      logDir,
    })

    await deps.waitForReady(serverHandle.url)

    // Hold the shared `browser` permit for the Playwright session's
    // lifetime. Acquired before openBrowser() and released in the outer
    // finally so a leak on the launch-failure path is impossible.
    const browserPermit = await acquireSemaphore('browser', {
      holder: `mars:${taskId}`,
      waitSec: BROWSER_SEMAPHORE_WAIT_SEC,
    })
    try {
      const browser = await deps.openBrowser()
      try {
        const results: CriterionResult[] = []

        for (let i = 0; i < criteria.length; i++) {
          const absPath = join(qaDir, `${i}.png`)
          const relPath = relative(screenshotBase, absPath)
          try {
            const page = await browser.newPage()
            try {
              await page.goto(serverHandle.url)
              await page.screenshot({ path: absPath })
              results.push({
                criterion: criteria[i],
                verdict: 'unverifiable',
                screenshotPath: relPath,
                note: 'screenshot captured; automated verdict not available',
                steps: [],
                stopAt: null,
                stoppedAtStep: null,
                stopReason: null,
              })
            } finally {
              await page.close()
            }
          } catch (pageErr) {
            results.push({
              criterion: criteria[i],
              verdict: 'unverifiable',
              screenshotPath: null,
              note: `screenshot failed: ${String(pageErr)}`,
              steps: [],
              stopAt: null,
              stoppedAtStep: null,
              stopReason: null,
            })
          }
        }

        return results
      } finally {
        await browser.close()
      }
    } finally {
      await releaseSemaphore(browserPermit)
    }
  } catch (err) {
    return allUnverifiable(String(err))
  } finally {
    await deps.killDevServer(serverHandle?.pid ?? null)
  }
}

// ---------------------------------------------------------------------------
// runQaWalk — per-step screenshot walk
// ---------------------------------------------------------------------------

/**
 * Launch the app from `bootPlan`, open a headless browser, and walk each
 * {@link QaStepList} step by step, capturing a screenshot per step.
 *
 * Returns one {@link CriterionResult} per entry in `stepLists`. All verdicts
 * are `'unverifiable'` — this function captures evidence, not judgements.
 *
 * **Screenshot paths:** `<artefactsDir>/<criterionIndex>/<stepIndex>.png`
 * (or `<worktreeDir>/qa/<criterionIndex>/<stepIndex>.png` when `artifactsDir`
 * is absent). `screenshotPath` on each step result is relative to whichever
 * base directory is active.
 *
 * **Stop semantics:**
 * - `'server-not-ready'` — dev server never became healthy; `stoppedAtStep: 0`
 *   on every criterion.
 * - `'browser-launch'`   — browser (or a page) could not be opened;
 *   `stoppedAtStep: 0`.
 * - `'navigation'`       — `page.goto` threw for a specific step; walk stops
 *   for that criterion at `stoppedAtStep = step.index`.
 * - `'completed'`        — every step was attempted; individual screenshot
 *   failures are page-level and do not abort the walk.
 *
 * Teardown is guaranteed: `killDevServer` is always called in a `finally`.
 */
export async function runQaWalk(
  bootPlan: BootPlan,
  stepLists: readonly QaStepList[],
  opts: {
    taskId: string
    worktreeDir: string
    logDir: string
    artifactsDir?: string
    deps?: Partial<BrowserCheckDeps>
  },
): Promise<CriterionResult[]> {
  const { taskId, worktreeDir, logDir } = opts
  const deps: BrowserCheckDeps = { ...defaultDeps, ...opts.deps }

  const qaDir = opts.artifactsDir ?? join(worktreeDir, 'qa')
  const screenshotBase = opts.artifactsDir ?? worktreeDir
  mkdirSync(qaDir, { recursive: true })

  /** Return all-unverifiable results with the given stop reason. */
  const allUnverifiable = (
    reason: string,
    stopReason: 'server-not-ready' | 'browser-launch',
  ): CriterionResult[] =>
    stepLists.map((sl) => ({
      criterion: sl.criterion,
      verdict: 'unverifiable' as const,
      screenshotPath: null,
      note: reason,
      steps: [],
      stopAt: null,
      stoppedAtStep: 0,
      stopReason,
    }))

  let serverHandle: DevServerHandle | null = null

  try {
    // ── Server startup + readiness ──────────────────────────────────────────
    try {
      serverHandle = await deps.startDevServer({
        command: bootPlan.cmd,
        cwd: bootPlan.cwd,
        taskId,
        logDir,
      })
      await deps.waitForReady(serverHandle.url)
    } catch (serverErr) {
      return allUnverifiable(String(serverErr), 'server-not-ready')
    }

    // ── Browser launch ──────────────────────────────────────────────────────
    // Hold the shared `browser` permit for the whole launch-through-close
    // lifetime; the outer finally releases it on every exit path, including
    // a launch failure, so nothing leaks.
    const browserPermit = await acquireSemaphore('browser', {
      holder: `mars:${taskId}`,
      waitSec: BROWSER_SEMAPHORE_WAIT_SEC,
    })
    try {
      let browser: MinimalBrowser
      try {
        browser = await deps.openBrowser()
      } catch (browserErr) {
        return allUnverifiable(String(browserErr), 'browser-launch')
      }

      // ── Per-criterion step walk ───────────────────────────────────────────
      try {
        const results: CriterionResult[] = []

        for (let i = 0; i < stepLists.length; i++) {
          const { criterion, steps } = stepLists[i]
          const criterionDir = join(qaDir, `${i}`)
          mkdirSync(criterionDir, { recursive: true })

          const stepResults: QaStepResult[] = []
          let stoppedAtStep: number | null = null
          let stopReason: CriterionResult['stopReason'] = null

          // Open a fresh page for this criterion.
          let page: MinimalPage
          try {
            page = await browser.newPage()
          } catch (pageErr) {
            // Browser crash — cannot open page; abort this criterion.
            results.push({
              criterion,
              verdict: 'unverifiable',
              screenshotPath: null,
              note: `page open failed: ${String(pageErr)}`,
              steps: stepResults,
              stopAt: { stepIndex: 0, reason: 'browser-launch' },
              stoppedAtStep: 0,
              stopReason: 'browser-launch',
            })
            continue
          }

          try {
            for (const step of steps) {
              const absPath = join(criterionDir, `${step.index}.png`)
              const relPath = relative(screenshotBase, absPath)

              // Navigation — a failure here stops the walk for this criterion.
              try {
                await page.goto(serverHandle.url)
              } catch (navErr) {
                stepResults.push({
                  stepIndex: step.index,
                  text: step.text,
                  screenshotPath: null,
                  note: `navigation failed: ${String(navErr)}`,
                })
                stoppedAtStep = step.index
                stopReason = 'navigation'
                break
              }

              // Screenshot — a failure is page-level; walk continues.
              let screenshotPath: string | null = null
              try {
                await page.screenshot({ path: absPath })
                screenshotPath = relPath
              } catch {
                // page-level failure — continue to the next step
              }

              stepResults.push({
                stepIndex: step.index,
                text: step.text,
                screenshotPath,
                note: screenshotPath !== null ? 'screenshot captured' : 'screenshot failed',
              })
            }

            if (stoppedAtStep === null) {
              stopReason = 'completed'
            }
          } finally {
            await page.close()
          }

          // Overall screenshotPath for the criterion = last step that captured one.
          const lastScreenshot = stepResults.reduceRight<string | null>(
            (acc, s) => acc ?? s.screenshotPath,
            null,
          )

          results.push({
            criterion,
            verdict: 'unverifiable',
            screenshotPath: lastScreenshot,
            note:
              stopReason === 'completed'
                ? 'all steps reached'
                : `stopped at step ${stoppedAtStep}: ${stopReason}`,
            steps: stepResults,
            stopAt:
              stoppedAtStep !== null
                ? { stepIndex: stoppedAtStep, reason: stopReason ?? '' }
                : null,
            stoppedAtStep,
            stopReason,
          })
        }

        return results
      } finally {
        await browser.close()
      }
    } finally {
      await releaseSemaphore(browserPermit)
    }
  } finally {
    await deps.killDevServer(serverHandle?.pid ?? null)
  }
}
