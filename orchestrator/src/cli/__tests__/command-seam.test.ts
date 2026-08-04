/**
 * In-process Command-seam tests (ADR-0023).
 *
 * These exercise commands through `runCommandInProcess` — NO spawned binary,
 * NO process.exit. A temp-file-backed TaskStore (the real ADR-0021 store over a
 * fresh `.mars/mars.db`) and a recording fake daemon-client are injected; each
 * test asserts on the returned `CommandResult` (code/value) and the captured
 * stdout/stderr lines.
 *
 * This is the payoff the seam was built for: the logic-heavy ladder-bearing
 * commands (`task add`, `task priority`, `proposal …`, `glossary …`) are now
 * testable without shelling out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import type { DaemonRequest } from '../../core/daemon/protocol'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-cmd-seam-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Build a real temp-file store bound to `repo` and a context pointing at it.
 * The store's domain methods resolve their client from MARS_REPO (set here),
 * exactly as the composition root does in production.
 */
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

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('routing', () => {
  it('routes a two-token leaf (`task add`) over the one-token group', async () => {
    const fake = makeFakeDaemon((req) =>
      req.op === 'add' ? { id: 'mars-task-abcd', status: 'queued' } : {},
    )
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['task', 'add', 'do the thing'], {
      store,
      ctx,
      daemon: fake,
    })
    expect(r.code).toBe(0)
    expect(r.unknown).toBeUndefined()
    expect(fake.calls[0]?.op).toBe('add')
  })

  it('falls back to the group fallback for a bare ladder command', async () => {
    const r = await runCommandInProcess(['task'], await baseOpts())
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars task <add|show|priority|note|check>')
  })

  it('returns unknown for a command not in the registry', async () => {
    const r = await runCommandInProcess(['definitely-not-a-command'], await baseOpts())
    expect(r.unknown).toBe(true)
    expect(r.code).toBe(1)
  })
})

