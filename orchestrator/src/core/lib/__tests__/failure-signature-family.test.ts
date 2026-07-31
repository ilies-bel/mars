/**
 * Parity tests for the failure-signature FAMILY helper and its SQL twin.
 *
 * `failureSignatureFamily` (TS) and `failureSignatureFamilySql` (the SQL
 * expression the storm evidence query runs) must agree on every signature —
 * they are the one normalization the streak counter and the evidence lookup
 * share, and a silent divergence between them re-opens exactly the bug they
 * were introduced to close (a Steward dispatched blind while real failure
 * output sat unmatched in the DB).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  failureSignatureFamily,
  failureSignatureFamilySql,
  isSameFailureFamily,
} from '../failure-signature.js'

/** Every shape a signature takes in this codebase, plus the degenerate ones. */
const CORPUS: readonly string[] = [
  'code:commit-contract/uncommitted-changes',
  'code/uncommitted-changes',
  'verify:has-diff/no-commits-ahead',
  'verify/no-commits-ahead',
  'merge:vcs-supervisor-aborted/rebase-dirty-worktree',
  'setup:origin-worktree-missing/unclassified',
  'behaviour-verify:dod-unmet/dod-unmet',
  'recovery_exhausted:/unclassified/unclassified',
  'unknown/unclassified',
  'daemon-killed',
  '',
]

describe('failureSignatureFamily', () => {
  it('drops the step kind and keeps the gate and error class', () => {
    expect(failureSignatureFamily('code:commit-contract/uncommitted-changes')).toBe(
      'code/uncommitted-changes',
    )
    expect(failureSignatureFamily('code/uncommitted-changes')).toBe('code/uncommitted-changes')
    expect(failureSignatureFamily('verify:has-diff/no-commits-ahead')).toBe(
      'verify/no-commits-ahead',
    )
  })

  it('treats the two granularities of one failure as the same family', () => {
    expect(
      isSameFailureFamily('code:commit-contract/uncommitted-changes', 'code/uncommitted-changes'),
    ).toBe(true)
  })

  it('keeps different error classes and different gates apart', () => {
    expect(
      isSameFailureFamily('code/uncommitted-changes', 'code:coder-exit-nonzero/api-unreachable'),
    ).toBe(false)
    expect(
      isSameFailureFamily('code/uncommitted-changes', 'merge/uncommitted-changes'),
    ).toBe(false)
  })
})

describe('failureSignatureFamilySql', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-sig-family-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('computes in SQL exactly what the TS helper computes in JS', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const q = await import('../../queue')
    await q.ensureQueueSchema()
    const client = q.resolveQueueClient()

    const placeholders = CORPUS.map(() => '(?)').join(', ')
    const rows = await client.execute({
      sql: `SELECT sig, ${failureSignatureFamilySql('sig')} AS family
              FROM (VALUES ${placeholders}) AS t(sig)`,
      args: [...CORPUS],
    })

    expect(rows.rows).toHaveLength(CORPUS.length)
    for (const row of rows.rows as Array<{ sig: string; family: string }>) {
      expect({ sig: row.sig, family: row.family }).toEqual({
        sig: row.sig,
        family: failureSignatureFamily(row.sig),
      })
    }
  })
})
