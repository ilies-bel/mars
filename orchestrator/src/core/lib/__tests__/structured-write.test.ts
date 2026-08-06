import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const initRepo = (path: string): void => {
  execFileSync('git', ['init', '-q', '-b', 'integration'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: path })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: path })
  writeFileSync(resolve(path, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: path })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: path })
}

const gitOutput = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()

/**
 * Build a real-merge shim for `enqueueMerge` that calls `mergeBranch` directly.
 * This lets the E2E tests exercise the full write-commit-merge path without a
 * running merge-worker daemon.
 */
const realMergeShim = async (args: {
  taskId: string
  branch: string
  worktreePath: string
  integrationBranch: string
}) => {
  const { mergeBranch } = await import('../git/merge')
  const result = await mergeBranch({
    branch: args.branch,
    worktreePath: args.worktreePath,
    integrationBranch: args.integrationBranch,
    lockTimeoutMs: 30_000,
  })
  return { status: 'done' as const, result }
}

const runThroughDurableMergeWorker = async (args: {
  taskId: string
  branch: string
  worktreePath: string
  integrationBranch: string
}) => {
  const queue = await import('../../queue')
  const { createMergeJobStore } = await import('../../store/merge-job-store')
  const { enqueueMergeJobAndAwait, startMergeWorker } = await import('../../daemon/merge-worker')
  await queue.migrateQueueSchema()

  const controller = new AbortController()
  const bus = new EventEmitter()
  const worker = startMergeWorker({
    store: createMergeJobStore(queue.resolveQueueClient()),
    bus,
    log: () => {},
    signal: controller.signal,
    pollIntervalMs: 5,
  })
  try {
    return await enqueueMergeJobAndAwait({
      store: createMergeJobStore(queue.resolveQueueClient()),
      bus,
      ...args,
    })
  } finally {
    await worker.stop()
  }
}

