/**
 * Batch drop/purge: `mars drop <id> [<id> ...] [--force]`.
 *
 * Acceptance criteria:
 *   1. Multi-id invocation sends one daemon request per id and prints a
 *      per-task result line for each.
 *   2. A single failing id does NOT abort the batch — remaining ids are
 *      still processed, output is printed for them, and the exit code is
 *      non-zero iff at least one id failed.
 *   3. A summary line ("drop complete: N succeeded, M failed") is printed
 *      when more than one id is given.
 *   4. Same three criteria apply to `mars purge`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import type { DaemonRequest } from '../../core/daemon/protocol'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-drop-batch-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const baseOpts = async (
  daemonResponder?: (req: DaemonRequest) => unknown,
): Promise<InProcessOptions> => {
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: makeFakeDaemon(daemonResponder) }
}

/** Canonical drop response from the daemon for a given id. */
const dropResponse = (id: string) => ({
  taskId: id,
  previousStatus: 'queued',
  edgesRemoved: { incoming: 0, outgoing: 0 },
  cascadedFixTaskIds: [],
  worktreeRemoved: false,
  branchDeleted: false,
})

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// mars drop — summary text
// ---------------------------------------------------------------------------

describe('mars drop — command summary', () => {
  it('names worktree+branch+row destruction in the one-line summary', async () => {
    const { allCommands } = await import('../commands/index')
    const dropEntry = allCommands.find((c) => c.path === 'drop')
    expect(dropEntry).toBeDefined()
    expect(dropEntry!.summary).toContain('worktree')
    expect(dropEntry!.summary).toContain('branch')
    expect(dropEntry!.summary).toContain('row')
  })
})

// ---------------------------------------------------------------------------
// mars drop — batch behaviour
// ---------------------------------------------------------------------------

describe('mars drop — single id (existing behaviour preserved)', () => {
  it('exits 0 and prints a result line for one id', async () => {
    const opts = await baseOpts(() => dropResponse('mars-a'))
    const r = await runCommandInProcess(['drop', 'mars-a'], opts)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('dropped mars-a')
  })

  it('exits 2 with usage message when no id is given', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(['drop'], opts)
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars drop')
  })

  it('propagates daemon refusal when branch has commits ahead and no --force', async () => {
    const ahead3Error = 'refusing to drop task mars-abc: branch task/mars-abc has 3 commit(s) ahead of main that drop would discard. Review or land the branch, or rerun with --force to discard it.'
    const fake = makeFakeDaemon(() => {
      throw new Error(ahead3Error)
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['drop', 'mars-abc'], { store, ctx, daemon: fake })
    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('mars-abc')
    expect(r.err.join('\n')).toContain('3 commit(s) ahead')
  })

  it('passes --force=true to daemon so ahead-of-main guard is bypassed', async () => {
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'drop' && (req as { force?: boolean }).force) {
        return dropResponse((req as { id: string }).id)
      }
      throw new Error('refusing to drop: commits ahead')
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['drop', 'mars-abc', '--force'], { store, ctx, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('dropped mars-abc')
  })
})

