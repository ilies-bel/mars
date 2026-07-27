/**
 * Unit tests for discoverAppBoot — pure filesystem-probing function.
 *
 * Each test scenario creates a minimal fixture directory in a tmp dir and
 * checks the returned BootPlan (or null). No network, no child processes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverAppBoot, type BootPlan } from '../app-boot-discovery'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureRoot: string

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'mars-boot-disc-'))
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

const writeJson = (dir: string, name: string, content: unknown): void => {
  writeFileSync(join(dir, name), JSON.stringify(content, null, 2))
}

const touch = (dir: string, name: string): void => {
  writeFileSync(join(dir, name), '')
}

// ---------------------------------------------------------------------------
// Vite react app fixture
// ---------------------------------------------------------------------------

describe('discoverAppBoot — Vite app', () => {
  it('returns cmd=npm run dev, url=http://localhost:5173 when vite.config.ts is present', () => {
    touch(fixtureRoot, 'vite.config.ts')
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'vite' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.cmd).toBe('npm run dev')
    expect(plan!.url).toBe('http://localhost:5173')
    expect(plan!.cwd).toBe(fixtureRoot)
    expect(plan!.reason).toContain('vite')
  })

  it('detects vite.config.js as well', () => {
    touch(fixtureRoot, 'vite.config.js')
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'vite' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.url).toBe('http://localhost:5173')
  })

  it('detects a Vite project inside a ui/ subdirectory', () => {
    const uiDir = join(fixtureRoot, 'ui')
    mkdirSync(uiDir)
    touch(uiDir, 'vite.config.ts')
    writeJson(uiDir, 'package.json', { scripts: { dev: 'vite' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.cmd).toBe('npm run dev')
    expect(plan!.cwd).toBe(uiDir)
    expect(plan!.url).toBe('http://localhost:5173')
    expect(plan!.reason).toContain('vite')
  })
})

// ---------------------------------------------------------------------------
// Next.js app fixture
// ---------------------------------------------------------------------------

describe('discoverAppBoot — Next.js app', () => {
  it('returns cmd=npm run dev, url=http://localhost:3000 when next.config.js is present', () => {
    touch(fixtureRoot, 'next.config.js')
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'next dev' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.cmd).toBe('npm run dev')
    expect(plan!.url).toBe('http://localhost:3000')
    expect(plan!.cwd).toBe(fixtureRoot)
    expect(plan!.reason).toContain('next')
  })

  it('detects next.config.mjs', () => {
    touch(fixtureRoot, 'next.config.mjs')
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'next dev' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.url).toBe('http://localhost:3000')
  })

  it('detects next.config.ts', () => {
    touch(fixtureRoot, 'next.config.ts')
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'next dev' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.url).toBe('http://localhost:3000')
  })
})

// ---------------------------------------------------------------------------
// Generic package.json scripts (no framework config)
// ---------------------------------------------------------------------------

describe('discoverAppBoot — generic package.json scripts', () => {
  it('returns npm run dev when package.json has a "dev" script but no framework config', () => {
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'node server.js' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.cmd).toBe('npm run dev')
    expect(plan!.url).toBe('http://localhost:3000')
    expect(plan!.reason).toContain('"dev"')
  })

  it('falls back to "npm start" when only a "start" script exists', () => {
    writeJson(fixtureRoot, 'package.json', { scripts: { start: 'node server.js' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.cmd).toBe('npm start')
    expect(plan!.url).toBe('http://localhost:3000')
    expect(plan!.reason).toContain('"start"')
  })

  it('"dev" script takes priority over "start" script', () => {
    writeJson(fixtureRoot, 'package.json', {
      scripts: { dev: 'vite', start: 'node server.js' },
    })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).not.toBeNull()
    expect(plan!.cmd).toBe('npm run dev')
  })
})

// ---------------------------------------------------------------------------
// No-UI repo fixture
// ---------------------------------------------------------------------------

describe('discoverAppBoot — no-UI repo', () => {
  it('returns null for a pure backend repo with only a test script', () => {
    writeJson(fixtureRoot, 'package.json', { scripts: { test: 'vitest run' } })

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).toBeNull()
  })

  it('returns null when there is no package.json and no framework config', () => {
    const plan = discoverAppBoot(fixtureRoot)
    expect(plan).toBeNull()
  })

  it('returns null when package.json has malformed JSON', () => {
    writeFileSync(join(fixtureRoot, 'package.json'), '{not valid json')

    const plan = discoverAppBoot(fixtureRoot)

    expect(plan).toBeNull()
  })

  it('does not error on a missing repoRoot path', () => {
    const plan = discoverAppBoot(join(fixtureRoot, 'does-not-exist'))
    expect(plan).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// BootPlan contract
// ---------------------------------------------------------------------------

describe('discoverAppBoot — BootPlan shape', () => {
  it('every non-null result carries cmd, cwd, url, and reason', () => {
    touch(fixtureRoot, 'vite.config.ts')
    writeJson(fixtureRoot, 'package.json', { scripts: { dev: 'vite' } })

    const plan = discoverAppBoot(fixtureRoot) as BootPlan

    expect(typeof plan.cmd).toBe('string')
    expect(plan.cmd.length).toBeGreaterThan(0)
    expect(typeof plan.cwd).toBe('string')
    expect(plan.cwd.length).toBeGreaterThan(0)
    expect(typeof plan.url).toBe('string')
    expect(plan.url).toMatch(/^http/)
    expect(typeof plan.reason).toBe('string')
    expect(plan.reason.length).toBeGreaterThan(0)
  })
})
