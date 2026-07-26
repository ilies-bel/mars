import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Stats } from 'node:fs'

// Mock system boundaries before importing the module under test.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}))

vi.mock('../git/internal', () => ({
  exec: vi.fn(),
  resolveGitBin: vi.fn(),
}))

import { assertWorktreeHygieneForVerify } from '../verify'
import { stat } from 'node:fs/promises'
import { exec, resolveGitBin } from '../git/internal'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKTREE = '/task/worktrees/mars-abc123'
const BRANCH = 'task/mars-abc123'
const REBASE_MERGE = `${WORKTREE}/.git/rebase-merge`
const REBASE_APPLY = `${WORKTREE}/.git/rebase-apply`

const enoent = (): Error =>
  Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })

const fakeStats = (isDir = false): Stats =>
  ({ isDirectory: () => isDir }) as unknown as Stats

// exec implementation for a healthy worktree on the expected branch.
const healthyExec = (_git: string, args: readonly string[]) => {
  if (args.includes('--abbrev-ref')) {
    return Promise.resolve({ stdout: BRANCH + '\n', stderr: '' })
  }
  if (args.includes('rebase-merge')) {
    return Promise.resolve({ stdout: REBASE_MERGE + '\n', stderr: '' })
  }
  if (args.includes('rebase-apply')) {
    return Promise.resolve({ stdout: REBASE_APPLY + '\n', stderr: '' })
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveGitBin).mockReturnValue('/usr/bin/git')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assertWorktreeHygieneForVerify', () => {
  describe('worktree missing', () => {
    it('throws with worktree-missing sentinel when directory does not exist', async () => {
      vi.mocked(stat).mockRejectedValue(enoent())

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(`worktree path ${WORKTREE} no longer exists`)
    })

    it('includes drift line with observed=missing', async () => {
      vi.mocked(stat).mockRejectedValue(enoent())

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(`drift: recorded=${WORKTREE} observed=missing`)
    })
  })

  describe('branch drift', () => {
    it('throws with branch-drift sentinel when a different branch is checked out', async () => {
      vi.mocked(stat).mockResolvedValue(fakeStats())
      vi.mocked(exec).mockImplementation((_git, args) => {
        if (args.includes('--abbrev-ref')) {
          return Promise.resolve({ stdout: 'some-other-branch\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(
        `verify hygiene: worktree on wrong branch, expected ${BRANCH} got some-other-branch`,
      )
    })

    it('includes drift line with observed=wrong-branch:<name>', async () => {
      vi.mocked(stat).mockResolvedValue(fakeStats())
      vi.mocked(exec).mockImplementation((_git, args) => {
        if (args.includes('--abbrev-ref')) {
          return Promise.resolve({ stdout: 'some-other-branch\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(
        `drift: recorded=${WORKTREE} observed=wrong-branch:some-other-branch`,
      )
    })
  })

  describe('stale rebase state', () => {
    it('throws with stale-rebase-state sentinel when rebase-merge dir is present', async () => {
      // First stat call: worktree exists.
      vi.mocked(stat).mockResolvedValueOnce(fakeStats())
      // Second stat call: rebase-merge dir exists as a directory.
      vi.mocked(stat).mockResolvedValueOnce(fakeStats(true))

      vi.mocked(exec).mockImplementation(healthyExec)

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(`verify hygiene: stale rebase state present at ${REBASE_MERGE}`)
    })

    it('includes drift line with observed=stale-rebase-state', async () => {
      vi.mocked(stat).mockResolvedValueOnce(fakeStats())
      vi.mocked(stat).mockResolvedValueOnce(fakeStats(true))
      vi.mocked(exec).mockImplementation(healthyExec)

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(`drift: recorded=${WORKTREE} observed=stale-rebase-state`)
    })

    it('throws when only rebase-apply dir is present', async () => {
      vi.mocked(stat).mockResolvedValueOnce(fakeStats())
      // rebase-merge: not present
      vi.mocked(stat).mockRejectedValueOnce(enoent())
      // rebase-apply: present
      vi.mocked(stat).mockResolvedValueOnce(fakeStats(true))

      vi.mocked(exec).mockImplementation(healthyExec)

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(`verify hygiene: stale rebase state present at ${REBASE_APPLY}`)
    })
  })

  describe('happy path', () => {
    it('resolves without throwing when the worktree is healthy', async () => {
      // stat for worktree dir
      vi.mocked(stat).mockResolvedValueOnce(fakeStats())
      // stat for rebase-merge: absent
      vi.mocked(stat).mockRejectedValueOnce(enoent())
      // stat for rebase-apply: absent
      vi.mocked(stat).mockRejectedValueOnce(enoent())

      vi.mocked(exec).mockImplementation(healthyExec)

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).resolves.toBeUndefined()
    })
  })
})