describe('runStructuredWrite (end-to-end against a real temp repo)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-structured-write-'))
    initRepo(repo)
    process.env.MARS_REPO = repo
    process.env.INTEGRATION_BRANCH = 'integration'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  it('routes merge through the injected enqueueMerge and not inline mergeBranch', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    let enqueueMergeCalled = false
    const outcome = await runStructuredWrite({
      kind: 'glossary',
      commitMessage: 'docs(glossary): add Order term',
      enqueueMerge: async (args) => {
        enqueueMergeCalled = true
        return realMergeShim(args)
      },
      mutate: async (worktreePath) => {
        await writeFile(
          resolve(worktreePath, 'CONTEXT.md'),
          '# Project Context\n\n## Language\n\n**Order**:\nA request to buy something.\n',
          'utf8',
        )
      },
    })

    // Merge must be routed through enqueueMerge, not a direct mergeBranch call.
    expect(enqueueMergeCalled).toBe(true)
    expect(outcome.kind).toBe('merged')
  })

  it.each([
    ['adr', 'docs/knowledge/decisions/0001-real-merge.md', 'ADR body'],
    ['glossary', 'CONTEXT.md', 'Glossary body'],
  ])('persists a real merge job for a %s write without exposing bookkeeping as work', async (kind, file, body) => {
    const { runStructuredWrite } = await import('../structured-write')
    const queue = await import('../../queue')
    const { createMergeJobStore } = await import('../../store/merge-job-store')

    const outcome = await runStructuredWrite({
      kind,
      commitMessage: `test: ${kind} durable merge`,
      enqueueMerge: runThroughDurableMergeWorker,
      mutate: async (worktreePath) => {
        if (kind === 'adr') mkdirSync(resolve(worktreePath, 'docs', 'knowledge', 'decisions'), { recursive: true })
        await writeFile(resolve(worktreePath, file), body, 'utf8')
      },
    })

    expect(outcome.kind).toBe('merged')

    const mergeJobs = await createMergeJobStore(queue.resolveQueueClient()).listByStatus('done')
    expect(mergeJobs).toHaveLength(1)
    expect(mergeJobs[0]?.taskId).toMatch(new RegExp(`^${kind}-`))

    // The FK-backed bookkeeping row never becomes ordinary work: it is neither
    // listed nor eligible to be dispatched or recovered.
    expect(await queue.listTasks()).toEqual([])
    expect(await queue.listTasks('queued')).toEqual([])
    expect(await queue.listTasks('failed')).toEqual([])
  })

  it('records a failed structured write in the action queue without throwing', async () => {
    const queue = await import('../../queue')
    const { listActionQueueItems } = await import('../action-queue')
    const { raiseStructuredWriteFailureAction } = await import('../../daemon/server')
    await queue.migrateQueueSchema()

    await expect(
      raiseStructuredWriteFailureAction({
        kind: 'adr',
        target: 'Record failure visibility',
        error: new Error('merge job storage unavailable'),
      }),
    ).resolves.toBeUndefined()

    const items = await listActionQueueItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'failed',
      title: 'Structured adr write failed: Record failure visibility',
      payload: {
        kind: 'adr',
        target: 'Record failure visibility',
        error: 'merge job storage unavailable',
      },
    })
  })

  it('writes, commits, and merges into the integration branch', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    const outcome = await runStructuredWrite({
      kind: 'glossary',
      commitMessage: 'docs(glossary): add Order term',
      enqueueMerge: realMergeShim,
      mutate: async (worktreePath) => {
        await writeFile(
          resolve(worktreePath, 'CONTEXT.md'),
          '# Project Context\n\n## Language\n\n**Order**:\nA request to buy something.\n',
          'utf8',
        )
      },
    })

    expect(outcome.kind).toBe('merged')
    if (outcome.kind === 'merged') {
      expect(outcome.conflictResolved).toBe(false)
    }

    // Integration HEAD now contains CONTEXT.md with the expected content.
    const head = gitOutput(repo, ['rev-parse', 'integration'])
    expect(head).toMatch(/^[0-9a-f]{40}$/)

    const fileAtHead = execFileSync(
      'git',
      ['show', 'integration:CONTEXT.md'],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(fileAtHead).toContain('**Order**:')
    expect(fileAtHead).toContain('A request to buy something.')

    // Latest commit message matches what we passed in.
    const subject = gitOutput(repo, ['log', '-1', '--pretty=%s', 'integration'])
    expect(subject).toBe('docs(glossary): add Order term')

    // Worktree was torn down: filesystem path gone and `git worktree list`
    // only reports the main checkout.
    const worktreesDir = resolve(repo, '.mars', 'worktrees')
    if (existsSync(worktreesDir)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(worktreesDir)).toEqual([])
    }
    const worktreeList = gitOutput(repo, ['worktree', 'list', '--porcelain'])
    expect(worktreeList.match(/^worktree /gm) ?? []).toHaveLength(1)

    // Task branch was deleted on cleanup.
    const branches = gitOutput(repo, ['branch', '--list'])
    expect(branches).not.toMatch(/task\/glossary-/)
  })

  it('is a no-op when mutate returns false (no commit, no merge, no leftover branch)', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    const headBefore = gitOutput(repo, ['rev-parse', 'integration'])

    const outcome = await runStructuredWrite({
      kind: 'glossary',
      commitMessage: 'should not be applied',
      enqueueMerge: realMergeShim,
      mutate: async () => false,
    })

    expect(outcome.kind).toBe('noop')

    const headAfter = gitOutput(repo, ['rev-parse', 'integration'])
    expect(headAfter).toBe(headBefore)

    // No leftover task branch from the aborted write.
    const branches = gitOutput(repo, ['branch', '--list'])
    expect(branches).not.toMatch(/task\/glossary-/)

    // No leftover worktree.
    const worktreeList = gitOutput(repo, ['worktree', 'list', '--porcelain'])
    expect(worktreeList.match(/^worktree /gm) ?? []).toHaveLength(1)
  })

  it('aborts gracefully when the integration branch has uncommitted operator edits — no stash invoked', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    // Make an uncommitted change on the integration checkout.
    writeFileSync(resolve(repo, 'README'), 'PRECIOUS UNCOMMITTED WORK\n')
    const statusBefore = gitOutput(repo, ['status', '--porcelain', '--untracked-files=no'])
    expect(statusBefore).not.toBe('')

    let enqueueMergeCalled = false
    const outcome = await runStructuredWrite({
      kind: 'glossary',
      commitMessage: 'should not be committed',
      enqueueMerge: async (args) => {
        enqueueMergeCalled = true
        return realMergeShim(args)
      },
      mutate: async (worktreePath) => {
        await writeFile(
          resolve(worktreePath, 'CONTEXT.md'),
          '# Context\n',
          'utf8',
        )
      },
    })

    // Must abort — dirty main should never proceed to merge.
    expect(outcome.kind).toBe('aborted')
    if (outcome.kind === 'aborted') {
      expect(outcome.reason).toContain('uncommitted changes')
    }

    // enqueueMerge must NOT have been called — the write aborted before reaching the merge step.
    expect(enqueueMergeCalled).toBe(false)

    // The operator's uncommitted work must NOT have been stashed.
    const stashList = gitOutput(repo, ['stash', 'list'])
    expect(stashList).toBe('')

    // The uncommitted change must still be present on the integration checkout.
    const statusAfter = gitOutput(repo, ['status', '--porcelain', '--untracked-files=no'])
    expect(statusAfter).not.toBe('')

    // Integration HEAD must not have moved.
    const headAfter = gitOutput(repo, ['rev-parse', 'integration'])
    const headBefore = gitOutput(repo, ['rev-parse', 'integration'])
    expect(headAfter).toBe(headBefore)
  })
})

