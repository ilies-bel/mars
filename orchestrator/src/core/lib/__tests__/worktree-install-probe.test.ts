import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { probeFrozenInstall } from '../worktree-install'

/**
 * `probeFrozenInstall` is the shared non-mutating install probe behind both
 * the daemon's baseline-health checker and the baseline repairer, so these
 * run against the REAL `npm` binary rather than a stub: the whole point of
 * the probe is that the package manager itself reports a broken baseline
 * without touching `node_modules`, and a stubbed executor cannot show that.
 *
 * Every case here is offline — `npm ci` validates manifest/lockfile
 * agreement before it reaches the registry.
 */
describe('probeFrozenInstall', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mars-frozen-probe-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeManifest = (deps: Record<string, string> = {}): void => {
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify({ name: 'probe-fixture', version: '1.0.0', private: true, dependencies: deps }),
    )
    writeFileSync(
      resolve(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'probe-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'probe-fixture', version: '1.0.0' } },
      }),
    )
  }

  it('reports success without probing when there is no manifest to install', async () => {
    const result = await probeFrozenInstall(dir)

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('passes on a healthy tree and leaves node_modules uncreated', async () => {
    writeManifest()

    const result = await probeFrozenInstall(dir)

    expect(result.exitCode).toBe(0)
    expect(existsSync(resolve(dir, 'node_modules'))).toBe(false)
  })

  it('fails on a defective baseline and still leaves node_modules uncreated', async () => {
    // A dependency the lockfile does not account for — the same shape of
    // manifest/lockfile defect the baseline repairer exists to fix.
    writeManifest({ 'left-pad': '^1.3.0' })

    const result = await probeFrozenInstall(dir)

    expect(result.exitCode).not.toBe(0)
    expect(existsSync(resolve(dir, 'node_modules'))).toBe(false)
  })
}, 120_000)
