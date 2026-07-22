/**
 * Real-git regression test for the already-merged short-circuit in
 * `mergeBranch`.
 *
 * Builds an actual temp git repo where the task branch is 0 commits ahead of
 * the integration branch (its work has already been fast-forwarded into
 * integration, and integration has since advanced with another commit, so
 * integration is AHEAD). Before the short-circuit was added, this state made
 * `mergeBranch` hang indefinitely: preflight classified the branch
 * `needs-rebase`, the attempt loop's rebase was a no-op, and the
 * fast-forward-ancestry check kept failing (integration is not an ancestor of
 * the behind task branch), spinning through retries / the vcs-supervisor path
 * forever.
 *
 * We assert that `mergeBranch` RESOLVES (the `it` timeout below would trip if
 * it hung) with a success result, that no rebase retry was needed
 * (`retriesAttempted === 0`, `conflictResolved === false`), and that neither
 * the supervisor nor the Vega-start callback fired.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch } from '../merge'
import { __resetContextCacheForTests } from '../../../context'

let repoDir: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-already-merged-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // c1 on main; branch the task off c1 and add c2.
  commitFile('a.txt', 'a', 'c1')
  git('branch', 'task/feat')
  git('checkout', 'task/feat')
  commitFile('b.txt', 'b', 'c2')

  // Fast-forward main up to the task branch (its work is now integrated) ...
  git('checkout', 'main')
  git('merge', '--ff-only', 'task/feat')

  // ... then advance main with c3 so main is AHEAD and task/feat is 0-ahead.
  commitFile('c.txt', 'c', 'c3')

  // Sanity: task branch is 0 commits ahead of main.
  expect(git('rev-list', '--count', 'main..task/feat')).toBe('0')
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
})

describe('mergeBranch — already-merged short-circuit', () => {
  it(
    'resolves as a successful no-op for a 0-commit-ahead task branch without rebasing or invoking the supervisor',
    async () => {
      const onSupervisorEvent = vi.fn()
      const onVegaStart = vi.fn()

      const result = await mergeBranch({
        branch: 'task/feat',
        worktreePath: repoDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        watchdogMs: 10_000,
        onSupervisorEvent,
        onVegaStart,
      })

      expect(result.merged).toBe(true)
      expect(result.aborted).toBe(false)
      expect(result.conflictResolved).toBe(false)
      expect(result.retriesAttempted).toBe(0)
      expect(result.vegaSessionId).toBeNull()
      expect(result.supervisorConversation).toEqual([])
      expect(result.integrationGateFailed).toBeUndefined()

      // No rebase / conflict path was taken.
      expect(onSupervisorEvent).not.toHaveBeenCalled()
      expect(onVegaStart).not.toHaveBeenCalled()
    },
    15_000,
  )
})
