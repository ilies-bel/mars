import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  detectInstallSites,
  installCommand,
  regenInstallCommand,
  installWorktreeDeps,
  repairInstallInPlace,
  buildWorkspaceDepsForSite,
  waitForFile,
  WorktreeInstallError,
  DEFAULT_INSTALL_TIMEOUT_MS,
} from '../worktree-install'
import type { InstallSite } from '../worktree-install'
import type { RunSubprocessResult } from '../git/claude'

interface RecordedCall {
  cmd: string
  args: readonly string[]
  cwd: string
}

const ok = (): RunSubprocessResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
})

const fail = (stderr: string): RunSubprocessResult => ({
  exitCode: 1,
  stdout: '',
  stderr,
})

describe('worktree-install', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(resolve(tmpdir(), 'mars-worktree-install-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  describe('installCommand', () => {
    it('maps each manager to its frozen install command', () => {
      expect(installCommand('pnpm')).toEqual(['pnpm', ['install', '--frozen-lockfile']])
      expect(installCommand('npm')).toEqual(['npm', ['ci']])
      expect(installCommand('yarn')).toEqual(['yarn', ['install', '--frozen-lockfile']])
      expect(installCommand('bun')).toEqual(['bun', ['install', '--frozen-lockfile']])
    })
  })

  describe('detectInstallSites', () => {
    it('finds pnpm-lock.yaml at the worktree root', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n')
      const sites = await detectInstallSites(workDir)
      expect(sites).toHaveLength(1)
      expect(sites[0].manager).toBe('pnpm')
      expect(sites[0].lockfile).toBe('pnpm-lock.yaml')
      expect(sites[0].dir).toBe(workDir)
    })

    it('finds multiple lockfiles in independent subtrees', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'package-lock.json'), '{}')
      mkdirSync(resolve(workDir, 'ui'))
      writeFileSync(resolve(workDir, 'ui', 'package-lock.json'), '{}')

      const sites = await detectInstallSites(workDir)
      const managers = sites.map((s) => `${s.manager}:${s.dir.split('/').pop()}`).sort()
      expect(managers).toEqual([
        `npm:${'orchestrator'}`,
        `npm:${'ui'}`,
        `pnpm:${workDir.split('/').pop()}`,
      ])
    })

    it('returns empty for a worktree with no lockfiles (non-JS project)', async () => {
      writeFileSync(resolve(workDir, 'README.md'), '# rust project\n')
      const sites = await detectInstallSites(workDir)
      expect(sites).toEqual([])
    })

    it('skips node_modules and other build/output dirs', async () => {
      mkdirSync(resolve(workDir, 'node_modules', 'foo'), { recursive: true })
      writeFileSync(
        resolve(workDir, 'node_modules', 'foo', 'package-lock.json'),
        '{}',
      )
      mkdirSync(resolve(workDir, 'dist'))
      writeFileSync(resolve(workDir, 'dist', 'pnpm-lock.yaml'), '')
      const sites = await detectInstallSites(workDir)
      expect(sites).toEqual([])
    })

    it('prefers pnpm over npm when both lockfiles coexist in a directory', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      const sites = await detectInstallSites(workDir)
      expect(sites).toHaveLength(1)
      expect(sites[0].manager).toBe('pnpm')
    })
  })

  describe('installWorktreeDeps', () => {
    it('skips install when no lockfiles are present (non-JS project)', async () => {
      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }
      const summary = await installWorktreeDeps({ worktreeRoot: workDir, runner })
      expect(calls).toEqual([])
      expect(summary.sites).toEqual([])
    })

    it('runs install in each lockfile-bearing directory in parallel', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'package-lock.json'), '{}')
      mkdirSync(resolve(workDir, 'ui'))
      writeFileSync(resolve(workDir, 'ui', 'package-lock.json'), '{}')

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }

      const summary = await installWorktreeDeps({ worktreeRoot: workDir, runner })
      expect(calls).toHaveLength(3)
      expect(summary.sites).toHaveLength(3)

      const pnpmCall = calls.find((c) => c.cmd === 'pnpm')
      expect(pnpmCall?.args).toEqual(['install', '--frozen-lockfile'])
      expect(pnpmCall?.cwd).toBe(workDir)

      const npmCalls = calls.filter((c) => c.cmd === 'npm')
      expect(npmCalls).toHaveLength(2)
      expect(npmCalls.every((c) => c.args[0] === 'ci')).toBe(true)
      const cwds = npmCalls.map((c) => c.cwd).sort()
      expect(cwds).toEqual([
        resolve(workDir, 'orchestrator'),
        resolve(workDir, 'ui'),
      ])
    })

    it('throws WorktreeInstallError surfacing a setup:install failure when install exits non-zero', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      const runner = async () => fail('ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen lockfile\n')
      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).rejects.toBeInstanceOf(WorktreeInstallError)
    })

    it('attaches site metadata to the install error so the recipe context is rich', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      const runner = async () => fail('lockfile drift\n')
      try {
        await installWorktreeDeps({ worktreeRoot: workDir, runner })
        expect.fail('expected installWorktreeDeps to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(WorktreeInstallError)
        if (error instanceof WorktreeInstallError) {
          expect(error.site.dir).toBe(workDir)
          expect(error.site.manager).toBe('pnpm')
          expect(error.message).toContain('lockfile drift')
        }
      }
    })

    it('installs then builds a local file: workspace dep BEFORE installing the site (so dist is packed)', async () => {
      // Site = orchestrator with a pnpm lockfile and a file: dep on a sibling
      // workspace package that has a build script. The dep's own deps install
      // first (so its build tool is on PATH), then it builds, and only THEN
      // does the orchestrator site install — so pnpm packs the built dist.
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'orchestrator', 'package.json'),
        JSON.stringify({
          name: 'orch',
          dependencies: { '@mars/workflow': 'file:../packages/workflow' },
        }),
      )
      mkdirSync(resolve(workDir, 'packages', 'workflow'), { recursive: true })
      writeFileSync(resolve(workDir, 'packages', 'workflow', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'packages', 'workflow', 'package.json'),
        JSON.stringify({ name: '@mars/workflow', scripts: { build: 'tsup' } }),
      )

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }
      await installWorktreeDeps({ worktreeRoot: workDir, runner })

      const wfDir = resolve(workDir, 'packages', 'workflow')
      const depInstallIdx = calls.findIndex(
        (c) => c.cwd === wfDir && c.args[0] === 'install',
      )
      const depBuildIdx = calls.findIndex(
        (c) => c.cwd === wfDir && c.args[0] === 'run' && c.args[1] === 'build',
      )
      const orchInstallIdx = calls.findIndex(
        (c) => c.cwd === resolve(workDir, 'orchestrator') && c.args[0] === 'install',
      )
      expect(depInstallIdx).toBeGreaterThanOrEqual(0)
      expect(depBuildIdx).toBeGreaterThanOrEqual(0)
      expect(orchInstallIdx).toBeGreaterThanOrEqual(0)
      expect(depInstallIdx).toBeLessThan(depBuildIdx) // install dep deps before building
      expect(depBuildIdx).toBeLessThan(orchInstallIdx) // build dep before installing consumer
    })

    it('does not build deps that escape the worktree or lack a build script', async () => {
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'orchestrator', 'package.json'),
        JSON.stringify({
          name: 'orch',
          dependencies: {
            zod: '^4.0.0', // registry dep — ignored
            outside: 'file:../../elsewhere', // escapes the worktree — ignored
          },
        }),
      )
      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }
      await installWorktreeDeps({ worktreeRoot: workDir, runner })
      expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'build')).toBe(false)
      expect(calls).toHaveLength(1)
      expect(calls[0].args[0]).toBe('install')
    })

    it('skips link: workspace deps (symlinks consume live source — no dist to pre-build)', async () => {
      // The root package.json dogfoods the orchestrator with
      //   "mars": "link:./orchestrator"
      // pnpm creates node_modules/mars as a symlink to orchestrator/; nothing
      // gets packed. Running `pnpm run build` (=tsc --noEmit) in orchestrator
      // here also races with the orchestrator install site that's
      // concurrently building @mars/workflow and installing orchestrator's
      // own deps — the typecheck blew up because workflow's dist wasn't
      // packed yet. Skip link: entirely; the linked package's own install
      // site (if any) handles its install+build.
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'package.json'),
        JSON.stringify({
          name: 'root',
          dependencies: { mars: 'link:./orchestrator' },
        }),
      )
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'orchestrator', 'package.json'),
        JSON.stringify({
          name: 'mars',
          scripts: { build: 'tsc --noEmit' },
        }),
      )

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }
      await installWorktreeDeps({ worktreeRoot: workDir, runner })

      // No `pnpm run build` should run in the linked dir — neither from the
      // root site (link: skipped) nor from the orchestrator site (no
      // workspace deps of its own in this test).
      const buildCalls = calls.filter(
        (c) => c.args[0] === 'run' && c.args[1] === 'build',
      )
      expect(buildCalls).toEqual([])
      // And the linked dir is never re-installed by the root site — that
      // would race with the orchestrator site installing itself.
      const orchInstallsFromRoot = calls.filter(
        (c) =>
          c.cwd === resolve(workDir, 'orchestrator') &&
          c.args[0] === 'install' &&
          c.args.includes('--frozen-lockfile'),
      )
      // Exactly one frozen install in orchestrator — the orchestrator site's
      // own install. None spawned by the root site as a link:-dep prebuild.
      expect(orchInstallsFromRoot).toHaveLength(1)
    })

    it('throws when a workspace dep build fails (it would only fail typecheck later otherwise)', async () => {
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'orchestrator', 'package.json'),
        JSON.stringify({
          name: 'orch',
          dependencies: { '@mars/workflow': 'file:../packages/workflow' },
        }),
      )
      mkdirSync(resolve(workDir, 'packages', 'workflow'), { recursive: true })
      writeFileSync(resolve(workDir, 'packages', 'workflow', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'packages', 'workflow', 'package.json'),
        JSON.stringify({ name: '@mars/workflow', scripts: { build: 'tsup' } }),
      )
      // dep install succeeds; the build (pnpm run build) fails.
      const runner = async (cmd: string, args: readonly string[]) =>
        cmd === 'pnpm' && args[0] === 'run' ? fail('tsup exploded\n') : ok()
      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).rejects.toThrow(/workspace dep build failed/)
    })

    it('logs duration per site for visibility into the setup phase', async () => {
      writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), '')
      const lines: string[] = []
      const runner = async () => ok()
      await installWorktreeDeps({
        worktreeRoot: workDir,
        runner,
        log: (line) => lines.push(line),
      })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^\[setup:install\] pnpm \(\.\) exit=0 duration=/)
    })

    it('retries once when install fails with ENOTEMPTY and succeeds on retry', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      let callCount = 0
      const runner = async (): Promise<RunSubprocessResult> => {
        callCount++
        if (callCount === 1) {
          return fail(
            'npm warn cleanup ENOTEMPTY: directory not empty, rmdir .../node_modules/sucrase',
          )
        }
        return ok()
      }
      const summary = await installWorktreeDeps({ worktreeRoot: workDir, runner })
      expect(callCount).toBe(2)
      expect(summary.sites).toHaveLength(1)
      expect(summary.sites[0].exitCode).toBe(0)
    })

    it('throws WorktreeInstallError when every ENOTEMPTY retry also fails', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      let callCount = 0
      const runner = async (): Promise<RunSubprocessResult> => {
        callCount++
        return fail(
          'npm warn cleanup ENOTEMPTY: directory not empty, rmdir .../node_modules/sucrase',
        )
      }
      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).rejects.toBeInstanceOf(WorktreeInstallError)
      // Implementation retries up to 2 additional times after the first failure
      // (3 attempts total) before surfacing the install error.
      expect(callCount).toBe(3)
    })

    it('recovers when a transient ENOTEMPTY occurs on two consecutive attempts before succeeding', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      let callCount = 0
      const runner = async (): Promise<RunSubprocessResult> => {
        callCount++
        if (callCount <= 2) {
          return fail(
            'npm warn cleanup ENOTEMPTY: directory not empty, rmdir .../node_modules/typescript/lib',
          )
        }
        return ok()
      }
      const summary = await installWorktreeDeps({ worktreeRoot: workDir, runner })
      expect(callCount).toBe(3)
      expect(summary.sites).toHaveLength(1)
      expect(summary.sites[0].exitCode).toBe(0)
    })

    it('does not retry non-ENOTEMPTY failures', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      let callCount = 0
      const runner = async (): Promise<RunSubprocessResult> => {
        callCount++
        return fail('ERR_INVALID_PACKAGE_NAME: lockfile drift\n')
      }
      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).rejects.toBeInstanceOf(WorktreeInstallError)
      expect(callCount).toBe(1)
    })

    it('removes the partially corrupt node_modules before retrying on ENOTEMPTY', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      // Simulate the partial corrupt tree left behind by npm's failed cleanup.
      const nm = resolve(workDir, 'node_modules')
      mkdirSync(resolve(nm, 'esbuild', 'bin'), { recursive: true })
      writeFileSync(resolve(nm, 'esbuild', 'bin', 'esbuild'), '#!/usr/bin/env node\n')

      let callCount = 0
      let nodeModulesExistedOnRetry: boolean | null = null
      const runner = async (
        _cmd: string,
        _args: readonly string[],
        cwd: string,
      ): Promise<RunSubprocessResult> => {
        callCount++
        if (callCount === 1) {
          return fail(
            "npm warn cleanup ENOTEMPTY: directory not empty, rmdir '" +
              resolve(cwd, 'node_modules') +
              "'\nnpm error code ENOENT\nnpm error enoent ENOENT: no such file or directory, chmod '" +
              resolve(cwd, 'node_modules', 'esbuild', 'bin', 'esbuild') +
              "'\n",
          )
        }
        // On retry, observe whether the stale node_modules was cleared.
        nodeModulesExistedOnRetry = existsSync(resolve(cwd, 'node_modules'))
        return ok()
      }
      const summary = await installWorktreeDeps({ worktreeRoot: workDir, runner })
      expect(callCount).toBe(2)
      expect(nodeModulesExistedOnRetry).toBe(false)
      expect(summary.sites[0].exitCode).toBe(0)
    })

    it('logs ENOTEMPTY retry attempt before the outcome line', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      let callCount = 0
      const lines: string[] = []
      const runner = async (): Promise<RunSubprocessResult> => {
        callCount++
        if (callCount === 1) {
          return fail(
            'npm warn cleanup ENOTEMPTY: directory not empty, rmdir .../node_modules/sucrase',
          )
        }
        return ok()
      }
      await installWorktreeDeps({
        worktreeRoot: workDir,
        runner,
        log: (line) => lines.push(line),
      })
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/ENOTEMPTY.*retrying/)
      expect(lines[1]).toMatch(/exit=0/)
    })
  })

  describe('waitForFile', () => {
    it('resolves once the file appears within the timeout', async () => {
      const filePath = resolve(workDir, 'index.d.ts')
      // Schedule file creation after we start waiting.
      setTimeout(() => writeFileSync(filePath, 'export {}'), 50)
      await expect(
        waitForFile(filePath, { timeoutMs: 2000, intervalMs: 20 }),
      ).resolves.toBeUndefined()
    })

    it('throws when the file never appears before the timeout elapses', async () => {
      const filePath = resolve(workDir, 'missing.d.ts')
      await expect(
        waitForFile(filePath, { timeoutMs: 100, intervalMs: 20 }),
      ).rejects.toThrow(/never materialized/)
    })
  })

  describe('buildWorkspaceDepsForSite (declaration barrier)', () => {
    const pnpmSite = (dir: string): InstallSite => ({
      dir,
      manager: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
    })

    const setupWorkspace = (opts: { declTypes?: string; exportsTypes?: string } = {}) => {
      const siteDir = resolve(workDir, 'orchestrator')
      const depDir = resolve(workDir, 'packages', 'workflow')
      mkdirSync(siteDir)
      writeFileSync(resolve(siteDir, 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(siteDir, 'package.json'),
        JSON.stringify({
          name: 'orch',
          dependencies: { '@mars/workflow': 'file:../packages/workflow' },
        }),
      )
      mkdirSync(depDir, { recursive: true })
      writeFileSync(resolve(depDir, 'pnpm-lock.yaml'), '')
      const depPkg: Record<string, unknown> = {
        name: '@mars/workflow',
        scripts: { build: 'tsup' },
      }
      if (opts.declTypes) depPkg['types'] = opts.declTypes
      if (opts.exportsTypes) {
        depPkg['exports'] = { '.': { types: opts.exportsTypes, default: './dist/index.js' } }
      }
      writeFileSync(resolve(depDir, 'package.json'), JSON.stringify(depPkg))
      return { siteDir, depDir }
    }

    it('throws when build exits 0 but a declared top-level types path never materializes', async () => {
      const { siteDir } = setupWorkspace({ declTypes: './dist/index.d.ts' })
      // Runner always succeeds, but the .d.ts file is never created on disk.
      const runner = async () => ok()
      await expect(
        buildWorkspaceDepsForSite(
          pnpmSite(siteDir),
          workDir,
          runner,
          undefined,
          DEFAULT_INSTALL_TIMEOUT_MS,
          /* declarationTimeoutMs */ 100,
        ),
      ).rejects.toThrow(/@mars\/workflow.*never materialized|never materialized/)
    })

    it('throws with a message naming the dep and the missing declaration path', async () => {
      const { siteDir, depDir } = setupWorkspace({ declTypes: './dist/index.d.ts' })
      const runner = async () => ok()
      let thrown: Error | undefined
      try {
        await buildWorkspaceDepsForSite(
          pnpmSite(siteDir),
          workDir,
          runner,
          undefined,
          DEFAULT_INSTALL_TIMEOUT_MS,
          /* declarationTimeoutMs */ 100,
        )
      } catch (e) {
        thrown = e as Error
      }
      expect(thrown).toBeDefined()
      expect(thrown!.message).toContain('@mars/workflow')
      expect(thrown!.message).toContain(resolve(depDir, 'dist', 'index.d.ts'))
      expect(thrown!.message).toContain('never materialized')
      expect(thrown!.message).toContain('refusing to install a declaration-less dist')
    })

    it('proceeds without throwing when the declared types file is already present after build', async () => {
      const { siteDir, depDir } = setupWorkspace({ declTypes: './dist/index.d.ts' })
      // Pre-create the declaration file so the barrier finds it immediately.
      mkdirSync(resolve(depDir, 'dist'), { recursive: true })
      writeFileSync(resolve(depDir, 'dist', 'index.d.ts'), 'export {}')
      const runner = async () => ok()
      await expect(
        buildWorkspaceDepsForSite(
          pnpmSite(siteDir),
          workDir,
          runner,
          undefined,
          DEFAULT_INSTALL_TIMEOUT_MS,
          /* declarationTimeoutMs */ 500,
        ),
      ).resolves.toBeUndefined()
    })

    it('enforces exports.types entries in addition to the top-level types field', async () => {
      const { siteDir } = setupWorkspace({ exportsTypes: './dist/index.d.ts' })
      const runner = async () => ok()
      await expect(
        buildWorkspaceDepsForSite(
          pnpmSite(siteDir),
          workDir,
          runner,
          undefined,
          DEFAULT_INSTALL_TIMEOUT_MS,
          /* declarationTimeoutMs */ 100,
        ),
      ).rejects.toThrow(/never materialized/)
    })

    it('does not enforce the barrier when the dep declares no types entrypoint', async () => {
      // No types/typings/exports.types declared → barrier is a no-op.
      setupWorkspace() // no declTypes, no exportsTypes
      const { siteDir } = { siteDir: resolve(workDir, 'orchestrator') }
      const runner = async () => ok()
      await expect(
        buildWorkspaceDepsForSite(
          pnpmSite(siteDir),
          workDir,
          runner,
          undefined,
          DEFAULT_INSTALL_TIMEOUT_MS,
          /* declarationTimeoutMs */ 100,
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe('regenInstallCommand', () => {
    it('maps each manager to its NON-frozen (lockfile-rewriting) command', () => {
      expect(regenInstallCommand('pnpm')).toEqual([
        'pnpm',
        ['install', '--no-frozen-lockfile'],
      ])
      expect(regenInstallCommand('npm')).toEqual(['npm', ['install']])
      expect(regenInstallCommand('yarn')).toEqual(['yarn', ['install']])
      expect(regenInstallCommand('bun')).toEqual(['bun', ['install']])
    })
  })

  describe('repairInstallInPlace', () => {
    const siteFor = (dir: string): InstallSite => ({
      dir,
      manager: 'npm',
      lockfile: 'package-lock.json',
    })

    it('regenerates a drifted lockfile, re-verifies frozen, and reports the change', async () => {
      const lockPath = resolve(workDir, 'package-lock.json')
      writeFileSync(lockPath, '{"lockfileVersion":1,"stale":true}')
      const lockSentinel = resolve(workDir, '.regen.lock')

      const calls: { cmd: string; args: readonly string[] }[] = []
      const runner = async (
        cmd: string,
        args: readonly string[],
      ): Promise<RunSubprocessResult> => {
        calls.push({ cmd, args })
        // The non-frozen regen install rewrites the lockfile.
        if (args.includes('install') && !args.includes('ci')) {
          writeFileSync(lockPath, '{"lockfileVersion":1,"stale":false}')
        }
        return ok()
      }

      const result = await repairInstallInPlace({
        site: siteFor(workDir),
        runner,
        lockPath: lockSentinel,
      })

      expect(result.repaired).toBe(true)
      expect(result.lockfileChanged).toBe(true)
      expect(result.lockfilePath).toBe(lockPath)
      // First the non-frozen regen, then the frozen re-verify.
      expect(calls[0]).toEqual({ cmd: 'npm', args: ['install'] })
      expect(calls[1]).toEqual({ cmd: 'npm', args: ['ci'] })
    })

    it('reports lockfileChanged=false when the regen install leaves the lockfile identical', async () => {
      const lockPath = resolve(workDir, 'package-lock.json')
      writeFileSync(lockPath, '{"lockfileVersion":1}')
      const runner = async (): Promise<RunSubprocessResult> => ok()

      const result = await repairInstallInPlace({
        site: siteFor(workDir),
        runner,
        lockPath: resolve(workDir, '.regen.lock'),
      })

      expect(result.repaired).toBe(true)
      expect(result.lockfileChanged).toBe(false)
    })

    it('returns repaired=false when the regen install itself fails (no frozen re-run)', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      const calls: string[] = []
      const runner = async (
        _cmd: string,
        args: readonly string[],
      ): Promise<RunSubprocessResult> => {
        calls.push(args.join(' '))
        return fail('ERESOLVE could not resolve dependency tree')
      }

      const result = await repairInstallInPlace({
        site: siteFor(workDir),
        runner,
        lockPath: resolve(workDir, '.regen.lock'),
      })

      expect(result.repaired).toBe(false)
      expect(result.lockfileChanged).toBe(false)
      // Only the regen install ran; the frozen re-verify is skipped on failure.
      expect(calls).toEqual(['install'])
    })

    it('returns repaired=false when the frozen re-verify still fails after regen', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      const runner = async (
        _cmd: string,
        args: readonly string[],
      ): Promise<RunSubprocessResult> => {
        // regen succeeds, but the frozen re-verify still can't reconcile.
        if (args.includes('ci')) return fail('npm ci still failing')
        return ok()
      }

      const result = await repairInstallInPlace({
        site: siteFor(workDir),
        runner,
        lockPath: resolve(workDir, '.regen.lock'),
      })

      expect(result.repaired).toBe(false)
    })

    it('serializes via the regen lock: a second repair waits for the first to release', async () => {
      writeFileSync(resolve(workDir, 'package-lock.json'), '{}')
      const lockSentinel = resolve(workDir, '.regen.lock')
      let active = 0
      let maxConcurrent = 0
      const runner = async (): Promise<RunSubprocessResult> => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return ok()
      }

      await Promise.all([
        repairInstallInPlace({
          site: siteFor(workDir),
          runner,
          lockPath: lockSentinel,
        }),
        repairInstallInPlace({
          site: siteFor(workDir),
          runner,
          lockPath: lockSentinel,
        }),
      ])

      // Both repairs ran, but never at the same time — the file lock serialized them.
      expect(maxConcurrent).toBe(1)
    })
  })
})
