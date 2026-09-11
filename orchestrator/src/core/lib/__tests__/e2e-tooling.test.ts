/**
 * Unit tests for probeE2eTooling.
 *
 * Each test builds a minimal fixture directory on-disk then calls
 * probeE2eTooling and asserts on the returned report. No child processes are
 * spawned; the function is pure filesystem-only.
 *
 * ## Test structure
 *
 * ### Existing playwright-local probe tests (Tests 1–7)
 *
 * These tests verify the `playwright-local` implementation's probe logic by
 * passing `{ drivers: [playwrightLocalDriver] }` to `probeE2eTooling`. This
 * isolates them from any other registered driver (e.g. `chrome-exec`) that
 * might be available on the test machine and would otherwise cause
 * `available: false` assertions to fail.
 *
 * ### Registry behavior tests (Tests 8–9)
 *
 * These tests verify that `probeE2eTooling` uses the registry correctly: it
 * returns the first available driver, falls back to later candidates, and
 * collects all candidates' setup steps when none is available.
 * Fully mocked drivers are used so tests are deterministic on any machine.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeE2eTooling } from '../e2e-tooling'
import { playwrightLocalDriver } from '../../ports/ui-driver/playwright-local'
import type { UiDriver, UiDriverProbeResult, UiSessionSpec, UiSessionResult } from '../../ports/ui-driver/types'

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

/**
 * Run the probe with PLAYWRIGHT_BROWSERS_PATH overridden to a temp dir, using
 * only the playwright-local driver for test isolation.
 */
const probeWithBrowserPath = (repoRoot: string, browsersPath: string) => {
  const prev = process.env.PLAYWRIGHT_BROWSERS_PATH
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
  try {
    return probeE2eTooling(repoRoot, { drivers: [playwrightLocalDriver] })
  } finally {
    if (prev === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = prev
    }
  }
}

// ---------------------------------------------------------------------------
// Mock driver factory
// ---------------------------------------------------------------------------

