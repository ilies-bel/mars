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
   * Path to the screenshot, relative to the worktree root (`qa/<index>.png`),
   * or null when no screenshot was captured for this criterion.
   */
  screenshotPath: string | null
  /** Free-text note explaining the verdict or capture outcome. */
  note: string
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
 * Screenshots are written to `<worktreeDir>/qa/<criterionIndex>.png`.
 * `screenshotPath` on each result is the relative path from `worktreeDir`.
 *
 * @param bootPlan       - Discovered dev-server boot plan.
 * @param criteria       - DoD criterion strings; one result per entry.
 * @param opts.taskId    - Task id used to name the dev-server log file.
 * @param opts.worktreeDir - Worktree root; screenshots written to `<worktreeDir>/qa/`.
 * @param opts.logDir    - Directory for dev-server stdout/stderr logs.
 * @param opts.deps      - Injectable overrides for all side effects (tests).
 */
export async function runBrowserCheck(
  bootPlan: BootPlan,
  criteria: readonly string[],
  opts: {
    taskId: string
    worktreeDir: string
    logDir: string
    deps?: Partial<BrowserCheckDeps>
  },
): Promise<CriterionResult[]> {
  const { taskId, worktreeDir, logDir } = opts
  const deps: BrowserCheckDeps = { ...defaultDeps, ...opts.deps }

  const qaDir = join(worktreeDir, 'qa')
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
        const relPath = relative(worktreeDir, absPath)
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
