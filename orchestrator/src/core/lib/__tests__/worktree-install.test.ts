import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  detectInstallSites,
  parseInstallRoots,
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

    it('limits discovery to configured repository-relative roots', async () => {
      mkdirSync(resolve(workDir, 'landing'))
      writeFileSync(resolve(workDir, 'landing', 'package-lock.json'), '{}')
      mkdirSync(resolve(workDir, 'mvp', 'app'), { recursive: true })
      writeFileSync(resolve(workDir, 'mvp', 'app', 'package-lock.json'), '{}')

      const sites = await detectInstallSites(workDir, 3, ['mvp/app'])

      expect(sites).toEqual([
        {
          dir: resolve(workDir, 'mvp', 'app'),
          manager: 'npm',
          lockfile: 'package-lock.json',
        },
      ])
    })

    it('rejects configured roots that escape the worktree', async () => {
      await expect(
        detectInstallSites(workDir, 3, ['../outside']),
      ).rejects.toThrow('install root escapes worktree')
    })
  })

  describe('parseInstallRoots', () => {
    it('parses, trims, and deduplicates comma-separated roots', () => {
      expect(parseInstallRoots('mvp/app, landing, mvp/app')).toEqual([
        'mvp/app',
        'landing',
      ])
    })

    it('leaves install discovery unscoped when unset or blank', () => {
      expect(parseInstallRoots(undefined)).toBeUndefined()
      expect(parseInstallRoots('   ')).toBeUndefined()
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

    it('installs only explicitly configured roots', async () => {
      mkdirSync(resolve(workDir, 'landing'))
      writeFileSync(resolve(workDir, 'landing', 'package-lock.json'), '{}')
      mkdirSync(resolve(workDir, 'mvp', 'app'), { recursive: true })
      writeFileSync(resolve(workDir, 'mvp', 'app', 'package-lock.json'), '{}')
      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }

      const summary = await installWorktreeDeps({
        worktreeRoot: workDir,
        installRoots: ['mvp/app'],
        runner,
      })

      expect(calls).toEqual([
        {
          cmd: 'npm',
          args: ['ci'],
          cwd: resolve(workDir, 'mvp', 'app'),
        },
      ])
      expect(summary.sites).toHaveLength(1)
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

    it('reports a missing package module tree as setup:modules-missing after a successful install', async () => {
      const packageDir = resolve(workDir, 'orchestrator')
      mkdirSync(packageDir)
      writeFileSync(resolve(packageDir, 'package-lock.json'), '{}')

      await expect(
        installWorktreeDeps({
          worktreeRoot: workDir,
          requireModuleTrees: true,
          runner: async () => ok(),
        }),
      ).rejects.toMatchObject({
        name: 'WorktreeModulesMissingError',
        failureStep: 'setup:modules-missing',
        site: expect.objectContaining({ dir: packageDir }),
      })
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

    it('handles the canonical mars graph (root link:->orch + orch file:->workflow) without ever building orch', async () => {
      // This is the exact install topology this repo dogfoods on:
      //   root         → link:./orchestrator                       (must skip pre-build)
      //   orchestrator → file:../packages/workflow                 (pre-builds workflow)
      //   packages/workflow                                         (standalone install site)
      //
      // The historical setup bug — "workspace dep build failed (orchestrator):
      // pnpm run build exited 2" — fired when the root site treated link: like
      // file:/workspace: and ran `pnpm run build` (=tsc --noEmit) in
      // orchestrator concurrently with the orchestrator site's own setup.
      // Codify the invariants for this specific graph here, separate from the
      // narrower "skips link:" unit test above, so a future regression in
      // either dimension (link: handling OR file: pre-build ordering) is
      // caught against the real-world shape and not just a simplified graph.
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

      const orchDir = resolve(workDir, 'orchestrator')
      const wfDir = resolve(workDir, 'packages', 'workflow')

      // Invariant 1: `pnpm run build` NEVER runs in orchestrator. The root
      // site's link: dep must be skipped; pre-building orchestrator (tsc
      // --noEmit) would race with workflow's still-unpacked dist and is the
      // exact failure mode this guards against.
      const orchBuilds = calls.filter(
        (c) => c.cwd === orchDir && c.args[0] === 'run' && c.args[1] === 'build',
      )
      expect(orchBuilds).toEqual([])

      // Invariant 2: workflow IS pre-built (it's a file: dep, dist must be
      // packed before the orchestrator site installs).
      const wfBuilds = calls.filter(
        (c) => c.cwd === wfDir && c.args[0] === 'run' && c.args[1] === 'build',
      )
      expect(wfBuilds).toHaveLength(1)

      // Invariant 3: orchestrator is installed exactly once — its own site's
      // install. The root site's link: dep must NOT trigger a second install
      // in orchestrator (which would race on pnpm's store lock).
      const orchInstalls = calls.filter(
        (c) => c.cwd === orchDir && c.args[0] === 'install',
      )
      expect(orchInstalls).toHaveLength(1)
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

    it('retries a transient pnpm run build failure (empty stdout+stderr) and succeeds on the retry', async () => {
      // Mirrors the real Mars cascade (PRD 9e657468 / mars-53f935be) where
      // `pnpm run build exited 2` with EMPTY stderr was a transient bin-race,
      // not a compiler error — the same build passed on re-run.
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

      let buildAttempts = 0
      const runner = async (cmd: string, args: readonly string[]): Promise<RunSubprocessResult> => {
        if (cmd === 'pnpm' && args[0] === 'run' && args[1] === 'build') {
          buildAttempts++
          if (buildAttempts === 1) {
            // Transient: non-zero exit, both stdout and stderr empty
            return { exitCode: 2, stdout: '', stderr: '' }
          }
          return ok()
        }
        return ok()
      }

      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).resolves.toBeDefined()
      expect(buildAttempts).toBe(2)
    })

    it('does NOT retry a pnpm run build failure that has diagnostic output (stderr or stdout)', async () => {
      // A real tsc/tsup compiler error always emits diagnostics — retrying
      // would waste minutes on a deterministic failure. Assert exactly 1 build
      // attempt so we never mask real type errors behind a retry.
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
        JSON.stringify({ name: '@mars/workflow', scripts: { build: 'tsc --noEmit' } }),
      )

      let buildAttempts = 0
      const runner = async (cmd: string, args: readonly string[]): Promise<RunSubprocessResult> => {
        if (cmd === 'pnpm' && args[0] === 'run' && args[1] === 'build') {
          buildAttempts++
          // Failure with diagnostic output on stdout (tsc --noEmit style)
          return {
            exitCode: 2,
            stdout: "src/index.ts(1,1): error TS2307: Cannot find module '@mars/workflow'.\n",
            stderr: '',
          }
        }
        return ok()
      }

      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).rejects.toThrow(/workspace dep build failed/)
      // Must not retry — exactly 1 build attempt for a failure with output
      expect(buildAttempts).toBe(1)
    })

    it('wipes node_modules and reinstalls when a workspace-dep build fails with the rollup optional-dep race pattern', async () => {
      // The pnpm v10 optional-dependency linking race: pnpm install exits 0
      // but the platform-specific rollup native binary symlink is not set up,
      // causing `pnpm run build` (tsup/rollup) to exit 1 with
      // "Cannot find module @rollup/rollup-darwin-arm64". Retrying the build
      // alone won't help — the missing symlink is in node_modules. The fix is
      // to wipe node_modules and reinstall so pnpm re-creates the link tree,
      // then retry the build once.
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'orchestrator', 'package.json'),
        JSON.stringify({
          name: 'orch',
          dependencies: { '@mars/workflow': 'file:../packages/workflow' },
        }),
      )
      const wfDir = resolve(workDir, 'packages', 'workflow')
      mkdirSync(resolve(wfDir, 'node_modules', '.bin'), { recursive: true })
      // Pre-create the tsup binary so the post-install bin check passes without
      // triggering a second install — keeps install counts unambiguous.
      writeFileSync(resolve(wfDir, 'node_modules', '.bin', 'tsup'), '#!/usr/bin/env node\n')
      // No lockfile in wfDir: it is a pre-build dep only, not its own install
      // site. This means detectInstallSites won't add a fourth install call.
      writeFileSync(
        resolve(wfDir, 'package.json'),
        JSON.stringify({ name: '@mars/workflow', scripts: { build: 'tsup' } }),
      )

      let buildAttempts = 0
      let wfInstallAttempts = 0
      // Track whether node_modules was absent at the time of the retry install.
      let nodeModulesAbsentOnRetryInstall: boolean | null = null
      const runner = async (
        cmd: string,
        args: readonly string[],
        cwd: string,
      ): Promise<RunSubprocessResult> => {
        // Count install calls that target the workflow dep directory.
        if (cwd === wfDir && args[0] !== 'run') {
          wfInstallAttempts++
          if (wfInstallAttempts === 2) {
            // On the retry install, verify node_modules was wiped first.
            const { existsSync: eS } = await import('node:fs')
            nodeModulesAbsentOnRetryInstall = !eS(resolve(wfDir, 'node_modules'))
          }
          return ok()
        }
        if (cmd === 'pnpm' && args[0] === 'run' && args[1] === 'build' && cwd === wfDir) {
          buildAttempts++
          if (buildAttempts === 1) {
            return {
              exitCode: 1,
              stdout: '',
              stderr:
                'Error: Cannot find module @rollup/rollup-darwin-arm64. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).',
            }
          }
          return ok()
        }
        return ok()
      }

      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).resolves.toBeDefined()

      // Two build attempts: one failure, one success after reinstall.
      expect(buildAttempts).toBe(2)
      // Two install attempts for the workflow dep: initial + retry after wipe.
      expect(wfInstallAttempts).toBe(2)
      // node_modules must have been absent when the retry install ran.
      expect(nodeModulesAbsentOnRetryInstall).toBe(true)
    })

    it('does not recover from a rollup optional-dep race if the reinstall also fails', async () => {
      // If the retry install itself exits non-zero, surface the error immediately
      // rather than looping indefinitely.
      mkdirSync(resolve(workDir, 'orchestrator'))
      writeFileSync(resolve(workDir, 'orchestrator', 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(workDir, 'orchestrator', 'package.json'),
        JSON.stringify({
          name: 'orch',
          dependencies: { '@mars/workflow': 'file:../packages/workflow' },
        }),
      )
      const wfDir = resolve(workDir, 'packages', 'workflow')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(resolve(wfDir, 'pnpm-lock.yaml'), '')
      writeFileSync(
        resolve(wfDir, 'package.json'),
        JSON.stringify({ name: '@mars/workflow', scripts: { build: 'tsup' } }),
      )

      let wfInstallAttempts = 0
      const runner = async (
        cmd: string,
        args: readonly string[],
        cwd: string,
      ): Promise<RunSubprocessResult> => {
        if (cwd === wfDir && (args[0] === 'install' || args.includes('install'))) {
          wfInstallAttempts++
          if (wfInstallAttempts === 2) {
            return fail('ERR_PNPM_REGISTRY: connection refused')
          }
          return ok()
        }
        if (cmd === 'pnpm' && args[0] === 'run' && args[1] === 'build' && cwd === wfDir) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: Cannot find module @rollup/rollup-darwin-arm64.',
          }
        }
        return ok()
      }

      await expect(
        installWorktreeDeps({ worktreeRoot: workDir, runner }),
      ).rejects.toThrow(/workspace dep/)
    })

    it('surfaces stdout in the workspace-dep build error (tsc/tsup emit failure detail on stdout)', async () => {
      // The original link:-pre-build regression (3c78adcc) surfaced as
      // `workspace dep build failed (orchestrator): pnpm run build exited 2`
      // with empty stderr — `tsc --noEmit` writes its TS errors to stdout, and
      // the prior error message only included stderr, leaving operators with
      // no diagnostic. Pin that stdout is included now.
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
        JSON.stringify({ name: '@mars/workflow', scripts: { build: 'tsc --noEmit' } }),
      )
      // dep install ok; build fails with detail on STDOUT, empty stderr —
      // mirroring `tsc --noEmit` and `tsup` DTS-pass failure modes.
      const runner = async (
        cmd: string,
        args: readonly string[],
      ): Promise<RunSubprocessResult> => {
        if (cmd === 'pnpm' && args[0] === 'run' && args[1] === 'build') {
          return {
            exitCode: 2,
            stdout: 'src/cli.ts(1,1): error TS2307: Cannot find module \'@mars/workflow\'.\n',
            stderr: '',
          }
        }
        return ok()
      }
      try {
        await installWorktreeDeps({ worktreeRoot: workDir, runner })
        expect.fail('expected installWorktreeDeps to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toContain('workspace dep build failed')
          expect(error.message).toContain('stdout (truncated):')
          expect(error.message).toContain('TS2307')
        }
      }
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

  describe('buildWorkspaceDepsForSite (non-pnpm managers)', () => {
    const makeNonPnpmSetup = (
      manager: 'npm' | 'yarn' | 'bun',
      lockfile: string,
    ) => {
      const siteDir = resolve(workDir, 'consumer')
      const depDir = resolve(workDir, 'packages', 'shared')
      mkdirSync(siteDir)
      writeFileSync(resolve(siteDir, lockfile), '')
      writeFileSync(
        resolve(siteDir, 'package.json'),
        JSON.stringify({
          name: 'consumer',
          dependencies: { '@acme/shared': 'file:../packages/shared' },
        }),
      )
      mkdirSync(depDir, { recursive: true })
      writeFileSync(resolve(depDir, lockfile), '')
      writeFileSync(
        resolve(depDir, 'package.json'),
        JSON.stringify({ name: '@acme/shared', scripts: { build: 'tsc' } }),
      )
      const site: InstallSite = { dir: siteDir, manager, lockfile }
      return { siteDir, depDir, site }
    }

    it.each([
      { manager: 'npm' as const, lockfile: 'package-lock.json' },
      { manager: 'yarn' as const, lockfile: 'yarn.lock' },
      { manager: 'bun' as const, lockfile: 'bun.lockb' },
    ])(
      '$manager site with file: dep pre-builds the dep using $manager (not pnpm)',
      async ({ manager, lockfile }) => {
        const { depDir, site } = makeNonPnpmSetup(manager, lockfile)

        const calls: RecordedCall[] = []
        const runner = async (cmd: string, args: readonly string[], cwd: string) => {
          calls.push({ cmd, args, cwd })
          return ok()
        }
        await buildWorkspaceDepsForSite(
          site,
          workDir,
          runner,
          undefined,
          DEFAULT_INSTALL_TIMEOUT_MS,
        )

        // The dep install must use the site's package manager, not pnpm
        const depInstallCall = calls.find((c) => c.cwd === depDir && c.cmd === manager)
        expect(depInstallCall).toBeDefined()
        expect(calls.some((c) => c.cmd === 'pnpm')).toBe(false)

        // The dep build must also use the site's package manager
        const depBuildCall = calls.find(
          (c) => c.cwd === depDir && c.cmd === manager && c.args[0] === 'run' && c.args[1] === 'build',
        )
        expect(depBuildCall).toBeDefined()
      },
    )

    it('npm site with file: dep uses npm ci (frozen) when dep has a package-lock.json', async () => {
      const { depDir, site } = makeNonPnpmSetup('npm', 'package-lock.json')

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }
      await buildWorkspaceDepsForSite(site, workDir, runner, undefined, DEFAULT_INSTALL_TIMEOUT_MS)

      const depInstallCall = calls.find(
        (c) => c.cwd === depDir && c.cmd === 'npm' && c.args[0] !== 'run',
      )
      expect(depInstallCall).toBeDefined()
      // npm's frozen install is `npm ci`, not `npm install --frozen-lockfile`
      expect(depInstallCall!.args[0]).toBe('ci')
    })

    it('npm install failure error message does not contain pnpm-debug.log', async () => {
      const { site } = makeNonPnpmSetup('npm', 'package-lock.json')

      const runner = async (): Promise<RunSubprocessResult> =>
        fail('npm ERR! something went wrong\n')
      let thrown: Error | undefined
      try {
        await buildWorkspaceDepsForSite(site, workDir, runner, undefined, DEFAULT_INSTALL_TIMEOUT_MS)
      } catch (e) {
        thrown = e as Error
      }
      expect(thrown).toBeDefined()
      expect(thrown!.message).toContain('workspace dep install failed')
      expect(thrown!.message).not.toContain('pnpm-debug.log')
    })
  })

  describe('installWorktreeDeps (non-pnpm file: deps)', () => {
    it('pre-builds a file: workspace dep for an npm site before the consumer install', async () => {
      mkdirSync(resolve(workDir, 'consumer'))
      writeFileSync(resolve(workDir, 'consumer', 'package-lock.json'), '{}')
      writeFileSync(
        resolve(workDir, 'consumer', 'package.json'),
        JSON.stringify({
          name: 'consumer',
          dependencies: { '@acme/shared': 'file:../packages/shared' },
        }),
      )
      mkdirSync(resolve(workDir, 'packages', 'shared'), { recursive: true })
      writeFileSync(resolve(workDir, 'packages', 'shared', 'package-lock.json'), '{}')
      writeFileSync(
        resolve(workDir, 'packages', 'shared', 'package.json'),
        JSON.stringify({ name: '@acme/shared', scripts: { build: 'tsc' } }),
      )

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }
      await installWorktreeDeps({ worktreeRoot: workDir, runner })

      const sharedDir = resolve(workDir, 'packages', 'shared')
      const consumerDir = resolve(workDir, 'consumer')

      // The dep build must run using npm, before the consumer install
      const depBuildIdx = calls.findIndex(
        (c) =>
          c.cwd === sharedDir &&
          c.cmd === 'npm' &&
          c.args[0] === 'run' &&
          c.args[1] === 'build',
      )
      const consumerInstallIdx = calls.findIndex(
        (c) => c.cwd === consumerDir && c.cmd === 'npm' && c.args[0] === 'ci',
      )
      expect(depBuildIdx).toBeGreaterThanOrEqual(0)
      expect(consumerInstallIdx).toBeGreaterThanOrEqual(0)
      expect(depBuildIdx).toBeLessThan(consumerInstallIdx)
      // Must not use pnpm anywhere
      expect(calls.some((c) => c.cmd === 'pnpm')).toBe(false)
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
