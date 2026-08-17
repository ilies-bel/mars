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
 * and `screenshotPath` is the path relative to `worktreeDir`. Pass `outputDir`
 * to redirect artefacts to a stable, non-ephemeral directory (e.g. a `.mars/`
 * state directory) — in that case `screenshotPath` is relative to `outputDir`.
 * Callers that relocate artefacts out of the worktree must pass `outputDir`.
 */

import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { startDevServer, killDevServer } from '../../core/lib/dev-server'
import type { DevServerHandle, StartDevServerOptions } from '../../core/lib/dev-server'
import type { BootPlan } from './app-boot-discovery'

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
 * One concrete step in the QA step list generated for a criterion.
 *
 * The verifier writes a numbered prose step list for each criterion and then
 * walks the list against the running app, capturing one screenshot per step.
 * Each step records whether the walk reached it, and — for the step where the
 * walk stopped — the reason it stopped.
 */
export interface QaStep {
  /**
   * 1-based position of this step in the criterion's numbered step list.
   * Steps are always numbered from 1 regardless of how many criteria there are.
   */
  index: number
  /** Plain-language prose instruction ("click the Login button"). */
  instruction: string
  /**
   * Screenshot captured immediately after executing this step.
   * Null when the walk stopped before reaching this step, or when capture
   * failed after the step was executed.
   *
   * The path is relative to the `outputDir` option passed to
   * {@link runBrowserCheck} (or relative to `worktreeDir` when `outputDir` is
   * not provided).
   */
  screenshotPath: string | null
  /**
   * Human-readable reason the walk stopped at this step.
   * Absent when the step completed normally. Present on the last step in
   * `qaSteps` when the walk did not finish the full list — e.g.
   * `'element not found'`, `'navigation timeout'`, or `'app not booted'`.
   */
  stopReason?: string
}

/** Per-criterion result returned by {@link runBrowserCheck}. */
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
   * When `qaSteps` is present this is the screenshot from the final step
   * reached (the step-level screenshots are in `qaSteps[n].screenshotPath`).
   *
   * The path is relative to the `outputDir` option passed to
   * {@link runBrowserCheck} (or relative to `worktreeDir` when `outputDir` is
   * not provided).
   */
  screenshotPath: string | null
  /** Free-text note explaining the verdict or capture outcome. */
  note: string
  /**
   * Per-step evidence when the verifier walked a QA step list for this
   * criterion. Absent when no step list was generated (e.g. the app did not
   * boot, or the caller did not supply step generation).
   *
   * The step where the walk stopped has `stopReason` set; all subsequent
   * steps (if any) have `screenshotPath: null` and the same `stopReason`.
   */
  qaSteps?: readonly QaStep[]
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
 * Screenshots are written to `<outputDir>/<criterionIndex>.png` when
 * `outputDir` is provided, otherwise to `<worktreeDir>/qa/<criterionIndex>.png`.
 * `screenshotPath` on each result is the path relative to `outputDir` (or
 * relative to `worktreeDir` when `outputDir` is absent).
 *
 * @param bootPlan         - Discovered dev-server boot plan.
 * @param criteria         - DoD criterion strings; one result per entry.
 * @param opts.taskId      - Task id used to name the dev-server log file.
 * @param opts.worktreeDir - Worktree root; used as the screenshot base when
 *                           `outputDir` is not provided (legacy path).
 * @param opts.logDir      - Directory for dev-server stdout/stderr logs.
 * @param opts.outputDir   - When provided, screenshots are written here and
 *                           `screenshotPath` values are relative to this
 *                           directory. Use a stable `.mars/` state path so
 *                           artefacts survive worktree deletion after merge.
 * @param opts.deps        - Injectable overrides for all side effects (tests).
 */
export async function runBrowserCheck(
  bootPlan: BootPlan,
  criteria: readonly string[],
  opts: {
    taskId: string
    worktreeDir: string
    logDir: string
    /**
     * When provided, screenshots are written here instead of
     * `<worktreeDir>/qa/`. `screenshotPath` values in the returned results are
     * relative to this directory.
     *
     * Pass a stable `.mars/` state directory (e.g.
     * `join(marsStateDir, 'qa', arcId)`) so QA artefacts persist after the
     * worktree is pruned following a successful merge.
     */
    outputDir?: string
    deps?: Partial<BrowserCheckDeps>
  },
): Promise<CriterionResult[]> {
  const { taskId, worktreeDir, logDir } = opts
  const deps: BrowserCheckDeps = { ...defaultDeps, ...opts.deps }

  // Resolve the output base directory. When `outputDir` is provided artefacts
  // land in a stable location outside the worktree (e.g. `.mars/qa/<arcId>/`);
  // otherwise fall back to the legacy `<worktreeDir>/qa/` path.
  const outputBase = opts.outputDir ?? join(worktreeDir, 'qa')
  const qaDir = outputBase
  mkdirSync(qaDir, { recursive: true })

  const allUnverifiable = (reason: string): CriterionResult[] =>
    criteria.map((criterion) => ({
      criterion,
      verdict: 'unverifiable' as const,
      screenshotPath: null,
      note: reason,
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

    const browser = await deps.openBrowser()
    try {
      const results: CriterionResult[] = []

      for (let i = 0; i < criteria.length; i++) {
        const absPath = join(qaDir, `${i}.png`)
        // When `outputDir` is provided, screenshotPath is relative to
        // `outputDir` so callers can resolve the absolute path from it.
        // When falling back to `<worktreeDir>/qa/` (no outputDir), the path is
        // relative to `worktreeDir` — preserving the legacy `qa/<i>.png` form
        // that existing consumers and tests expect.
        const relPath = opts.outputDir != null
          ? relative(outputBase, absPath)
          : relative(worktreeDir, absPath)
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
          })
        }
      }

      return results
    } finally {
      await browser.close()
    }
  } catch (err) {
    return allUnverifiable(String(err))
  } finally {
    await deps.killDevServer(serverHandle?.pid ?? null)
  }
}
