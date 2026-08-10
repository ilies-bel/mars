/**
 * Exit-code contract regression tests.
 *
 * These two cases are the critical sides to distinguish:
 *
 *   (a) THROW path — a command throws an unhandled error (e.g. the database
 *       is unreachable / schema drifted). The process must exit non-zero and
 *       print `error: <message>` to stderr. The production adapter catches in
 *       `cli.ts`; the test adapter mirrors that catch so tests can assert on
 *       the same observable.
 *
 *   (b) EMPTY-QUEUE path — `mars action-queue list open` reads a healthy but
 *       empty queue. This is a successful read, not an error, and MUST exit 0.
 *       CLAUDE.md documents "action queue empty (exit 0) means genuinely
 *       nothing pending"; this test locks that contract in.
 *
 * Both cases must live here together: they are the two sides of the signal
 * callers branch on. A regression on either side makes the empty/error
 * distinction meaningless.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string

const makeCtx = (dir: string): OrchestratorContext => ({
  repoRoot: dir,
  stateDir: join(dir, '.mars'),
  queueDbPath: join(dir, '.mars', 'queue.db'),
  observabilityDbPath: join(dir, '.mars', 'obs.db'),
  stateDbPath: join(dir, '.mars', 'state.db'),
})

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-exit-contract-'))
  mkdirSync(join(tmpDir, '.mars'), { recursive: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// (a) THROW path — any command throw must exit non-zero
// ---------------------------------------------------------------------------

describe('throw path → exit non-zero', () => {
  it('returns code 1 and emits error: <message> to stderr when the store throws', async () => {
    // Simulate a database whose schema is drifted: getTask rejects with the
    // same error shape observed in the 2026-08-10 incident.
    const throwingStore: DomainTaskStore = {
      getTask: () => Promise.reject(new Error('column "state" does not exist')),
    } as unknown as DomainTaskStore

    const r = await runCommandInProcess(['show', 'mars-fake-0001'], {
      store: throwingStore,
      ctx: makeCtx(tmpDir),
      daemon: makeFakeDaemon(),
    })

    // Non-zero exit — the caller must not treat this as a clean empty result.
    expect(r.code).toBe(1)
    // The error message must be surfaced on stderr with the `error: ` prefix
    // that matches the production cli.ts outer catch.
    expect(r.err.join('\n')).toContain('error: column "state" does not exist')
    // Nothing on stdout — the command produced no output before failing.
    expect(r.out).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (b) EMPTY-QUEUE path — a healthy empty queue must exit 0
// ---------------------------------------------------------------------------

describe('empty-queue path → exit 0', () => {
  it('mars action-queue list open exits 0 with "action queue empty" when daemon returns []', async () => {
    // Write the port file so the command knows the daemon is running.
    const FAKE_PORT = 29997
    writeFileSync(join(tmpDir, '.mars', 'http.port'), String(FAKE_PORT))

    // Daemon is reachable and returns an empty array — nothing pending.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }))

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], {
      store: {} as DomainTaskStore,
      ctx: makeCtx(tmpDir),
      daemon: makeFakeDaemon(),
    })

    // A clean empty queue is a success, not an error.
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('action queue empty')
    expect(r.err).toHaveLength(0)
  })
})
