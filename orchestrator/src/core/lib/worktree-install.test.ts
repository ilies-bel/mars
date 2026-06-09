import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWorkspaceDepsForSite, type InstallSite, type InstallRunner } from './worktree-install'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunnerCall = { cmd: string; args: readonly string[]; cwd: string }

/** Build a mock runner from a list of sequential results. */
const makeRunner = (
  results: Array<{ exitCode: number; stdout: string; stderr: string }>,
): { runner: InstallRunner; calls: RunnerCall[] } => {
  const calls: RunnerCall[] = []
  let i = 0
  const runner: InstallRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd })
    const result = results[i] ?? results[results.length - 1]
    i++
    return result
  }
  return { runner, calls }
}

const ok = { exitCode: 0, stdout: '', stderr: '' }
const exit254 = { exitCode: 254, stdout: '', stderr: '' }

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-winstall-test-'))
})

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

/**
 * Set up a minimal worktree with one pnpm install site that has a single
 * `file:`-linked workspace dependency with a `build` script.
 *
 * Returns:
 *   worktreeRoot  — the root of the simulated worktree
 *   siteDir       — the directory containing the consuming package.json
 *   depDir        — the directory of the workspace dependency
 *   site          — InstallSite for siteDir
 */
const setupFixture = async (
  opts: {
    /** Whether to create a pnpm-lock.yaml inside depDir (default true). */
    depHasLockfile?: boolean
    /** Whether to create node_modules/.bin/<buildTool> inside depDir (default true). */
    createBinFile?: boolean
    /** The build script to use for the dep (default 'tsup src/index.ts'). */
    buildScript?: string
  } = {},
): Promise<{ worktreeRoot: string; siteDir: string; depDir: string; site: InstallSite }> => {
  const { depHasLockfile = true, createBinFile = true, buildScript = 'tsup src/index.ts' } = opts

  const worktreeRoot = resolve(tmpDir, 'worktree')
  const siteDir = resolve(worktreeRoot, 'orchestrator')
  const depDir = resolve(worktreeRoot, 'packages', 'workflow')

  await mkdir(siteDir, { recursive: true })
  await mkdir(depDir, { recursive: true })

  // Site package.json with a file: dep pointing at depDir
  await writeFile(
    resolve(siteDir, 'package.json'),
    JSON.stringify({
      dependencies: { '@mars/workflow': `file:${depDir}` },
    }),
  )

  // Dep package.json with a build script
  await writeFile(
    resolve(depDir, 'package.json'),
    JSON.stringify({ scripts: { build: buildScript } }),
  )

  if (depHasLockfile) {
    await writeFile(resolve(depDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
  }

  if (createBinFile) {
    const binDir = resolve(depDir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    // Extract the binary name from the build script (first token)
    const binName = buildScript.trim().split(/\s+/)[0]
    await writeFile(resolve(binDir, binName), '#!/usr/bin/env node\n')
  }

  const site: InstallSite = { dir: siteDir, manager: 'pnpm', lockfile: 'pnpm-lock.yaml' }
  return { worktreeRoot, siteDir, depDir, site }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildWorkspaceDepsForSite — transient exit 254 retry', () => {
  it('retries once when install exits 254 with empty stderr and succeeds on second attempt', async () => {
    const { worktreeRoot, site } = await setupFixture()

    // install(254) → install(0) → build(0)
    const { runner, calls } = makeRunner([exit254, ok, ok])

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).resolves.toBeUndefined()

    const installCalls = calls.filter((c) => c.args[0] === 'install')
    expect(installCalls).toHaveLength(2) // initial + 1 retry
    const buildCalls = calls.filter((c) => c.args[0] === 'run')
    expect(buildCalls).toHaveLength(1)
  })

  it('does NOT retry when install exits 254 but stderr is non-empty (not a transient race)', async () => {
    const { worktreeRoot, site } = await setupFixture()

    const nonTransient = { exitCode: 254, stdout: '', stderr: 'ERR_PNPM_SOMETHING_REAL' }
    const { runner, calls } = makeRunner([nonTransient, ok, ok])

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).rejects.toThrow(/workspace dep install failed/)

    // Only one install call — no retry attempted for non-empty stderr
    const installCalls = calls.filter((c) => c.args[0] === 'install')
    expect(installCalls).toHaveLength(1)
  })

  it('surfaces failure when all install attempts return exit 254 (no infinite retry)', async () => {
    const { worktreeRoot, site } = await setupFixture()

    // All calls return 254 — initial + WORKSPACE_DEP_INSTALL_MAX_RETRIES (2) retries
    const { runner, calls } = makeRunner([exit254, exit254, exit254, exit254])

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).rejects.toThrow(/workspace dep install failed/)

    // Should have tried exactly 1 + 2 = 3 install calls and then stopped
    const installCalls = calls.filter((c) => c.args[0] === 'install')
    expect(installCalls).toHaveLength(3) // 1 initial + 2 retries

    // No build call should have been made
    const buildCalls = calls.filter((c) => c.args[0] === 'run')
    expect(buildCalls).toHaveLength(0)
  })
})

