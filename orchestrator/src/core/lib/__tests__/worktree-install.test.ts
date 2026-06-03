import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  detectInstallSites,
  installCommand,
  installWorktreeDeps,
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

    it('throws WorktreeInstallError when ENOTEMPTY retry also fails', async () => {
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
      expect(callCount).toBe(2)
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
})
