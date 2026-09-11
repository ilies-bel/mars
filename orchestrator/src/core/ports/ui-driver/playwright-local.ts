/**
 * playwright-local — UiDriver implementation backed by a locally installed
 * Playwright package with downloaded browsers.
 *
 * ## Probe logic
 *
 * Reports `state: 'available'` only when ALL four prerequisites are met:
 *
 *  1. `@playwright/test` or `playwright` in the root or any workspace
 *     `package.json`. When the root declares no workspaces, common UI
 *     subdirectories (ui, frontend, web, client, app) are also scanned.
 *  2. A `playwright.config.{ts,js,mjs}` at the project root or, when none
 *     is found there, in those same common UI subdirectories.
 *  3. Installed browsers: `PLAYWRIGHT_BROWSERS_PATH` if set, otherwise
 *     `~/Library/Caches/ms-playwright` (macOS) or `~/.cache/ms-playwright`
 *     (Linux / macOS fallback), whichever is non-empty first.
 *  4. A runnable app surface via `discoverAppBoot`.
 *
 * ## Session execution
 *
 * Launches a headless Chromium browser, navigates to each capture URL, and
 * writes a PNG screenshot. Each capture is attempted independently — a
 * per-page failure is recorded but does not abort remaining captures.
 * The browser is always closed in a `finally` block.
 *
 * ## No self-registration
 *
 * This module does NOT import `./registry` or self-register. The registry
 * imports this module and registers it (same pattern as `vcs/local-git.ts`
 * and `executor/local-subprocess.ts`) to avoid temporal dead zone cycles.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverAppBoot } from '../../../workflows/primitives/app-boot-discovery.js'
import type { UiDriver, UiDriverProbeResult, UiSessionSpec, UiSessionResult } from './types.js'

// ---------------------------------------------------------------------------
// Probe helpers (package / config / browser detection)
// ---------------------------------------------------------------------------

/**
 * Common UI subdirectory names to probe when the repo root declares no
 * workspaces. Mirrors the list in `app-boot-discovery.ts` so both probes
 * cover the same monorepo layouts.
 */
const UI_SUBDIRS: ReadonlyArray<string> = ['ui', 'frontend', 'web', 'client', 'app']

/** True if `deps` (an object) contains `@playwright/test` or `playwright`. */
const hasPwDep = (deps: unknown): boolean => {
  if (typeof deps !== 'object' || deps === null) return false
  const d = deps as Record<string, unknown>
  return '@playwright/test' in d || 'playwright' in d
}

/** True when the directory's `package.json` declares Playwright as a dep. */
const playwrightInDir = (dir: string): boolean => {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    return hasPwDep(pkg.dependencies) || hasPwDep(pkg.devDependencies)
  } catch {
    return false
  }
}

/** Return workspace patterns from root `package.json`, or [] if absent/unreadable. */
const rootWorkspaces = (repoRoot: string): string[] => {
  const pkgPath = join(repoRoot, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    if (!Array.isArray(pkg.workspaces)) return []
    return pkg.workspaces.filter((w): w is string => typeof w === 'string')
  } catch {
    return []
  }
}

/**
 * Expand a single workspace glob pattern into concrete directories.
 * Handles the common `packages/*` form by listing the parent directory.
 * Literal paths (no `*`) are returned as-is.
 */
const expandWorkspacePattern = (repoRoot: string, pattern: string): string[] => {
  const parts = pattern.split('/')
  const last = parts[parts.length - 1]
  if (last === '*') {
    const parentDir = join(repoRoot, ...parts.slice(0, -1))
    if (!existsSync(parentDir)) return []
    try {
      return readdirSync(parentDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(parentDir, e.name))
    } catch {
      return []
    }
  }
  return [join(repoRoot, pattern)]
}

