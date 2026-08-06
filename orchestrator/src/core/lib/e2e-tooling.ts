/**
 * E2E tooling probe — inspects a repo root and reports whether a live E2E
 * pass is possible without any per-task configuration.
 *
 * The function is intentionally pure (reads the filesystem, no network, no
 * child processes) so it can be called inside a `runNonLlmStepWithSpan` and
 * in unit tests against fixture directories.
 *
 * Detection order:
 *  1. `@playwright/test` or `playwright` in the root or any workspace
 *     `package.json`.
 *  2. A `playwright.config.{ts,js,mjs}` at the project root.
 *  3. Installed browsers: `PLAYWRIGHT_BROWSERS_PATH` if set, otherwise
 *     `~/.cache/ms-playwright`.
 *  4. A runnable app surface via {@link discoverAppBoot}.
 *
 * Returns an {@link E2eToolingReport} where `available` is true only when all
 * four checks pass. When `available` is false, `missing` lists each absent
 * piece and `setupSteps` lists the exact commands to fix them, in order.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverAppBoot } from '../../workflows/primitives/app-boot-discovery.js'

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface E2eToolingReport {
  /** Whether all E2E tooling prerequisites are satisfied. */
  available: boolean
  /** E2E runner detected. `'playwright'` when the package is present even if
   *  not all prerequisites are met; `'none'` when playwright is absent. */
  runner: 'playwright' | 'none'
  /** Human-readable descriptions of what is absent. */
  missing: string[]
  /** Exact shell commands to install what is missing, in order. */
  setupSteps: string[]
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** True if `deps` (an object) contains `@playwright/test` or `playwright`. */
const hasPwDep = (deps: unknown): boolean => {
  if (typeof deps !== 'object' || deps === null) return false
  const d = deps as Record<string, unknown>
  return '@playwright/test' in d || 'playwright' in d
}

/**
 * Check whether a single directory's `package.json` declares Playwright as a
 * dependency or devDependency.
 */
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

/**
 * Return the workspace patterns from a root `package.json`, or an empty array
 * if no `workspaces` field is present or the file cannot be read.
 */
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

/**
 * True when `@playwright/test` or `playwright` appears in the root
 * `package.json` or in any workspace `package.json`.
 */
const findPlaywright = (repoRoot: string): boolean => {
  if (playwrightInDir(repoRoot)) return true
  const patterns = rootWorkspaces(repoRoot)
  for (const pattern of patterns) {
    const dirs = expandWorkspacePattern(repoRoot, pattern)
    for (const dir of dirs) {
      if (playwrightInDir(dir)) return true
    }
  }
  return false
}

/** True when a `playwright.config.{ts,js,mjs}` exists at `repoRoot`. */
const hasPlaywrightConfig = (repoRoot: string): boolean =>
  ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].some((f) =>
    existsSync(join(repoRoot, f)),
  )

/**
 * True when Playwright browsers appear to be installed.
 *
 * Checks `PLAYWRIGHT_BROWSERS_PATH` when set; otherwise falls back to
 * `~/.cache/ms-playwright` (the default on Linux and macOS).
 */
const hasBrowsersInstalled = (): boolean => {
  const browserPath =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(browserPath)) return false
  try {
    return readdirSync(browserPath).length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect `repoRoot` to determine whether the E2E tooling prerequisites are
 * in place. Returns an {@link E2eToolingReport} describing what is available,
 * what is missing, and how to fix it.
 *
 * This is a pure filesystem read — no processes are spawned and no network is
 * touched.
 */
export const probeE2eTooling = (repoRoot: string): E2eToolingReport => {
  const missing: string[] = []
  const setupSteps: string[] = []

  // 1. Playwright package
  const pwFound = findPlaywright(repoRoot)
  if (!pwFound) {
    missing.push('@playwright/test is not listed in any package.json')
    setupSteps.push('npm install --save-dev @playwright/test')
  }

  // 2. Playwright config
  if (!hasPlaywrightConfig(repoRoot)) {
    missing.push('No playwright.config.ts (or .js / .mjs) found at the project root')
    if (!setupSteps.some((s) => s.includes('playwright init'))) {
      setupSteps.push('npx playwright init')
    }
  }

  // 3. Installed browsers
  if (!hasBrowsersInstalled()) {
    missing.push('Playwright browsers are not installed')
    setupSteps.push('npx playwright install --with-deps chromium')
  }

  // 4. Runnable app surface
  const bootPlan = discoverAppBoot(repoRoot)
  if (bootPlan === null) {
    missing.push(
      'No runnable app surface detected (no dev server or framework config found)',
    )
  }

  const available = missing.length === 0
  return {
    available,
    runner: pwFound ? 'playwright' : 'none',
    missing,
    setupSteps,
  }
}
