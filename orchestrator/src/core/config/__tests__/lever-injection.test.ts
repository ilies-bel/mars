/**
 * Tests for the lever-injection contract: operator control levers are DATA
 * that consumers receive as a parameter, not a `process.env` global the
 * daemon projects at boot.
 *
 * Three things are asserted here:
 *
 *   1. `resolveControlLevers()` composes daemon.json with the documented
 *      `MARS_*_DISABLED` env escape hatches — the one place either source is
 *      read.
 *   2. Consumers decide from the levers they were HANDED. `isRecoveryDisabled`
 *      / `isScoringDisabled` return the injected verdict even when
 *      `process.env` says the opposite, which is what makes a lever change a
 *      visible data flow instead of an ambient mutation.
 *   3. The repo-wide invariant that keeps (2) true: no source file outside
 *      `src/core/config/` reads a lever name out of `process.env`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC_DIR = dirname(dirname(CONFIG_DIR))

let repo: string

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-lever-injection-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo
  delete process.env.MARS_RECOVERY_DISABLED
  delete process.env.MARS_SCORING_DISABLED
})

afterEach(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_RECOVERY_DISABLED
  delete process.env.MARS_SCORING_DISABLED
  rmSync(repo, { recursive: true, force: true })
})

describe('resolveControlLevers', () => {
  it('returns the built-in defaults when daemon.json has no controlLevers block', async () => {
    const { resolveControlLevers } = await import('../levers')

    expect(resolveControlLevers({})).toMatchObject({ recovery: 'on', scoring: 'on' })
  })

  it('reads the persisted lever out of daemon.json with no env involved', async () => {
    const { writeControlLever } = await import('../../daemon/config')
    const { resolveControlLevers } = await import('../levers')

    writeControlLever('recovery', 'off')

    expect(resolveControlLevers({}).recovery).toBe('off')
  })

  it('lets a MARS_*_DISABLED=1 env override force a persisted "on" lever off', async () => {
    const { writeControlLever } = await import('../../daemon/config')
    const { resolveControlLevers } = await import('../levers')

    writeControlLever('recovery', 'on')
    writeControlLever('scoring', 'on')

    const levers = resolveControlLevers({
      MARS_RECOVERY_DISABLED: '1',
      MARS_SCORING_DISABLED: '1',
    })

    expect(levers).toMatchObject({ recovery: 'off', scoring: 'off' })
  })

  it('ignores a MARS_*_DISABLED value that is not exactly "1"', async () => {
    const { resolveControlLevers } = await import('../levers')

    expect(
      resolveControlLevers({ MARS_RECOVERY_DISABLED: 'true', MARS_SCORING_DISABLED: '0' }),
    ).toMatchObject({ recovery: 'on', scoring: 'on' })
  })
})

describe('consumers decide from the levers they are handed', () => {
  it('isRecoveryDisabled follows the injected value, not process.env', async () => {
    const { isRecoveryDisabled } = await import('../levers')

    // process.env says "disabled"; the injected config says otherwise and wins.
    process.env.MARS_RECOVERY_DISABLED = '1'

    expect(
      isRecoveryDisabled({
        recovery: 'on',
        scoring: 'on',
        memoryCapture: 'on',
        autoRunReflect: 'off',
        operatorAutoCommit: 'on',
      }),
    ).toBe(false)
    expect(
      isRecoveryDisabled({
        recovery: 'off',
        scoring: 'on',
        memoryCapture: 'on',
        autoRunReflect: 'off',
        operatorAutoCommit: 'on',
      }),
    ).toBe(true)
  })

  it('isScoringDisabled follows the injected value, not process.env', async () => {
    const { isScoringDisabled } = await import('../../lib/scorer-runtime')

    process.env.MARS_SCORING_DISABLED = '1'

    expect(
      isScoringDisabled({
        recovery: 'on',
        scoring: 'on',
        memoryCapture: 'on',
        autoRunReflect: 'off',
        operatorAutoCommit: 'on',
      }),
    ).toBe(false)
    expect(
      isScoringDisabled({
        recovery: 'on',
        scoring: 'off',
        memoryCapture: 'on',
        autoRunReflect: 'off',
        operatorAutoCommit: 'on',
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The invariant: lever env reads live in src/core/config/ and nowhere else.
// ---------------------------------------------------------------------------

const LEVER_ENV_READ =
  /process\.env(?:\.(?:MARS_RECOVERY_DISABLED|MARS_SCORING_DISABLED)\b|\[\s*['"](?:MARS_RECOVERY_DISABLED|MARS_SCORING_DISABLED)['"]\s*\])/

const sourceFiles = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      sourceFiles(full, acc)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

describe('lever env reads are confined to src/core/config/', () => {
  it('no source file outside src/core/config/ reads a lever name from process.env', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => !file.startsWith(`${CONFIG_DIR}/`))
      .filter((file) => LEVER_ENV_READ.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file))

    expect(offenders).toEqual([])
  })
})
