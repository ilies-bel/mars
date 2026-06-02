import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  detectInstallSites,
  installCommand,
  installWorktreeDeps,
  ensureLocalDistBuilt,
  WorktreeInstallError,
} from '../worktree-install'
import type { RunSubprocessResult } from '../git'

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
  })

  describe('ensureLocalDistBuilt', () => {
    // Use workDir/orchestrator as the siteDir so that
    // resolve(siteDir, '..', 'packages', 'workflow') stays inside workDir
    // and is under our test's control.
    let siteDir: string

    beforeEach(() => {
      siteDir = resolve(workDir, 'orchestrator')
      mkdirSync(siteDir, { recursive: true })
    })

    it('is a no-op when dist/index.js already exists in node_modules', async () => {
      // Simulate @mars/workflow already installed with dist
      mkdirSync(resolve(siteDir, 'node_modules', '@mars', 'workflow', 'dist'), { recursive: true })
      writeFileSync(resolve(siteDir, 'node_modules', '@mars', 'workflow', 'dist', 'index.js'), 'export {}')

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }

      await ensureLocalDistBuilt(siteDir, runner)
      expect(calls).toHaveLength(0)
    })

    it('runs npm run build when @mars/workflow dist is absent from node_modules', async () => {
      // @mars/workflow installed but no dist
      mkdirSync(resolve(siteDir, 'node_modules', '@mars', 'workflow'), { recursive: true })
      writeFileSync(resolve(siteDir, 'node_modules', '@mars', 'workflow', 'package.json'), '{}')

      // Simulate source dir existing at siteDir/../packages/workflow
      const pkgSrc = resolve(siteDir, '..', 'packages', 'workflow')
      mkdirSync(pkgSrc, { recursive: true })

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }

      await ensureLocalDistBuilt(siteDir, runner)

      const buildCall = calls.find((c) => c.cmd === 'npm' && c.args.includes('build'))
      expect(buildCall).toBeDefined()
      expect(buildCall?.args).toEqual(['run', 'build'])
      expect(buildCall?.cwd).toBe(pkgSrc)
    })

    it('skips build when @mars/workflow is not present in node_modules', async () => {
      // No @mars/workflow in node_modules at all
      mkdirSync(resolve(siteDir, 'node_modules'), { recursive: true })

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }

      await ensureLocalDistBuilt(siteDir, runner)
      expect(calls).toHaveLength(0)
    })

    it('skips build when packages/workflow source dir is missing', async () => {
      // @mars/workflow in node_modules but no dist, and no source dir
      mkdirSync(resolve(siteDir, 'node_modules', '@mars', 'workflow'), { recursive: true })
      writeFileSync(resolve(siteDir, 'node_modules', '@mars', 'workflow', 'package.json'), '{}')
      // workDir/packages/workflow does NOT exist (deliberately not created)

      const calls: RecordedCall[] = []
      const runner = async (cmd: string, args: readonly string[], cwd: string) => {
        calls.push({ cmd, args, cwd })
        return ok()
      }

      await ensureLocalDistBuilt(siteDir, runner)
      // No build attempted because source dir is missing
      expect(calls).toHaveLength(0)
    })

    it('logs a message when dist is absent and build is triggered', async () => {
      mkdirSync(resolve(siteDir, 'node_modules', '@mars', 'workflow'), { recursive: true })
      writeFileSync(resolve(siteDir, 'node_modules', '@mars', 'workflow', 'package.json'), '{}')
      const pkgSrc = resolve(siteDir, '..', 'packages', 'workflow')
      mkdirSync(pkgSrc, { recursive: true })

      const lines: string[] = []
      const runner = async () => ok()

      await ensureLocalDistBuilt(siteDir, runner, (line) => lines.push(line))
      expect(lines.some((l) => l.includes('@mars/workflow'))).toBe(true)
      expect(lines.some((l) => l.includes('dist'))).toBe(true)
    })
  })
})
