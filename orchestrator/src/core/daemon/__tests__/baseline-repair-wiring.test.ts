import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createRealBaselineRepairer } from '../baseline-repair-wiring'
import { createPauseController } from '../pause-state'

/**
 * The gap this module exists to close: `createBaselineRepairer` was fully
 * unit-tested against injected fakes, but nothing ever constructed it with
 * REAL git/fs/npm/pause dependencies, so a defect in the wiring itself was
 * invisible to the suite. These tests construct the production repairer and
 * drive `.repair()` against a real temp checkout and the real `npm` binary.
 *
 * Only the `clean` outcome is exercised here: every other outcome calls the
 * real `raise` dep, which writes to the action queue (Postgres), and every
 * repair path beyond the probe dispatches a real Fixer Worker. Those belong
 * to `baseline-repair.test.ts`'s injected-dependency suite, which covers the
 * refusal vocabulary exhaustively. What is verified here — and nowhere else —
 * is that the real dependency set is assembled correctly and that the real
 * install probe reaches the real package manager.
 *
 * Offline: `npm ci --dry-run` validates manifest/lockfile agreement before it
 * ever reaches the registry.
 */
describe('createRealBaselineRepairer', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mars-repair-wiring-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeHealthyBaseline = (): void => {
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify({ name: 'wiring-fixture', version: '1.0.0', private: true, dependencies: {} }),
    )
    writeFileSync(
      resolve(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'wiring-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'wiring-fixture', version: '1.0.0' } },
      }),
    )
  }

  it('reports a healthy baseline as clean through the real install probe', async () => {
    writeHealthyBaseline()
    const repairer = createRealBaselineRepairer({
      repoRoot: dir,
      integrationBranch: 'main',
      pause: createPauseController(),
    })

    await expect(repairer.repair()).resolves.toEqual({ status: 'clean' })
  })

  it('leaves an unrelated pause untouched when there is nothing to repair', async () => {
    writeHealthyBaseline()
    // A repair must never resume a pause it did not cause. The clean path
    // resumes nothing at all, so an operator pause survives it intact.
    const pause = createPauseController()
    pause.pause('operator', 'held by hand')
    const repairer = createRealBaselineRepairer({
      repoRoot: dir,
      integrationBranch: 'main',
      pause,
    })

    await expect(repairer.repair()).resolves.toEqual({ status: 'clean' })
    expect(pause.get()).toMatchObject({ paused: true, reason: 'operator' })
  })
}, 120_000)
