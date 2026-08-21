/**
 * Real-git regression tests for `attributeIntegrationDirt`.
 *
 * Reproduces the incident shape this predicate exists to catch: a merge
 * fast-forwards the integration ref forward (adding a file), but the
 * checkout's working tree is left one commit behind — so the added file
 * shows up as *missing* relative to the checkout's own HEAD. That is
 * `stale-tree-debris`, not an operator edit, and the tests assert the
 * predicate tells the two apart exactly: the same missing-file dirt PLUS one
 * genuinely operator-modified file must flip the verdict to `operator-dirt`.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { attributeIntegrationDirt } from '../stale-tree-attribution'

let repoDir: string
let lastSyncedSha: string // c1 — before the 94-line file existed
let headSha: string // c2 — after the 94-line file was added

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

// The exact incident shape: a 94-line file added by the just-merged range.
const NINETY_FOUR_LINES = Array.from({ length: 94 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-stale-tree-attribution-'))

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // c1: baseline commit, plus a file that stays untouched across c2 so the
  // "extra operator edit" test has something innocent to modify.
  commitFile('keep.txt', 'unchanged\n', 'c1')
  lastSyncedSha = git('rev-parse', 'HEAD')

  // c2: the "just-merged" commit that adds the 94-line file.
  commitFile('added-by-merge.txt', NINETY_FOUR_LINES, 'c2 adds added-by-merge.txt')
  headSha = git('rev-parse', 'HEAD')
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

afterEach(() => {
  // Restore the working tree to a pristine HEAD (c2) state between tests.
  git('checkout', 'HEAD', '--', '.')
  git('clean', '-fd')
})

describe('attributeIntegrationDirt', () => {
  it('returns clean when the working tree matches HEAD exactly', async () => {
    const result = await attributeIntegrationDirt({ repoRoot: repoDir, lastSyncedSha, headSha })
    expect(result).toEqual({ kind: 'clean' })
  })

  it('classifies the incident shape as stale-tree-debris: a stale checkout missing the file the merged range added', async () => {
    // Simulate a checkout whose working tree never caught up past c1: the
    // file c2 added is missing from disk (but still tracked in the index),
    // which `git status`/`git diff HEAD` reports as a deletion.
    unlinkSync(resolve(repoDir, 'added-by-merge.txt'))

    const result = await attributeIntegrationDirt({ repoRoot: repoDir, lastSyncedSha, headSha })

    expect(result).toEqual({ kind: 'stale-tree-debris', range: `${lastSyncedSha}..${headSha}` })
  })

  it('classifies the same dirt plus one extra operator-modified file as operator-dirt', async () => {
    unlinkSync(resolve(repoDir, 'added-by-merge.txt'))
    // A genuine operator edit sitting alongside the stale-tree dirt.
    writeFileSync(resolve(repoDir, 'keep.txt'), 'operator changed this\n')

    const result = await attributeIntegrationDirt({ repoRoot: repoDir, lastSyncedSha, headSha })

    expect(result.kind).toBe('operator-dirt')
    if (result.kind === 'operator-dirt') {
      expect(result.statusOutput).toContain('keep.txt')
      expect(result.statusOutput).toContain('added-by-merge.txt')
    }
  })

  it('never classifies an untracked file as stale-tree debris', async () => {
    writeFileSync(resolve(repoDir, 'untracked.txt'), 'brand new, not tracked\n')

    const result = await attributeIntegrationDirt({ repoRoot: repoDir, lastSyncedSha, headSha })

    expect(result.kind).toBe('operator-dirt')
  })

  it('fails safe to operator-dirt when lastSyncedSha is null, even for the exact stale-tree shape', async () => {
    unlinkSync(resolve(repoDir, 'added-by-merge.txt'))

    const result = await attributeIntegrationDirt({
      repoRoot: repoDir,
      lastSyncedSha: null,
      headSha,
    })

    expect(result.kind).toBe('operator-dirt')
  })

  it('fails safe to operator-dirt when lastSyncedSha is not an ancestor of headSha', async () => {
    unlinkSync(resolve(repoDir, 'added-by-merge.txt'))

    // Swap the two SHAs: c2 ("headSha") is a descendant of c1, not an
    // ancestor of it, so passing it as `lastSyncedSha` against `headSha: c1`
    // must fail the ancestry check.
    const result = await attributeIntegrationDirt({
      repoRoot: repoDir,
      lastSyncedSha: headSha,
      headSha: lastSyncedSha,
    })

    expect(result.kind).toBe('operator-dirt')
  })
})