describe('mars drop — multi-id batch', () => {
  it('sends one daemon request per id and prints a per-task result line for each', async () => {
    const ids = ['mars-aa', 'mars-bb', 'mars-cc']
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'drop') return dropResponse(req.id as string)
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['drop', ...ids], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    // One daemon call per id
    const dropCalls = fake.calls.filter((c) => c.op === 'drop')
    expect(dropCalls).toHaveLength(3)
    expect(dropCalls.map((c) => (c as { id: string }).id)).toEqual(ids)
    // Per-task output lines
    const out = r.out.join('\n')
    for (const id of ids) {
      expect(out).toContain(`dropped ${id}`)
    }
  })

  it('prints a summary line when more than one id is given', async () => {
    const opts = await baseOpts((req) => {
      if (req.op === 'drop') return dropResponse((req as { id: string }).id)
      return {}
    })
    const r = await runCommandInProcess(['drop', 'mars-x1', 'mars-x2'], opts)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/drop complete: 2 succeeded, 0 failed/)
  })

  it('does NOT print a summary line when only one id is given', async () => {
    const opts = await baseOpts(() => dropResponse('mars-solo'))
    const r = await runCommandInProcess(['drop', 'mars-solo'], opts)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).not.toContain('drop complete:')
  })

  it('continues processing remaining ids when one fails and exits non-zero', async () => {
    const ids = ['mars-ok1', 'mars-fail', 'mars-ok2']
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'drop') {
        const id = (req as { id: string }).id
        if (id === 'mars-fail') throw new Error('task is running; pass --force to override')
        return dropResponse(id)
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['drop', ...ids], { store, ctx, daemon: fake })

    // Non-zero exit because one failed
    expect(r.code).not.toBe(0)
    // The two successful ids still got their result lines
    const out = r.out.join('\n')
    expect(out).toContain('dropped mars-ok1')
    expect(out).toContain('dropped mars-ok2')
    // The failing id produced a stderr line
    expect(r.err.join('\n')).toContain('mars-fail')
    // Summary reflects the split
    expect(out).toMatch(/drop complete: 2 succeeded, 1 failed/)
  })

  it('exits non-zero when ALL ids fail', async () => {
    const fake = makeFakeDaemon(() => {
      throw new Error('not found')
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['drop', 'mars-a', 'mars-b'], { store, ctx, daemon: fake })
    expect(r.code).not.toBe(0)
    expect(r.out.join('\n')).toMatch(/drop complete: 0 succeeded, 2 failed/)
  })

  it('passes --force to each daemon request', async () => {
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'drop') return dropResponse((req as { id: string }).id)
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(['drop', 'mars-p', 'mars-q', '--force'], { store, ctx, daemon: fake })
    const dropCalls = fake.calls.filter((c) => c.op === 'drop')
    for (const call of dropCalls) {
      expect((call as { force: boolean }).force).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// mars purge — batch behaviour (same treatment)
// ---------------------------------------------------------------------------

describe('mars purge — single id (existing behaviour preserved)', () => {
  it('exits 0 and prints "purged <id>" for one id', async () => {
    const opts = await baseOpts(() => ({}))
    const r = await runCommandInProcess(['purge', 'mars-p1'], opts)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('purged mars-p1')
  })

  it('exits 2 with usage message when no id is given', async () => {
    const opts = await baseOpts()
    const r = await runCommandInProcess(['purge'], opts)
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars purge')
  })
})

describe('mars purge — multi-id batch', () => {
  it('sends one daemon request per id and prints a per-task result line', async () => {
    const ids = ['mars-pa', 'mars-pb', 'mars-pc']
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['purge', ...ids], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    const purgeCalls = fake.calls.filter((c) => c.op === 'purge')
    expect(purgeCalls).toHaveLength(3)
    const out = r.out.join('\n')
    for (const id of ids) {
      expect(out).toContain(`purged ${id}`)
    }
  })

  it('prints a summary line when more than one id is given', async () => {
    const opts = await baseOpts(() => ({}))
    const r = await runCommandInProcess(['purge', 'mars-q1', 'mars-q2'], opts)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toMatch(/purge complete: 2 succeeded, 0 failed/)
  })

  it('does NOT print a summary line when only one id is given', async () => {
    const opts = await baseOpts(() => ({}))
    const r = await runCommandInProcess(['purge', 'mars-solo'], opts)
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).not.toContain('purge complete:')
  })

  it('continues processing remaining ids when one fails and exits non-zero', async () => {
    const ids = ['mars-pok1', 'mars-pfail', 'mars-pok2']
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'purge' && (req as { id: string }).id === 'mars-pfail') {
        throw new Error('task is in-flight; pass --force to override')
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['purge', ...ids], { store, ctx, daemon: fake })

    expect(r.code).not.toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('purged mars-pok1')
    expect(out).toContain('purged mars-pok2')
    expect(r.err.join('\n')).toContain('mars-pfail')
    expect(out).toMatch(/purge complete: 2 succeeded, 1 failed/)
  })
})