describe('buildWorkspaceDepsForSite — bin-existence check', () => {
  it('re-installs once when install exits 0 but the build-tool binary is missing', async () => {
    // Binary NOT created: simulates silent pnpm failure where exit=0 but .bin is empty
    const { worktreeRoot, site, depDir } = await setupFixture({ createBinFile: false })

    let installCount = 0
    const runner: InstallRunner = async (cmd, args, cwd) => {
      if (args[0] === 'install') {
        installCount++
        // On the second install (re-install), create the binary so subsequent
        // code can proceed (simulates pnpm actually completing the bin linking).
        if (installCount === 2) {
          const binDir = resolve(depDir, 'node_modules', '.bin')
          await mkdir(binDir, { recursive: true })
          await writeFile(resolve(binDir, 'tsup'), '#!/usr/bin/env node\n')
        }
        return ok
      }
      // build call
      return ok
    }

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).resolves.toBeUndefined()

    // Should have installed twice: initial + re-install triggered by missing bin
    expect(installCount).toBe(2)
  })

  it('does not re-install when install exits 0 and build-tool binary is present', async () => {
    const { worktreeRoot, site } = await setupFixture({ createBinFile: true })

    const { runner, calls } = makeRunner([ok, ok]) // install, build

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).resolves.toBeUndefined()

    const installCalls = calls.filter((c) => c.args[0] === 'install')
    expect(installCalls).toHaveLength(1) // no re-install needed
  })

  it('throws when the re-install (after missing bin) also fails', async () => {
    const { worktreeRoot, site } = await setupFixture({ createBinFile: false })

    // install(0) → re-install due to missing bin → re-install fails(1)
    const { runner } = makeRunner([ok, { exitCode: 1, stdout: '', stderr: 'install error' }])

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).rejects.toThrow(/workspace dep re-install failed/)
  })

  it('skips bin check when build script starts with a path (not a bare binary name)', async () => {
    // Build script like './scripts/build.sh' should not trigger a .bin check
    const { worktreeRoot, site } = await setupFixture({
      buildScript: './scripts/build.sh',
      createBinFile: false, // no bin to find — but no check should happen either
    })

    const { runner, calls } = makeRunner([ok, ok]) // install, build

    await expect(
      buildWorkspaceDepsForSite(site, worktreeRoot, runner, undefined, 60_000),
    ).resolves.toBeUndefined()

    // Only one install (no re-install triggered)
    const installCalls = calls.filter((c) => c.args[0] === 'install')
    expect(installCalls).toHaveLength(1)
  })
})

describe('buildWorkspaceDepsForSite — failure logging', () => {
  it('includes pnpm-debug.log path in the error message on install failure', async () => {
    const { worktreeRoot, site, depDir } = await setupFixture()
    const { runner } = makeRunner([{ exitCode: 1, stdout: '', stderr: 'hard fail' }])

    const err = await buildWorkspaceDepsForSite(
      site,
      worktreeRoot,
      runner,
      undefined,
      60_000,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('pnpm-debug.log')
    expect(msg).toContain(depDir)
  })
})
