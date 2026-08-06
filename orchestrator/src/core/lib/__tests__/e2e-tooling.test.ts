/**
 * Unit tests for probeE2eTooling.
 *
 * Each test builds a minimal fixture directory on-disk then calls
 * probeE2eTooling and asserts on the returned report. No child processes are
 * spawned; the function is pure filesystem-only.
 *
 * Test cases:
 *   1. Everything present     → available: true
 *   2. Playwright missing     → available: false, missing/setupSteps mention package
 *   3. Browsers missing       → available: false, setupSteps include playwright install
 *   4. No boot plan           → available: false, missing mentions dev server
 *   5. Monorepo subdirectory  → boot plan resolved from ui/ subdir, available varies
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeE2eTooling } from '../e2e-tooling'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory, returned path is cleaned up in afterEach. */
let tmpDirs: string[] = []
const makeTmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mars-e2e-tooling-test-'))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tmpDirs = []
})

/** Write a package.json with optional playwright in devDependencies. */
const writePackageJson = (
  dir: string,
  opts: {
    playwright?: boolean
    scripts?: Record<string, string>
    workspaces?: string[]
  } = {},
): void => {
  const devDependencies: Record<string, string> = {}
  if (opts.playwright) devDependencies['@playwright/test'] = '^1.0.0'
  const pkg: Record<string, unknown> = {
    name: 'test-pkg',
    version: '1.0.0',
    scripts: opts.scripts ?? {},
    devDependencies,
  }
  if (opts.workspaces) pkg.workspaces = opts.workspaces
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
}

/** Write a playwright config file at project root. */
const writePlaywrightConfig = (dir: string, ext = 'ts'): void => {
  writeFileSync(join(dir, `playwright.config.${ext}`), '// playwright config\n')
}

/** Create a fake browsers directory under the given path with one entry. */
const createBrowsersDir = (browsersPath: string): void => {
  const chromiumDir = join(browsersPath, 'chromium-1234')
  mkdirSync(chromiumDir, { recursive: true })
  writeFileSync(join(chromiumDir, 'chrome'), '#!/bin/sh\n')
}

/** Run the probe with PLAYWRIGHT_BROWSERS_PATH overridden to a temp dir. */
const probeWithBrowserPath = (repoRoot: string, browsersPath: string) => {
  const prev = process.env.PLAYWRIGHT_BROWSERS_PATH
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
  try {
    return probeE2eTooling(repoRoot)
  } finally {
    if (prev === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = prev
    }
  }
}

// ---------------------------------------------------------------------------
// Test 1: Everything present → available: true
// ---------------------------------------------------------------------------

describe('probeE2eTooling', () => {
  describe('everything present', () => {
    it('returns available:true when playwright, config, browsers, and boot plan are all present', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      writePlaywrightConfig(root)
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.available).toBe(true)
      expect(report.runner).toBe('playwright')
      expect(report.missing).toHaveLength(0)
      expect(report.setupSteps).toHaveLength(0)
    })

    it('detects playwright.config.js as a valid config', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      writePackageJson(root, { playwright: true, scripts: { dev: 'next dev' } })
      writePlaywrightConfig(root, 'js')
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.available).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 2: Playwright missing
  // ---------------------------------------------------------------------------

  describe('playwright missing', () => {
    it('returns available:false and mentions playwright in missing when no playwright package', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // No playwright dep, but has a dev script and config
      writePackageJson(root, { playwright: false, scripts: { dev: 'npm start' } })
      writePlaywrightConfig(root)
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.available).toBe(false)
      expect(report.runner).toBe('none')
      expect(report.missing.some((m) => m.includes('@playwright/test'))).toBe(true)
      expect(report.setupSteps.some((s) => s.includes('npm install'))).toBe(true)
    })

    it('reports no playwright config as a separate missing item when playwright is also absent', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      writePackageJson(root, { playwright: false, scripts: { dev: 'npm start' } })
      // No playwright.config file
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.available).toBe(false)
      // At least playwright package and config are missing
      expect(report.missing.length).toBeGreaterThanOrEqual(2)
    })

    it('sets runner to playwright when playwright dep is found even if other pieces missing', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Playwright present but no config, no browsers dir populated
      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      // browsersDir is empty (no chromium subdir) → browsers missing

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.runner).toBe('playwright')
      expect(report.available).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 3: Browsers missing
  // ---------------------------------------------------------------------------

  describe('browsers missing', () => {
    it('returns available:false and includes playwright install step when browsers dir is absent', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir() // exists but EMPTY

      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      writePlaywrightConfig(root)
      // browsersDir has NO subdirectories → hasBrowsersInstalled returns false

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.available).toBe(false)
      expect(report.missing.some((m) => m.toLowerCase().includes('browser'))).toBe(true)
      expect(
        report.setupSteps.some((s) => s.includes('playwright install')),
      ).toBe(true)
    })

    it('treats a non-existent browsers path as missing', () => {
      const root = makeTmpDir()

      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      writePlaywrightConfig(root)

      const report = probeWithBrowserPath(root, '/nonexistent-path-for-tests/ms-playwright')

      expect(report.available).toBe(false)
      expect(report.missing.some((m) => m.toLowerCase().includes('browser'))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 4: No boot plan
  // ---------------------------------------------------------------------------

  describe('no boot plan', () => {
    it('returns available:false and mentions dev server when no runnable surface is found', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // package.json with no scripts at all → discoverAppBoot returns null
      writePackageJson(root, { playwright: true, scripts: {} })
      writePlaywrightConfig(root)
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.available).toBe(false)
      expect(report.missing.some((m) => m.toLowerCase().includes('app surface') || m.toLowerCase().includes('dev server'))).toBe(true)
    })

    it('no-boot-plan missing entry is distinct from playwright-missing entry', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Playwright present but no scripts → only boot-plan is missing
      writePackageJson(root, { playwright: true, scripts: {} })
      writePlaywrightConfig(root)
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      // The playwright-related missing entries should NOT be in the list
      expect(report.missing.some((m) => m.includes('@playwright/test'))).toBe(false)
      // The boot-plan missing entry SHOULD be in the list
      expect(report.missing.some((m) => m.toLowerCase().includes('app surface') || m.toLowerCase().includes('dev server'))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 5: Monorepo — app lives in a subdirectory
  // ---------------------------------------------------------------------------

  describe('monorepo with app in subdirectory', () => {
    it('detects a dev server in the ui/ subdir and returns a boot plan', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Root package.json with playwright but no scripts
      writePackageJson(root, { playwright: true, scripts: {} })
      writePlaywrightConfig(root)
      createBrowsersDir(browsersDir)

      // ui/ subdir has a dev script
      const uiDir = join(root, 'ui')
      mkdirSync(uiDir)
      writePackageJson(uiDir, { scripts: { dev: 'vite' } })

      const report = probeWithBrowserPath(root, browsersDir)

      // discoverAppBoot should find ui/package.json dev script
      expect(report.available).toBe(true)
      expect(report.missing).toHaveLength(0)
    })

    it('finds playwright in a workspace package (packages/* pattern)', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Root has workspaces but no playwright
      writePackageJson(root, { playwright: false, workspaces: ['packages/*'], scripts: { dev: 'vite' } })
      writePlaywrightConfig(root)
      createBrowsersDir(browsersDir)

      // A workspace package has playwright
      const pkgsDir = join(root, 'packages', 'e2e')
      mkdirSync(pkgsDir, { recursive: true })
      writePackageJson(pkgsDir, { playwright: true })

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.runner).toBe('playwright')
      expect(report.missing.some((m) => m.includes('@playwright/test'))).toBe(false)
    })
  })
})
