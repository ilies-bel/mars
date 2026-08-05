/**
 * Tests for `mars list --status <x>` (flag form), the positional form, the
 * conflicting-both case, and the invalid-value path.
 *
 * The `list` command is implemented in `lifecycle.ts`. These tests exercise
 * observable CLI behaviour through `runCommandInProcess` — no spawned binary,
 * no process.exit.
 *
 * A minimal fake store stubs only `listTasksPaged` (the one method `list` calls).
 */

import { describe, expect, it } from 'vitest'
import { runCommandInProcess } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import type { TaskStatus } from '../../core/queue'

// ── Minimal test helpers ─────────────────────────────────────────────────────

/** Fake context — `list` never reads ctx, so any non-null object works. */
const fakeCtx: OrchestratorContext = {
  repoRoot: '/tmp/mars-list-test',
  stateDir: '/tmp/mars-list-test/.mars',
  queueDbPath: '/tmp/mars-list-test/.mars/mars.db',
  observabilityDbPath: '/tmp/mars-list-test/.mars/obs.db',
  stateDbPath: '/tmp/mars-list-test/.mars/state.db',
}

/** Minimal fake daemon — `list` never contacts the daemon. */
const fakeDaemon = {
  sendRequest: async () => ({}),
}

interface Call {
  status: TaskStatus | undefined
  limit: number | undefined
}

/**
 * Build a fake store that records what `listTasksPaged` was called with and
 * returns a canned list of task rows whose status matches the filter.
 */
const makeStore = (): { store: DomainTaskStore; calls: Call[] } => {
  const calls: Call[] = []
  const store = {
    listTasksPaged: async (status: TaskStatus | undefined, limit: number | undefined) => {
      calls.push({ status, limit })
      const tasks =
        status === undefined
          ? [
              { id: 'mars-any-1', status: 'done', priority: 1, prompt: 'any task' },
              { id: 'mars-any-2', status: 'failed', priority: 0, prompt: 'another task' },
            ]
          : [{ id: `mars-${status}-1`, status, priority: 0, prompt: `a ${status} task` }]
      return { tasks, total: tasks.length }
    },
  } as unknown as DomainTaskStore

  return { store, calls }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mars list --status <x> (flag form)', () => {
  it('accepts --status failed and passes the status to the store', async () => {
    const { store, calls } = makeStore()
    const r = await runCommandInProcess(['list', '--status', 'failed'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('failed')
    // Only failed tasks in output
    expect(r.out.some((line) => line.includes('mars-failed-1'))).toBe(true)
  })

  it('accepts --status done and passes done to the store', async () => {
    const { store, calls } = makeStore()
    const r = await runCommandInProcess(['list', '--status', 'done'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(0)
    expect(calls[0].status).toBe('done')
  })

  it('--status flag is combined with --limit correctly', async () => {
    const { store, calls } = makeStore()
    const r = await runCommandInProcess(['list', '--status', 'queued', '--limit', '3'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(0)
    expect(calls[0].status).toBe('queued')
    expect(calls[0].limit).toBe(3)
  })
})

describe('mars list <status> (positional form — unchanged behaviour)', () => {
  it('accepts positional "failed" and passes the status to the store', async () => {
    const { store, calls } = makeStore()
    const r = await runCommandInProcess(['list', 'failed'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(0)
    expect(calls[0].status).toBe('failed')
  })

  it('no status argument returns all tasks', async () => {
    const { store, calls } = makeStore()
    const r = await runCommandInProcess(['list'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(0)
    expect(calls[0].status).toBeUndefined()
  })
})

describe('mars list --status and positional form used simultaneously', () => {
  it('same value in both forms is accepted (no conflict)', async () => {
    const { store, calls } = makeStore()
    const r = await runCommandInProcess(['list', '--status', 'failed', 'failed'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(0)
    expect(calls[0].status).toBe('failed')
  })

  it('different values in both forms exits 2 with a conflict message', async () => {
    const { store } = makeStore()
    const r = await runCommandInProcess(['list', '--status', 'done', 'failed'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('conflicting')
    expect(r.err.join('\n')).toContain('done')
    expect(r.err.join('\n')).toContain('failed')
  })
})

describe('mars list --status <bogus> (invalid value)', () => {
  it('exits 2 and lists valid statuses when --status flag has invalid value', async () => {
    const { store } = makeStore()
    const r = await runCommandInProcess(['list', '--status', 'bogus'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    expect(errText).toContain('bogus')
    // At least some of the valid statuses should appear
    expect(errText).toContain('failed')
    expect(errText).toContain('done')
    expect(errText).toContain('queued')
  })

  it('bogus positional status also exits 2 with valid statuses listed', async () => {
    const { store } = makeStore()
    const r = await runCommandInProcess(['list', 'notavalidstatus'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    expect(errText).toContain('notavalidstatus')
    expect(errText).toContain('failed')
  })
})

describe('usage string documents both forms', () => {
  it('the list command usage string documents both --status flag and positional forms', async () => {
    const { allCommands } = await import('./index')
    const listEntry = allCommands.find((c) => c.path === 'list')
    expect(listEntry).toBeDefined()
    expect(listEntry!.usage).toContain('--status')
    // Positional form: '<status>' should appear
    expect(listEntry!.usage).toContain('<status>')
  })
})

describe('mars list — failed rows show failure signature', () => {
  it('appends the failure signature for a failed task row', async () => {
    const store = {
      listTasksPaged: async () => ({
        tasks: [
          {
            id: 'mars-fail-abc',
            status: 'failed',
            priority: 2,
            prompt: 'some failing task',
            failureSignature: 'code:coder-exit-nonzero/unclassified',
          },
        ],
        total: 1,
      }),
    } as unknown as DomainTaskStore
    const r = await runCommandInProcess(['list', 'failed'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })
    expect(r.code).toBe(0)
    const line = r.out.find((l) => l.includes('mars-fail-abc'))
    expect(line).toBeDefined()
    expect(line).toContain('code:coder-exit-nonzero/unclassified')
  })

  it('does not append a signature for a done task', async () => {
    const store = {
      listTasksPaged: async () => ({
        tasks: [
          {
            id: 'mars-done-xyz',
            status: 'done',
            priority: 1,
            prompt: 'done task',
            failureSignature: null,
          },
        ],
        total: 1,
      }),
    } as unknown as DomainTaskStore
    const r = await runCommandInProcess(['list', 'done'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })
    expect(r.code).toBe(0)
    const line = r.out.find((l) => l.includes('mars-done-xyz'))
    expect(line).toBeDefined()
    // No signature bracket appended
    expect(line).not.toContain('[')
  })

  it('does not append a signature when failureSignature is null on a failed task', async () => {
    const store = {
      listTasksPaged: async () => ({
        tasks: [
          {
            id: 'mars-fail-nosig',
            status: 'failed',
            priority: 0,
            prompt: 'failed with no sig',
            failureSignature: null,
          },
        ],
        total: 1,
      }),
    } as unknown as DomainTaskStore
    const r = await runCommandInProcess(['list', 'failed'], {
      store,
      ctx: fakeCtx,
      daemon: fakeDaemon,
    })
    expect(r.code).toBe(0)
    const line = r.out.find((l) => l.includes('mars-fail-nosig'))
    expect(line).toBeDefined()
    expect(line).not.toContain('[')
  })
})