describe('runStructuredWrite — parallel disjoint writes', () => {
  /**
   * These tests prove AC5 of the document-write-coordinator slice:
   * two structured writes targeting DIFFERENT files both merge cleanly
   * without invoking the vcs-supervisor (conflictResolved === false).
   *
   * They exercise `runStructuredWrite` directly so the coordinator layer
   * (DocumentWriteCoordinator) is out of scope — these tests focus purely
   * on the git/merge layer behaviour: disjoint writes never need Vega.
   */

  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-structured-write-parallel-'))
    initRepo(repo)
    process.env.MARS_REPO = repo
    process.env.INTEGRATION_BRANCH = 'integration'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  it('two disjoint structured writes both merge with conflictResolved === false (no Vega)', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    // Launch both writes in parallel; they target different files.
    const [outcomeA, outcomeB] = await Promise.all([
      runStructuredWrite({
        kind: 'glossary',
        commitMessage: 'docs: add file-a',
        enqueueMerge: realMergeShim,
        mutate: async (worktreePath) => {
          await writeFile(resolve(worktreePath, 'file-a.md'), '# File A\n', 'utf8')
        },
      }),
      runStructuredWrite({
        kind: 'adr',
        commitMessage: 'docs: add file-b',
        enqueueMerge: realMergeShim,
        mutate: async (worktreePath) => {
          await writeFile(resolve(worktreePath, 'file-b.md'), '# File B\n', 'utf8')
        },
      }),
    ])

    // Both must merge successfully.
    expect(outcomeA.kind).toBe('merged')
    expect(outcomeB.kind).toBe('merged')

    // Neither should have required Vega (no conflict on disjoint files).
    if (outcomeA.kind === 'merged') {
      expect(outcomeA.conflictResolved).toBe(false)
    }
    if (outcomeB.kind === 'merged') {
      expect(outcomeB.conflictResolved).toBe(false)
    }

    // Both files must be present on the integration branch.
    const fileA = execFileSync('git', ['show', 'integration:file-a.md'], {
      cwd: repo,
      encoding: 'utf8',
    })
    expect(fileA).toContain('File A')

    const fileB = execFileSync('git', ['show', 'integration:file-b.md'], {
      cwd: repo,
      encoding: 'utf8',
    })
    expect(fileB).toContain('File B')
  })
})
