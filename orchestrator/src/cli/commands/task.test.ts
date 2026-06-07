/**
 * Tests for the `--intent` flag on `mars task add` (slice mars-855b3e1a).
 *
 * Covers two paths:
 *   1. Explicit `--intent <text>` — forwarded verbatim (trimmed, capped at 200).
 *   2. No `--intent` — first sentence of the prompt is derived by the CLI and
 *      forwarded to the daemon (no LLM involvement).
 *
 * Uses the in-process command seam (ADR-0023) with a recording fake daemon so
 * the test asserts on the value the CLI sends to the daemon, not on DB state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Helpers shared with command-seam tests
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/commands -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (args: readonly string[], env?: Record<string, string>): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-task-intent-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadStoreAndCtx = async (): Promise<{ store: DomainTaskStore; ctx: OrchestratorContext }> => {
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
  daemonResponder?: Parameters<typeof makeFakeDaemon>[0],
): Promise<InProcessOptions> => {
  const fake = makeFakeDaemon(daemonResponder)
  const { store, ctx } = await loadStoreAndCtx()
  return { store, ctx, daemon: fake }
}

beforeEach(() => {
  repo = setupRepo()
})
afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// --help surface
// ---------------------------------------------------------------------------

describe('mars task add --help', () => {
  it('lists the --intent flag', () => {
    const r = runCli(['task', 'add', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--intent')
  })
})

// ---------------------------------------------------------------------------
// Explicit --intent flag
// ---------------------------------------------------------------------------

describe('task add --intent (explicit)', () => {
  it('forwards the supplied intent to the daemon verbatim', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-abcd', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', '--intent', 'rename foo to bar', 'long prompt body that is irrelevant to intent'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    const req = fake.calls[0]
    expect(req).toMatchObject({ op: 'add', intent: 'rename foo to bar' })
  })

  it('trims leading/trailing whitespace from an explicit --intent', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-abcd', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(
      ['task', 'add', '--intent', '  trimmed  ', 'some prompt'],
      { store, ctx, daemon: fake },
    )
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe('trimmed')
  })
})

// ---------------------------------------------------------------------------
// Default derivation — first sentence of prompt
// ---------------------------------------------------------------------------

describe('task add intent derivation (no --intent flag)', () => {
  it('derives intent from the first sentence (dot terminator)', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-1234', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    const r = await runCommandInProcess(
      ['task', 'add', 'Fix the slicer. Then verify it.'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe('Fix the slicer.')
  })

  it('derives intent from the first sentence (exclamation terminator)', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-5678', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(
      ['task', 'add', 'Do the thing! Then clean up.'],
      { store, ctx, daemon: fake },
    )
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe('Do the thing!')
  })

  it('falls back to the full prompt when no sentence boundary is found', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'mars-task-9999', status: 'queued' }))
    const { store, ctx } = await loadStoreAndCtx()
    await runCommandInProcess(
      ['task', 'add', 'No terminator here so take the whole thing'],
      { store, ctx, daemon: fake },
    )
    const req = fake.calls[0]
    expect((req as { intent?: string }).intent).toBe(
      'No terminator here so take the whole thing',
    )
  })
})
