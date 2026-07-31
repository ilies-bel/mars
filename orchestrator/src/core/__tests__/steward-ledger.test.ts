import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-steward-ledger-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('Steward ledger', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('records interventions and makes them available by target and time window', async () => {
    const ledger = await import('../steward-ledger')
    const since = '2026-07-30T00:00:00.000Z'

    await ledger.recordStewardIntervention({
      targetKind: 'task',
      targetId: 'task-42',
      targetVersion: 'verify:typecheck:abc123',
      recipeId: 'typescript-typecheck',
      rationale: 'The typecheck failure has a known repair recipe.',
      outcome: 'recovery-enqueued',
      ts: '2026-07-30T01:00:00.000Z',
    })
    await ledger.recordStewardIntervention({
      targetKind: 'task',
      targetId: 'task-42',
      targetVersion: 'verify:lint:def456',
      recipeId: 'eslint-lint',
      rationale: 'The lint failure has a known repair recipe.',
      outcome: 'recovery-enqueued',
      commitSha: 'deadbeef',
      ts: '2026-07-30T02:00:00.000Z',
    })

    const forTask = await ledger.listStewardLedgerFor('task', 'task-42')
    const recent = await ledger.listStewardLedgerSince(since)

    expect(forTask.map((entry) => entry.targetVersion)).toEqual([
      'verify:lint:def456',
      'verify:typecheck:abc123',
    ])
    expect(recent).toHaveLength(2)
    expect(recent.map((entry) => entry.targetVersion)).toEqual([
      'verify:lint:def456',
      'verify:typecheck:abc123',
    ])
    expect(forTask[0]?.commitSha).toBe('deadbeef')
  })
})
