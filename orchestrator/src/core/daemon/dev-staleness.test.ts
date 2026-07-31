import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  decideDevStalenessAction,
  hasDevDependencyDrift,
  hasRelevantDevDrift,
  isStaleDev,
} from './dev-staleness'

const commit = (repo: string, path: string, content: string): string => {
  const file = resolve(repo, path)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, content)
  execFileSync('git', ['add', path], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=Mars Test', '-c', 'user.email=test@mars.local', 'commit', '-qm', path], {
    cwd: repo,
  })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

describe('dev-install staleness', () => {
  it('restarts an idle dev daemon after relevant drift has been stable', () => {
    expect(
      decideDevStalenessAction({
        sourceSha: 'abc1234',
        currentSha: 'def5678',
        installRoute: 'dev',
        inFlightCount: 0,
        dependencyDrift: false,
        stabilityCount: 2,
        autoRestartEnabled: true,
      }),
    ).toBe('restart')
  })

  it('nudges instead of restarting while a task is in flight', () => {
    expect(
      decideDevStalenessAction({
        sourceSha: 'abc1234',
        currentSha: 'def5678',
        installRoute: 'dev',
        inFlightCount: 1,
        dependencyDrift: false,
        stabilityCount: 2,
        autoRestartEnabled: true,
      }),
    ).toBe('nudge')
  })

  it('nudges instead of restarting when dependencies changed', () => {
    expect(
      decideDevStalenessAction({
        sourceSha: 'abc1234',
        currentSha: 'def5678',
        installRoute: 'dev',
        inFlightCount: 0,
        dependencyDrift: true,
        stabilityCount: 2,
        autoRestartEnabled: true,
      }),
    ).toBe('nudge')
  })

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'orchestrator/package.json',
    'orchestrator/package-lock.json',
  ])('detects a %s change since daemon startup', async (changedPath) => {
    const repo = mkdtempSync(resolve(tmpdir(), 'mars-dev-staleness-test-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      const sourceSha = commit(repo, 'scratch/initial.txt', 'initial\n')
      const headSha = commit(repo, changedPath, 'changed\n')

      await expect(hasDevDependencyDrift(sourceSha, headSha, repo)).resolves.toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('never auto-restarts a prod install', () => {
    expect(
      decideDevStalenessAction({
        sourceSha: 'abc1234',
        currentSha: 'def5678',
        installRoute: 'prod',
        inFlightCount: 0,
        dependencyDrift: false,
        stabilityCount: 2,
        autoRestartEnabled: true,
      }),
    ).toBe('none')
  })

  it('keeps nudge-only behaviour when auto-restart is disabled', () => {
    expect(
      decideDevStalenessAction({
        sourceSha: 'abc1234',
        currentSha: 'def5678',
        installRoute: 'dev',
        inFlightCount: 0,
        dependencyDrift: false,
        stabilityCount: 2,
        autoRestartEnabled: false,
      }),
    ).toBe('nudge')
  })

  it('waits for a second stable drift check before restarting', () => {
    expect(
      decideDevStalenessAction({
        sourceSha: 'abc1234',
        currentSha: 'def5678',
        installRoute: 'dev',
        inFlightCount: 0,
        dependencyDrift: false,
        stabilityCount: 1,
        autoRestartEnabled: true,
      }),
    ).toBe('none')
  })

  // ── same SHA ────────────────────────────────────────────────────────────────

  it('returns false when both SHAs are identical (no drift)', () => {
    expect(isStaleDev('abc1234', 'abc1234', 'dev')).toBe(false)
  })

  // ── SHA drift ───────────────────────────────────────────────────────────────

  it('returns true when currentSha differs from sourceSha on a dev install', () => {
    expect(isStaleDev('abc1234', 'def5678', 'dev')).toBe(true)
  })

  // ── null SHA (unknown git state) ─────────────────────────────────────────

  it('returns false when sourceSha is null (git unavailable at startup)', () => {
    expect(isStaleDev(null, 'def5678', 'dev')).toBe(false)
  })

  it('returns false when currentSha is null (git unavailable during check)', () => {
    expect(isStaleDev('abc1234', null, 'dev')).toBe(false)
  })

  it('returns false when both SHAs are null', () => {
    expect(isStaleDev(null, null, 'dev')).toBe(false)
  })

  // ── prod install ─────────────────────────────────────────────────────────

  it('returns false for a prod install even when SHAs differ', () => {
    expect(isStaleDev('abc1234', 'def5678', 'prod')).toBe(false)
  })

  it('returns false for a prod install with null sourceSha', () => {
    expect(isStaleDev(null, 'def5678', 'prod')).toBe(false)
  })

  it.each([
    'ui/app.tsx',
    'docs/guide.md',
    'design/draft.md',
    'CONTEXT.md',
    'scratch/auto-commit.txt',
  ])('does not report drift for a later commit that only changes %s', async (changedPath) => {
    const repo = mkdtempSync(resolve(tmpdir(), 'mars-dev-staleness-test-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      const sourceSha = commit(repo, 'orchestrator/src/daemon.ts', 'export const daemon = true\n')
      const headSha = commit(repo, changedPath, 'unrelated\n')

      await expect(hasRelevantDevDrift(sourceSha, headSha, 'dev', repo)).resolves.toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it.each([
    'orchestrator/src/daemon.ts',
    'packages/workflow/src/engine.ts',
    '.mars/workflows/auto.yaml',
  ])('reports drift for a later commit that changes %s', async (changedPath) => {
    const repo = mkdtempSync(resolve(tmpdir(), 'mars-dev-staleness-test-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      const sourceSha = commit(repo, 'scratch/initial.txt', 'initial\n')
      const headSha = commit(repo, changedPath, 'loaded\n')

      await expect(hasRelevantDevDrift(sourceSha, headSha, 'dev', repo)).resolves.toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