describe('task add (daemon-routed)', () => {
  it('forwards prompt + skipTriage to the daemon and prints the queued line', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-1234', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['task', 'add', 'ship the seam'], {
      store,
      ctx,
      daemon: fake,
    })
    expect(r.code).toBe(0)
    const addCall = fake.calls[0]
    expect(addCall).toMatchObject({ op: 'add', prompt: 'ship the seam', skipTriage: true })
    expect(r.out.join('\n')).toContain('queued mars-task-1234')
  })

  it('rejects an empty prompt with code 2 and a usage line', async () => {
    const r = await runCommandInProcess(['task', 'add'], await baseOpts())
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars task add')
  })

  it('rejects an out-of-range --priority before touching the daemon', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'x', '--priority', '9'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain("priority must be an integer in 0..3")
    expect(fake.calls).toHaveLength(0)
  })

  it('builds a structured spec from --files/--verify/--done/--merge', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-9999', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      [
        'task', 'add', 'structured',
        '--files', 'a.ts',
        '--done', 'compiles',
        '--verify', 'npm test',
        '--merge', 'gated',
      ],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(fake.calls[0]).toMatchObject({
      op: 'add',
      spec: {
        files: ['a.ts'],
        verifyCmd: 'npm test',
        doneCriteria: ['compiles'],
        mergeMode: 'gated',
      },
    })
  })

  it('rejects the retired --type flag instead of treating it as prompt text', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'structured', '--type', 'auto'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('unknown flag --type')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('task show / list (store-backed reads)', () => {
  it('shows a task enqueued directly into the injected store', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('read me back', undefined, {
      skipTriage: true,
    })
    const r = await runCommandInProcess(['task', 'show', task.id], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toContain(`id:         ${task.id}`)
    expect(text).toContain('read me back')
  })

  it('reports a missing task with code 1', async () => {
    const r = await runCommandInProcess(
      ['task', 'show', 'mars-task-nope'],
      await baseOpts(),
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no task matching mars-task-nope')
  })

  it('lists tasks present in the injected store', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    await store.enqueueTask('alpha task', undefined, { skipTriage: true })
    await store.enqueueTask('beta task', undefined, { skipTriage: true })
    const r = await runCommandInProcess(['list'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toContain('alpha task')
    expect(text).toContain('beta task')
  })

  it('shows workflow: line when task has a workflow set', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('live task', undefined, {
      skipTriage: true,
      workflow: 'live',
    })
    const r = await runCommandInProcess(['task', 'show', task.id], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toContain('workflow:   live')
  })

  it('omits workflow: line when task has no workflow', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('no-workflow task', undefined, {
      skipTriage: true,
    })
    const r = await runCommandInProcess(['task', 'show', task.id], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).not.toContain('workflow:')
  })

  it('outputs valid JSON with workflow field when --json flag is passed', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('json task', undefined, {
      skipTriage: true,
      workflow: 'live',
    })
    const r = await runCommandInProcess(['task', 'show', task.id, '--json'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out.join('\n')) as Record<string, unknown>
    expect(parsed['id']).toBe(task.id)
    expect(parsed['workflow']).toBe('live')
  })

  it('JSON output omits null workflow when task has no workflow set', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const task = await store.enqueueTask('no-workflow json task', undefined, {
      skipTriage: true,
    })
    const r = await runCommandInProcess(['task', 'show', task.id, '--json'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out.join('\n')) as Record<string, unknown>
    expect(parsed['id']).toBe(task.id)
    expect(parsed['workflow']).toBeNull()
  })

  it('always renders a priority column (P0 for default, Pn for explicit)', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    await store.enqueueTask('default prio task', undefined, { skipTriage: true })
    await store.enqueueTask('high prio task', undefined, { skipTriage: true, priority: 3 })
    const r = await runCommandInProcess(['list'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const lines = r.out
    const defaultLine = lines.find((l) => l.includes('default prio task'))
    const highLine = lines.find((l) => l.includes('high prio task'))
    expect(defaultLine).toContain('P0')
    expect(highLine).toContain('P3')
  })

  it('defaults to 10 rows and prints total count when more tasks exist', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    for (let i = 0; i < 12; i++) {
      await store.enqueueTask(`task ${i}`, undefined, { skipTriage: true })
    }
    const r = await runCommandInProcess(['list'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const taskLines = r.out.filter((l) => l.includes('\t'))
    expect(taskLines).toHaveLength(10)
    const summary = r.out.join('\n')
    expect(summary).toContain('10 of 12')
  })

  it('shows total count without truncation hint when all tasks fit', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    await store.enqueueTask('only task', undefined, { skipTriage: true })
    const r = await runCommandInProcess(['list'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const summary = r.out.join('\n')
    expect(summary).toContain('1 task total')
    expect(summary).not.toContain('of ')
  })

  it('filters by status when status arg is given', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    await store.enqueueTask('queued task', undefined, { skipTriage: true })
    const r = await runCommandInProcess(['list', 'queued'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toContain('queued task')
    expect(text).toContain('queued')
  })

  it('rejects an unknown status with exit code 2', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['list', 'bogus-status'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain("unknown status 'bogus-status'")
  })

  it('--limit overrides the default cap', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    for (let i = 0; i < 5; i++) {
      await store.enqueueTask(`limit task ${i}`, undefined, { skipTriage: true })
    }
    const r = await runCommandInProcess(['list', '--limit', '2'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const taskLines = r.out.filter((l) => l.includes('\t'))
    expect(taskLines).toHaveLength(2)
    const summary = r.out.join('\n')
    expect(summary).toContain('2 of 5')
  })

  it('--all returns every task regardless of count', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    for (let i = 0; i < 15; i++) {
      await store.enqueueTask(`all task ${i}`, undefined, { skipTriage: true })
    }
    const r = await runCommandInProcess(['list', '--all'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const taskLines = r.out.filter((l) => l.includes('\t'))
    expect(taskLines).toHaveLength(15)
    const summary = r.out.join('\n')
    expect(summary).toContain('15 tasks total')
  })

  it('--limit validates that value is a positive integer', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['list', '--limit', 'abc'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('--limit must be a positive integer')
  })

  it('rejects a non-positive --limit value with code 2', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['list', '--limit', '0'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('--limit must be a positive integer')
  })

  it('--status flag form filters tasks by status', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    await store.enqueueTask('queued task via flag', undefined, { skipTriage: true })
    const r = await runCommandInProcess(['list', '--status', 'queued'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toContain('queued task via flag')
    expect(text).toContain('queued')
  })

  it('--status flag form rejects an unknown status with exit code 2', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['list', '--status', 'bogus-status'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain("unknown status 'bogus-status'")
    expect(r.err.join('\n')).toContain('valid values:')
  })

  it('conflicting --status flag and positional with different values exits 2', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['list', '--status', 'failed', 'queued'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('conflicting status values')
    expect(r.err.join('\n')).toContain('failed')
    expect(r.err.join('\n')).toContain('queued')
  })

  it('--status and positional with the same value is accepted', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    await store.enqueueTask('queued task same form', undefined, { skipTriage: true })
    const r = await runCommandInProcess(['list', '--status', 'queued', 'queued'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('queued task same form')
  })
})

describe('task priority (daemon-routed mutation)', () => {
  it('validates the value locally, then forwards to the daemon', async () => {
    const fake = makeFakeDaemon((req) =>
      req.op === 'task.priority' ? { id: req.id, priority: req.priority } : {},
    )
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'priority', 'mars-task-7', '2'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(fake.calls[0]).toMatchObject({ op: 'task.priority', id: 'mars-task-7', priority: 2 })
    expect(r.out.join('\n')).toContain('set priority of mars-task-7 to 2')
  })

  it('rejects a non-0..3 value with no daemon call', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'priority', 'mars-task-7', '5'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(2)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('glossary (transport varies per-subcommand)', () => {
  it('`glossary set` is daemon-routed', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['glossary', 'set', 'Seam', 'an injectable boundary'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(fake.calls[0]).toMatchObject({
      op: 'glossary-write',
      kind: 'set',
      term: 'Seam',
      definition: 'an injectable boundary',
    })
    expect(r.out.join('\n')).toContain('glossary set dispatched: "Seam"')
  })

  it('`glossary list` is a local read (no daemon call)', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['glossary', 'list'], {
      store,
      ctx,
      daemon: fake,
    })
    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(0)
    expect(r.out.join('\n')).toContain('(no glossary terms')
  })
})

describe('worker (store-dir-backed)', () => {
  it('`worker add` writes the registry and `worker list` reads it back', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const add = await runCommandInProcess(
      ['worker', 'add', 'SeamWorker', '--model', 'claude-sonnet-4-6'],
      { store, ctx, daemon: makeFakeDaemon() },
    )
    expect(add.code).toBe(0)
    expect(add.out.join('\n')).toContain('added worker SeamWorker')

    const list = await runCommandInProcess(['worker', 'list'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(list.code).toBe(0)
    expect(list.out.join('\n')).toContain('SeamWorker')
  })

  it('`worker` with an unknown subcommand returns code 2', async () => {
    const r = await runCommandInProcess(['worker', 'bogus'], await baseOpts())
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars worker')
  })
})

describe('where (pure pass-through over ctx)', () => {
  it('prints the resolved repo + state paths', async () => {
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['where'], {
      store,
      ctx,
      daemon: makeFakeDaemon(),
    })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`repo:           ${ctx.repoRoot}`)
  })
})

// ---------------------------------------------------------------------------
// mars show — alert fallback
// ---------------------------------------------------------------------------

describe('mars show (alert fallback)', () => {
  const FAKE_PORT = 19999

  const makeAlertRow = (
    overrides: Partial<ActionQueueRow> & Pick<ActionQueueRow, 'id'>,
  ): ActionQueueRow => ({
    kind: 'failed-task',
    entityId: `entity-${overrides.id}`,
    priority: 'normal',
    title: `Title for ${overrides.id}`,
    body: `Body for ${overrides.id}`,
    at: '2026-01-01T00:00:00.000Z',
    dag: null,
    errorKind: 'unknown',
    actions: [],
    staleWorktreeDetail: null,
    devServerUrl: null,
    leaseState: null,
    diagnosis: null,
    failureReasonCode: null,
    humanSummary: 'Test alert',
    humanDetail: {},
    verbs: [],
    ...overrides,
  } as ActionQueueRow)

  it('renders alert detail and returns code 0 when the id matches an action-queue alert', async () => {
    const alertRow = makeAlertRow({
      id: 'aq-show-seam-01',
      entityId: 'mars-task-seam-01',
      kind: 'failed-task',
      priority: 'high',
      title: 'Seam alert title',
      body: 'Seam alert body text',
      at: '2026-03-01T12:00:00.000Z',
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [alertRow],
    }))
    writeFileSync(join(repo, '.mars', 'http.port'), String(FAKE_PORT))
    const opts = await baseOpts()

    const r = await runCommandInProcess(['show', 'aq-show-seam-01'], opts)

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('id:        aq-show-seam-01')
    expect(out).toContain('title:     Seam alert title')
    expect(out).toContain('kind:      failed-task')
    expect(out).toContain('entity:    mars-task-seam-01')
    expect(out).toContain('priority:  high')
    expect(out).toContain('at:        2026-03-01T12:00:00.000Z')
    expect(out).toContain('Seam alert body text')
  })

  it('returns code 1 with updated error when id matches no task, proposal, or alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }))
    writeFileSync(join(repo, '.mars', 'http.port'), String(FAKE_PORT))
    const opts = await baseOpts()

    const r = await runCommandInProcess(['show', 'mars-nope-zz99'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no task, proposal, or alert matching mars-nope-zz99')
  })

  it('still returns code 1 with updated error when daemon is not running (port file absent)', async () => {
    // No http.port written — daemon not running.
    const opts = await baseOpts()

    const r = await runCommandInProcess(['show', 'mars-nope-nodaemon'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no task, proposal, or alert matching mars-nope-nodaemon')
  })
})