/** True when `@playwright/test` or `playwright` appears in the repo. */
const findPlaywright = (repoRoot: string): boolean => {
  if (playwrightInDir(repoRoot)) return true
  const patterns = rootWorkspaces(repoRoot)
  if (patterns.length > 0) {
    for (const pattern of patterns) {
      for (const dir of expandWorkspacePattern(repoRoot, pattern)) {
        if (playwrightInDir(dir)) return true
      }
    }
  } else {
    for (const sub of UI_SUBDIRS) {
      if (playwrightInDir(join(repoRoot, sub))) return true
    }
  }
  return false
}

const PW_CONFIG_FILES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']

/** True when a Playwright config file exists at `repoRoot` or any common UI subdir. */
const hasPlaywrightConfig = (repoRoot: string): boolean => {
  if (PW_CONFIG_FILES.some((f) => existsSync(join(repoRoot, f)))) return true
  for (const sub of UI_SUBDIRS) {
    const subDir = join(repoRoot, sub)
    if (!existsSync(subDir)) continue
    if (PW_CONFIG_FILES.some((f) => existsSync(join(subDir, f)))) return true
  }
  return false
}

/**
 * True when Playwright browsers appear to be installed.
 * Checks `PLAYWRIGHT_BROWSERS_PATH` when set, otherwise the platform default.
 */
const hasBrowsersInstalled = (): boolean => {
  const candidates: string[] = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : [
        ...(process.platform === 'darwin'
          ? [join(homedir(), 'Library', 'Caches', 'ms-playwright')]
          : []),
        join(homedir(), '.cache', 'ms-playwright'),
      ]
  return candidates.some((p) => {
    if (!existsSync(p)) return false
    try {
      return readdirSync(p).length > 0
    } catch {
      return false
    }
  })
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const probe = (repoRoot: string): UiDriverProbeResult => {
  const missing: string[] = []
  const setupSteps: string[] = []

  const pwFound = findPlaywright(repoRoot)
  if (!pwFound) {
    missing.push('@playwright/test is not listed in any package.json')
    setupSteps.push('npm install --save-dev @playwright/test')
  }

  if (!hasPlaywrightConfig(repoRoot)) {
    missing.push('No playwright.config.ts (or .js / .mjs) found at the project root')
    if (!setupSteps.some((s) => s.includes('playwright init'))) {
      setupSteps.push('npx playwright init')
    }
  }

  if (!hasBrowsersInstalled()) {
    missing.push('Playwright browsers are not installed')
    setupSteps.push('npx playwright install --with-deps chromium')
  }

  const bootPlan = discoverAppBoot(repoRoot)
  if (bootPlan === null) {
    missing.push('No runnable app surface detected (no dev server or framework config found)')
  }

  if (missing.length > 0) {
    return {
      state: 'absent',
      evidence: `playwright-local: ${missing[0]}`,
      setupSteps,
    }
  }

  return {
    state: 'available',
    evidence: `playwright-local: Playwright + config + browsers + app surface all present`,
    setupSteps: [],
  }
}

// ---------------------------------------------------------------------------
// Session execution
// ---------------------------------------------------------------------------

const runSession = async (spec: UiSessionSpec): Promise<UiSessionResult> => {
  // Dynamic import keeps @playwright/test off the cold-start require chain
  // when browser sessions are not needed (the same pattern as browser-check.ts).
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  try {
    const captureResults = []
    for (const capture of spec.captures) {
      const page = await browser.newPage()
      try {
        await page.goto(capture.navigateTo)
        await page.screenshot({ path: capture.screenshotPath })
        captureResults.push({ screenshotPath: capture.screenshotPath, error: null })
      } catch (err) {
        captureResults.push({ screenshotPath: null, error: String(err) })
      } finally {
        await page.close()
      }
    }
    return { captureResults }
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The `playwright-local` UiDriver implementation.
 * Registered in `registry.ts`; does NOT self-register.
 */
export const playwrightLocalDriver: UiDriver = {
  kind: 'playwright-local',
  capability: 'Headless Playwright/Chromium screenshot capture',
  installCost: 2,
  probe,
  runSession,
}
