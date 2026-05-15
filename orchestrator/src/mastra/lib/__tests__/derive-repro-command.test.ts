import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  deriveReproCommand,
  resolveVerifyCwd,
} from '../derive-repro-command'

describe('deriveReproCommand', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(resolve(tmpdir(), 'mars-derive-repro-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  describe('verify:test', () => {
    it('prefers `npm test` when a test script exists in package.json', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npm test`)
    })

    it('uses `pnpm test` when a pnpm-lock.yaml is present alongside the script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && pnpm test`)
    })

    it('falls back to `npx vitest run` when package.json has no test script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc' } }),
      )
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npx vitest run`)
    })

    it('falls back to `npx vitest run` when package.json is missing entirely', () => {
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npx vitest run`)
    })

    it('falls back to `npx vitest run` when package.json is malformed', () => {
      writeFileSync(resolve(worktree, 'package.json'), '{ not json')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npx vitest run`)
    })
  })

  describe('verify:typecheck', () => {
    it('returns `npx tsc -p .` regardless of package.json state', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      expect(deriveReproCommand('verify:typecheck', worktree)).toBe(
        `cd ${worktree} && npx tsc -p .`,
      )
    })

    it('returns `npx tsc -p .` even with no package.json', () => {
      expect(deriveReproCommand('verify:typecheck', worktree)).toBe(
        `cd ${worktree} && npx tsc -p .`,
      )
    })
  })

  describe('unknown / unsupported failing step', () => {
    it('returns null for unrelated steps like `setup:install`', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      expect(deriveReproCommand('setup:install', worktree)).toBeNull()
    })

    it('returns null when worktreePath is null', () => {
      expect(deriveReproCommand('verify:test', null)).toBeNull()
      expect(deriveReproCommand('verify:typecheck', null)).toBeNull()
    })
  })

  describe('nested project layout (project lives under <worktree>/orchestrator)', () => {
    // Mirrors this repo's layout: the worktree root only declares
    // dependencies; the test runner and tsconfig live in `orchestrator/`.
    // The repro command must `cd` into the subproject or it will not
    // reproduce the verify failure.
    const seedNested = () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ dependencies: {} }),
      )
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(
        resolve(sub, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      return sub
    }

    it('cd-s into the orchestrator subproject for verify:test', () => {
      const sub = seedNested()
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${sub} && npm test`)
    })

    it('cd-s into the orchestrator subproject for verify:typecheck', () => {
      const sub = seedNested()
      const cmd = deriveReproCommand('verify:typecheck', worktree)
      expect(cmd).toBe(`cd ${sub} && npx tsc -p .`)
    })

    it('still picks the root when it owns both package.json and tsconfig.json', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'tsconfig.json'), '{}')
      // The nested orchestrator dir also looks like a project, but root
      // wins because resolveVerifyCwd checks it first.
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(
        resolve(sub, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npm test`)
    })
  })

  describe('resolveVerifyCwd', () => {
    it('returns the worktree root when it has both package.json and tsconfig.json', () => {
      writeFileSync(resolve(worktree, 'package.json'), '{}')
      writeFileSync(resolve(worktree, 'tsconfig.json'), '{}')
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })

    it('falls back to <root>/orchestrator when the root is missing tsconfig.json', () => {
      writeFileSync(resolve(worktree, 'package.json'), '{}')
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(resolve(sub, 'package.json'), '{}')
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      expect(resolveVerifyCwd(worktree)).toBe(sub)
    })

    it('returns the worktree root unchanged when no project layout is found', () => {
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })
  })
})