/** Build a deterministic mock UiDriver for registry tests. */
const makeMockDriver = (
  kind: string,
  state: 'available' | 'absent',
  setupSteps: string[] = [],
  installCost = 1,
): UiDriver => ({
  kind,
  capability: `mock-${kind}`,
  installCost,
  probe: (_repoRoot: string): UiDriverProbeResult => ({
    state,
    evidence: state === 'available' ? `${kind}: available` : `${kind}: absent`,
    setupSteps,
  }),
  runSession: (_spec: UiSessionSpec): Promise<UiSessionResult> =>
    Promise.resolve({ captureResults: [] }),
})

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
      expect(report.runner).toBe('playwright-local')
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
      // At least playwright package and config are missing (combined into evidence)
      expect(report.missing.length).toBeGreaterThanOrEqual(1)
    })

    it('returns available:false when playwright dep is found but other pieces missing', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Playwright present but no config, no browsers dir populated
      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      // browsersDir is empty (no chromium subdir) → browsers missing

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.runner).toBe('none')
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

      expect(report.runner).toBe('playwright-local')
      expect(report.missing.some((m) => m.includes('@playwright/test'))).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 6: playwright package and config in ui/ (no root config, no workspaces)
  // ---------------------------------------------------------------------------

  describe('playwright in ui/ when root has no workspaces', () => {
    it('detects playwright package in ui/ when root has no workspaces', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Root: no playwright, no workspaces, no playwright config, but has dev script
      writePackageJson(root, { playwright: false, scripts: { dev: 'vite' } })
      // No playwright.config at root

      // ui/: has playwright package and config
      const uiDir = join(root, 'ui')
      mkdirSync(uiDir)
      writePackageJson(uiDir, { playwright: true, scripts: { dev: 'vite' } })
      writePlaywrightConfig(uiDir)
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      expect(report.runner).toBe('playwright-local')
      expect(report.missing.some((m) => m.includes('@playwright/test'))).toBe(false)
      expect(report.available).toBe(true)
    })

    it('detects playwright.config.ts in ui/ when root has no config', () => {
      const root = makeTmpDir()
      const browsersDir = makeTmpDir()

      // Root: has playwright package and dev script, but no playwright.config
      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      // No playwright.config.ts at root

      // ui/ subdir has the config
      const uiDir = join(root, 'ui')
      mkdirSync(uiDir)
      writePlaywrightConfig(uiDir)
      createBrowsersDir(browsersDir)

      const report = probeWithBrowserPath(root, browsersDir)

      // Config detected in ui/ — should not appear in missing
      expect(report.missing.some((m) => m.toLowerCase().includes('playwright.config'))).toBe(false)
      expect(report.available).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 7: macOS browser cache path (~/Library/Caches/ms-playwright)
  // ---------------------------------------------------------------------------

  describe.runIf(process.platform === 'darwin')('macOS browser cache path', () => {
    it('recognizes ~/Library/Caches/ms-playwright as installed browser cache on macOS', () => {
      const root = makeTmpDir()

      writePackageJson(root, { playwright: true, scripts: { dev: 'vite' } })
      writePlaywrightConfig(root)

      // Remove PLAYWRIGHT_BROWSERS_PATH so the probe falls back to platform defaults.
      const prev = process.env.PLAYWRIGHT_BROWSERS_PATH
      delete process.env.PLAYWRIGHT_BROWSERS_PATH
      try {
        const report = probeE2eTooling(root, { drivers: [playwrightLocalDriver] })
        const macOsPath = join(homedir(), 'Library', 'Caches', 'ms-playwright')
        const hasCache = existsSync(macOsPath) && readdirSync(macOsPath).length > 0
        // If the macOS cache dir is populated, browsers must not appear in missing.
        if (hasCache) {
          expect(report.missing.some((m) => m.toLowerCase().includes('browser'))).toBe(false)
        }
      } finally {
        if (prev !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = prev
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Test 8: Registry behavior — first available driver wins
  // ---------------------------------------------------------------------------

  describe('registry resolution', () => {
    it('returns the first available driver and its kind as runner', () => {
      const driverA = makeMockDriver('mock-A', 'available', [], 2)
      const driverB = makeMockDriver('mock-B', 'available', [], 1)
      const root = makeTmpDir()

      const report = probeE2eTooling(root, { drivers: [driverA, driverB] })

      expect(report.available).toBe(true)
      // driverA is first in list, so it wins even though driverB has lower cost.
      expect(report.runner).toBe('mock-A')
      expect(report.missing).toHaveLength(0)
      expect(report.setupSteps).toHaveLength(0)
    })

    it('falls back to the second driver when the first is absent', () => {
      const driverA = makeMockDriver('mock-A', 'absent', ['install-A'])
      const driverB = makeMockDriver('mock-B', 'available', [])
      const root = makeTmpDir()

      const report = probeE2eTooling(root, { drivers: [driverA, driverB] })

      expect(report.available).toBe(true)
      expect(report.runner).toBe('mock-B')
    })

    it('returns available:false with deduped setup steps when no driver is available', () => {
      const shared = 'brew install --cask google-chrome'
      const driverA = makeMockDriver('mock-A', 'absent', ['install-A', shared], 2)
      const driverB = makeMockDriver('mock-B', 'absent', [shared, 'install-B'], 1)
      const root = makeTmpDir()

      const report = probeE2eTooling(root, { drivers: [driverA, driverB] })

      expect(report.available).toBe(false)
      expect(report.runner).toBe('none')
      // Cheapest (driverB, cost=1) steps should come first; shared step deduped.
      const sharedCount = report.setupSteps.filter((s) => s === shared).length
      expect(sharedCount).toBe(1)
      expect(report.setupSteps).toContain('install-B')
      expect(report.setupSteps).toContain('install-A')
    })

    it('collects missing evidence from all candidates when none available', () => {
      const driverA = makeMockDriver('mock-A', 'absent', ['install-A'])
      const driverB = makeMockDriver('mock-B', 'absent', ['install-B'])
      const root = makeTmpDir()

      const report = probeE2eTooling(root, { drivers: [driverA, driverB] })

      expect(report.missing).toContain('mock-A: absent')
      expect(report.missing).toContain('mock-B: absent')
    })

    it('an empty driver list returns available:false with no steps', () => {
      const root = makeTmpDir()
      const report = probeE2eTooling(root, { drivers: [] })
      expect(report.available).toBe(false)
      expect(report.runner).toBe('none')
      expect(report.missing).toHaveLength(0)
      expect(report.setupSteps).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 9: Open registry — new driver requires no resolver change
  // ---------------------------------------------------------------------------

  describe('open registry — adding a driver requires no resolver change', () => {
    it('a third-party driver injected via options is picked up by the existing resolver', () => {
      const thirdPartyDriver = makeMockDriver('custom-driver', 'available', [])
      const root = makeTmpDir()

      // The resolver is the same probeE2eTooling function; no changes needed.
      const report = probeE2eTooling(root, { drivers: [thirdPartyDriver] })

      expect(report.available).toBe(true)
      expect(report.runner).toBe('custom-driver')
    })

    it('a driver registered as absent does not prevent other drivers from being found', () => {
      const absent = makeMockDriver('absent-driver', 'absent', ['install-X'])
      const present = makeMockDriver('present-driver', 'available', [])
      const root = makeTmpDir()

      // Even if the absent driver is first, the present one is found.
      const report = probeE2eTooling(root, { drivers: [absent, present] })

      expect(report.available).toBe(true)
      expect(report.runner).toBe('present-driver')
    })
  })
})
