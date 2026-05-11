import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { deriveReproCommand } from '../derive-repro-command'

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
})
