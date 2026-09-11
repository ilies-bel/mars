/**
 * chrome-exec — UiDriver implementation backed by a system Chrome/Chromium
 * binary invoked via its `--headless --screenshot` CLI flags.
 *
 * ## Rationale for this as a second implementation
 *
 * `playwright-local` needs an npm package AND downloaded browser binaries.
 * `chrome-exec` needs only a Chrome install — which most developer machines
 * already have. This makes it a cheaper alternative that exercises the
 * registry abstraction on machines where the full Playwright stack is absent.
 *
 * ## Probe logic
 *
 * Reports `state: 'available'` only when:
 *  1. A Chrome or Chromium binary is found at one of the well-known system
 *     paths (macOS `/Applications/Google Chrome.app/…`, Linux
 *     `/usr/bin/google-chrome`, etc.). No child processes are spawned —
 *     presence is checked with `existsSync` only.
 *  2. A runnable app surface is discovered via `discoverAppBoot`.
 *
 * ## Session execution
 *
 * For each capture in the session spec, spawns:
 *
 *   chrome --headless --no-sandbox --screenshot=<path> <url>
 *
 * Each capture is an independent child process. A per-capture failure is
 * recorded as `{ screenshotPath: null, error: … }` and does not abort the
 * remaining captures.
 *
 * Chrome 112+ uses `--headless=new`; older versions use `--headless`. This
 * implementation tries `--headless=new` first and falls back to `--headless`
 * on exit-code 1 (the flag is unknown to older Chrome). The fallback only
 * happens per-session, not per-capture.
 *
 * ## No self-registration
 *
 * Does NOT import `./registry` or self-register. The registry registers it.
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { discoverAppBoot } from '../../../workflows/primitives/app-boot-discovery.js'
import type { UiDriver, UiDriverProbeResult, UiSessionSpec, UiSessionResult } from './types.js'

// ---------------------------------------------------------------------------
// Chrome binary detection
// ---------------------------------------------------------------------------

/** Well-known absolute paths for Chrome/Chromium on macOS. */
const CHROME_PATHS_DARWIN: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]

/** Well-known absolute paths for Chrome/Chromium on Linux. */
const CHROME_PATHS_LINUX: readonly string[] = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
]

/** Well-known absolute paths for Chrome on Windows. */
const CHROME_PATHS_WIN: readonly string[] = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/**
 * Return the path of the first Chrome/Chromium binary found, or `null`.
 * Pure filesystem check — no child processes.
 */
const findChromeBinary = (): string | null => {
  const paths =
    process.platform === 'darwin'
      ? CHROME_PATHS_DARWIN
      : process.platform === 'win32'
        ? CHROME_PATHS_WIN
        : CHROME_PATHS_LINUX

  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return null
}

/** Platform-appropriate install hint shown in the operator card. */
const installHint = (): string => {
  if (process.platform === 'darwin') return 'brew install --cask google-chrome'
  if (process.platform === 'win32')
    return 'Download from https://www.google.com/chrome/'
  return 'sudo apt install chromium-browser  # or: snap install chromium'
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const probe = (repoRoot: string): UiDriverProbeResult => {
  const binary = findChromeBinary()
  if (binary === null) {
    return {
      state: 'absent',
      evidence: 'chrome-exec: no Chrome/Chromium binary found at known system paths',
      setupSteps: [installHint()],
    }
  }

  const bootPlan = discoverAppBoot(repoRoot)
  if (bootPlan === null) {
    return {
      state: 'absent',
      evidence: 'chrome-exec: Chrome binary found but no runnable app surface detected',
      setupSteps: [],
    }
  }

  return {
    state: 'available',
    evidence: `chrome-exec: Chrome found at ${binary}`,
    setupSteps: [],
  }
}

// ---------------------------------------------------------------------------
// Session execution helpers
// ---------------------------------------------------------------------------

/**
 * Spawn Chrome with the given flags and wait for it to exit.
 * Resolves on exit-code 0; rejects on non-zero exit or spawn error.
 */
const spawnChrome = (binary: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Chrome exited with code ${code}`))
    })
  })

/**
 * Take one screenshot by invoking Chrome's `--screenshot` flag.
 * Tries `--headless=new` first (Chrome 112+); falls back to `--headless`
 * when the newer flag is unsupported.
 */
const chromeScreenshot = async (
  binary: string,
  navigateTo: string,
  screenshotPath: string,
  useLegacyHeadless: boolean,
): Promise<void> => {
  const headlessFlag = useLegacyHeadless ? '--headless' : '--headless=new'
  const args = [
    headlessFlag,
    '--no-sandbox',
    '--disable-gpu',
    `--screenshot=${screenshotPath}`,
    navigateTo,
  ]
  await spawnChrome(binary, args)
}

// ---------------------------------------------------------------------------
// Session execution
// ---------------------------------------------------------------------------

const runSession = async (spec: UiSessionSpec): Promise<UiSessionResult> => {
  const binary = findChromeBinary()
  if (binary === null) {
    return {
      captureResults: spec.captures.map(() => ({
        screenshotPath: null,
        error: 'Chrome binary not found — cannot open browser session',
      })),
    }
  }

  // Probe which headless flag works on this Chrome version once per session.
  let useLegacyHeadless = false
  try {
    // A dry-run with --headless=new and about:blank reveals unsupported flag.
    // We use a non-existent screenshot path on purpose: we just want the exit
    // code. Chrome exits non-zero when the flag is unknown.
    await spawnChrome(binary, ['--headless=new', '--no-sandbox', '--disable-gpu', '--screenshot=/dev/null', 'about:blank'])
  } catch {
    useLegacyHeadless = true
  }

  const captureResults = []
  for (const capture of spec.captures) {
    try {
      await chromeScreenshot(binary, capture.navigateTo, capture.screenshotPath, useLegacyHeadless)
      captureResults.push({ screenshotPath: capture.screenshotPath, error: null })
    } catch (err) {
      captureResults.push({ screenshotPath: null, error: String(err) })
    }
  }
  return { captureResults }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The `chrome-exec` UiDriver implementation.
 * Registered in `registry.ts`; does NOT self-register.
 */
export const chromeExecDriver: UiDriver = {
  kind: 'chrome-exec',
  capability: 'System Chrome/Chromium headless screenshot via --screenshot flag',
  installCost: 1,
  probe,
  runSession,
}
