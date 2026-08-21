/**
 * Tests for the ADR-0099 breadth column on `mars enrich list` / `listEnrichments`
 * (PRD 1e904a61, slice 8: "Surface breadth counts on gate enrichments").
 *
 * A gate promoted off a single motivating failure looks identical to a
 * well-formed rule until an operator can see how many past task failures it
 * would have caught — {@link import('../matcher-breadth').wouldHaveFiredOnMany}
 * answers that. This slice wires the answer into `EnrichmentListEntry` and the
 * `mars enrich list` renderer (text and `--json`).
 *
 * DB-consistency note: `listEnrichments` takes an explicit `client` param, but
 * internally calls `wouldHaveFiredOnMany`, which resolves its OWN client via
 * `resolveStateClient()`. The two only land on the same underlying PGlite
 * instance when both resolve through the same `MARS_REPO`-derived target — so,
 * like `matcher-breadth.test.ts`, this file sets `MARS_REPO` explicitly and
 * resolves every client (`resolveStateClient()` / `resolveQueueClient()`)
 * fresh after `vi.resetModules()`, rather than using the `getTestDb()` fixture
 * (which opens an isolated, differently-keyed PGlite instance and would make
 * `wouldHaveFiredOnMany` see an empty `tasks` table).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'

/** A registered ENCODABLE signature (FailureKind facet: command family). */
const ENCODABLE_SIG = 'verify:typecheck/typecheck-cannot-find-name'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-gate-enrichment-breadth-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let seq = 0
const nextId = (): string => `task-${(seq += 1)}`

/** Inserts a `failed` task with the given signature, freshly `updated_at`. */
const seedFailedTask = async (client: DbClient, failureSignature: string): Promise<void> => {
  const id = nextId()
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
          VALUES (?, ?, 'failed', ?, ?, ?)`,
    args: [id, `task ${id}`, failureSignature, now, now],
  })
}

describe('gate-enrichment breadth (ADR-0099)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.restoreAllMocks()
    rmSync(repo, { recursive: true, force: true })
  })

  it('listEnrichments populates breadth from past task failures sharing the signature', async () => {
    const { resolveStateClient } = await import('../../store/state-client.js')
    const { ensureSchema } = await import('../pg-schema.js')
    const client = resolveStateClient()
    await ensureSchema(client)

    const {
      observeFailureSignature,
      listEnrichments,
      resetGateEnrichmentSchemaLatchForTests,
    } = await import('../gate-enrichment.js')
    resetGateEnrichmentSchemaLatchForTests()

    // Two exact matches, one differently-worded same-family match.
    await seedFailedTask(client, ENCODABLE_SIG)
    await seedFailedTask(client, ENCODABLE_SIG)
    await seedFailedTask(client, 'verify:typecheck-strict/typecheck-cannot-find-name')
    // An unrelated signature must not pollute the count.
    await seedFailedTask(client, 'verify:lint/lint-unused-var')

    await observeFailureSignature(client, {
      signature: ENCODABLE_SIG,
      originTaskId: 'origin-1',
      errorOutput: 'TS2304: Cannot find name x',
    })

    const entries = await listEnrichments(client)
    const entry = entries.find((e) => e.signature === ENCODABLE_SIG)
    expect(entry).toBeDefined()
    expect(entry?.breadth).toEqual({
      exact: 2,
      family: 3,
      windowDays: 30,
    })
  })

  it('a signature unseen in task history renders 0/0 breadth, not a crash', async () => {
    const { resolveStateClient } = await import('../../store/state-client.js')
    const { ensureSchema } = await import('../pg-schema.js')
    const client = resolveStateClient()
    await ensureSchema(client)

    const {
      observeFailureSignature,
      listEnrichments,
      resetGateEnrichmentSchemaLatchForTests,
    } = await import('../gate-enrichment.js')
    resetGateEnrichmentSchemaLatchForTests()

    await observeFailureSignature(client, {
      signature: ENCODABLE_SIG,
      originTaskId: 'origin-1',
      errorOutput: 'TS2304: Cannot find name x',
    })

    const entries = await listEnrichments(client)
    const entry = entries.find((e) => e.signature === ENCODABLE_SIG)
    expect(entry?.breadth).toEqual({ exact: 0, family: 0, windowDays: 30 })
  })

  it('mars enrich list renders the exact/family breadth column for a seeded enrichment', async () => {
    const { resolveQueueClient } = await import('../../queue.js')
    const { ensureSchema } = await import('../pg-schema.js')
    const client = resolveQueueClient()
    await ensureSchema(client)

    const { observeFailureSignature, resetGateEnrichmentSchemaLatchForTests } = await import(
      '../gate-enrichment.js'
    )
    resetGateEnrichmentSchemaLatchForTests()

    await seedFailedTask(client, ENCODABLE_SIG)
    await seedFailedTask(client, ENCODABLE_SIG)
    await seedFailedTask(client, 'verify:typecheck-strict/typecheck-cannot-find-name')

    await observeFailureSignature(client, {
      signature: ENCODABLE_SIG,
      originTaskId: 'origin-1',
      errorOutput: 'TS2304: Cannot find name x',
    })

    const { runCommandInProcess, makeFakeDaemon } = await import('../../../cli/test-adapter.js')
    const { createTaskStore } = await import('../../store/task-store.js')
    const { resolveContext } = await import('../../context.js')

    const result = await runCommandInProcess(['enrich', 'list'], {
      store: createTaskStore(client),
      daemon: makeFakeDaemon(),
      ctx: resolveContext(repo),
    })

    expect(result.code).toBe(0)
    const line = result.out.find((l) => l.includes(ENCODABLE_SIG))
    expect(line).toBeDefined()
    expect(line).toContain('breadth=2/3')
  })

  it('mars enrich list --json includes the breadth object verbatim', async () => {
    const { resolveQueueClient } = await import('../../queue.js')
    const { ensureSchema } = await import('../pg-schema.js')
    const client = resolveQueueClient()
    await ensureSchema(client)

    const { observeFailureSignature, resetGateEnrichmentSchemaLatchForTests } = await import(
      '../gate-enrichment.js'
    )
    resetGateEnrichmentSchemaLatchForTests()

    await seedFailedTask(client, ENCODABLE_SIG)

    await observeFailureSignature(client, {
      signature: ENCODABLE_SIG,
      originTaskId: 'origin-1',
      errorOutput: 'TS2304: Cannot find name x',
    })

    const { runCommandInProcess, makeFakeDaemon } = await import('../../../cli/test-adapter.js')
    const { createTaskStore } = await import('../../store/task-store.js')
    const { resolveContext } = await import('../../context.js')

    const result = await runCommandInProcess(['enrich', 'list', '--json'], {
      store: createTaskStore(client),
      daemon: makeFakeDaemon(),
      ctx: resolveContext(repo),
    })

    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.out.join('\n')) as Array<{
      signature: string
      breadth: { exact: number; family: number; windowDays: number }
    }>
    const entry = parsed.find((e) => e.signature === ENCODABLE_SIG)
    expect(entry?.breadth).toEqual({ exact: 1, family: 1, windowDays: 30 })
  })
})
