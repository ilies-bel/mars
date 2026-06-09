/**
 * Command-seam tests for `mars diagnose run` and `mars diagnose investigate`.
 *
 * Both verbs send an RPC request to the daemon (op 'diagnose-failure' and
 * 'investigate' respectively) and print the returned text payload to stdout.
 * These tests exercise the command layer through the public interface
 * (runCommandInProcess + makeFakeDaemon) — no real daemon, no process.exit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import type { InProcessOptions } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-diagnose-rpc-test-'))
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

const baseOpts = async (): Promise<InProcessOptions> => {
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: makeFakeDaemon() }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('mars diagnose run', () => {
  it('sends op=diagnose-failure with the task id and prints the diagnosis', async () => {
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'diagnose-failure') {
        return { diagnosis: 'The npm install step timed out due to a stale lockfile.' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['diagnose', 'run', 'mars-abc123'], {
      store,
      ctx,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'diagnose-failure', id: 'mars-abc123' })
    expect(r.out.join('\n')).toContain('npm install step timed out')
  })

  it('rejects missing task-id with code 2 and usage', async () => {
    const r = await runCommandInProcess(['diagnose', 'run'], await baseOpts())
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars diagnose run')
  })

  it('reports daemon errors on stderr with code 1', async () => {
    const fake = makeFakeDaemon(() => {
      throw new Error('daemon not running')
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(['diagnose', 'run', 'mars-fail'], {
      store,
      ctx,
      daemon: fake,
    })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
  })
})

describe('mars diagnose investigate', () => {
  it('sends op=investigate with the task id and prints the explanation', async () => {
    const fake = makeFakeDaemon((req) => {
      if (req.op === 'investigate') {
        return { explanation: 'The task was adding a CLI flag to the diagnose command.' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['diagnose', 'investigate', 'mars-xyz789'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'investigate', id: 'mars-xyz789' })
    expect(r.out.join('\n')).toContain('adding a CLI flag')
  })

  it('rejects missing task-id with code 2 and usage', async () => {
    const r = await runCommandInProcess(
      ['diagnose', 'investigate'],
      await baseOpts(),
    )
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage: mars diagnose investigate')
  })

  it('reports daemon errors on stderr with code 1', async () => {
    const fake = makeFakeDaemon(() => {
      throw new Error('worktree gone')
    })
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['diagnose', 'investigate', 'mars-gone'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('worktree gone')
  })
})

describe('mars diagnose group fallback', () => {
  it('shows usage mentioning all four subcommands when bare diagnose is called', async () => {
    const r = await runCommandInProcess(['diagnose'], await baseOpts())
    expect(r.code).toBe(1)
    const usage = r.err.join('\n')
    expect(usage).toContain('run')
    expect(usage).toContain('investigate')
    expect(usage).toContain('set')
    expect(usage).toContain('show')
  })
})
