import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Stats } from 'node:fs'

// Mock system boundaries before importing the module under test.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}))

// The module under test reaches git only through the Vcs Port, so the Port is
// the boundary this suite stubs.
const currentBranch = vi.fn<() => Promise<string | null>>()
const gitPath = vi.fn<(spec: { name: string }) => Promise<string>>()

vi.mock('../../ports/vcs/registry', () => ({
  resolveVcs: () => ({ currentBranch, gitPath }),
}))

import { assertWorktreeHygieneForVerify } from '../verify'
import { stat } from 'node:fs/promises'

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

beforeEach(() => {
  vi.resetAllMocks()
  // Default: a healthy worktree sitting on the expected branch. Individual
  // tests override `currentBranch` to describe drift.
  currentBranch.mockResolvedValue(BRANCH)
  gitPath.mockImplementation(({ name }) =>
    Promise.resolve(name === 'rebase-merge' ? REBASE_MERGE : REBASE_APPLY),
  )
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
      currentBranch.mockResolvedValue('some-other-branch')

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(
        `verify hygiene: worktree on wrong branch, expected ${BRANCH} got some-other-branch`,
      )
    })

    it('includes drift line with observed=wrong-branch:<name>', async () => {
      vi.mocked(stat).mockResolvedValue(fakeStats())
      currentBranch.mockResolvedValue('some-other-branch')

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

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).rejects.toThrow(`verify hygiene: stale rebase state present at ${REBASE_MERGE}`)
    })

    it('includes drift line with observed=stale-rebase-state', async () => {
      vi.mocked(stat).mockResolvedValueOnce(fakeStats())
      vi.mocked(stat).mockResolvedValueOnce(fakeStats(true))

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

      await expect(
        assertWorktreeHygieneForVerify(WORKTREE, BRANCH),
      ).resolves.toBeUndefined()
    })
  })
})
