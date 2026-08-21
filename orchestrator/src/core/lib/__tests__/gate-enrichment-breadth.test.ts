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
 * resolves its client after `vi.resetModules()`, rather than using the
 * `getTestDb()` fixture (which opens an isolated, differently-keyed PGlite
 * instance and would make `wouldHaveFiredOnMany` see an empty `tasks` table).
 *
 * Cost note: the reset + repo + import happens ONCE for the whole file
 * (`beforeAll`), not per test. Each test here would otherwise pay a PGlite
 * cold start (5-25 s under the parallel-verify load the suite is tuned for,
 * see vitest.config.ts) and — for the two CLI tests — a cold re-import of the
 * entire `mars` command registry, which is what pushed this file past the
 * 30 s per-test budget on the merge gate. Sharing one instance is safe
 * because breadth is counted per signature: every test seeds its own
 * signature in its own family, so no test can perturb another's counts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'
import type { listEnrichments as ListEnrichments } from '../gate-enrichment.js'
import type { observeFailureSignature as ObserveFailureSignature } from '../gate-enrichment.js'
import type { runCommandInProcess as RunCommandInProcess } from '../../../cli/test-adapter.js'

/**
 * One signature per test, each in its own family, so the shared DB cannot
 * leak counts between tests. Family = `<gate>/<error-class>` (see
 * `failureSignatureFamilySql`), so these five families are all distinct.
 */
const SIG_LIST = 'verify:typecheck/typecheck-cannot-find-name'
const SIG_LIST_SIBLING = 'verify:typecheck-strict/typecheck-cannot-find-name'
const SIG_UNRELATED = 'verify:lint/lint-unused-var'
const SIG_UNSEEN = 'merge:preflight/uncommitted-changes'
const SIG_RENDER = 'verify:has-diff/no-commits-ahead'
const SIG_RENDER_SIBLING = 'verify:has-diff-strict/no-commits-ahead'
const SIG_JSON = 'verify:worktree-hygiene/worktree-missing'

let seq = 0
const nextId = (): string => `task-${(seq += 1)}`

let repo: string
let client: DbClient
let listEnrichments: typeof ListEnrichments
let observeFailureSignature: typeof ObserveFailureSignature
let runCommandInProcess: typeof RunCommandInProcess
let cliDeps: Parameters<typeof RunCommandInProcess>[1]

/** Inserts a `failed` task with the given signature, freshly `updated_at`. */
const seedFailedTask = async (failureSignature: string): Promise<void> => {
  const id = nextId()
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
          VALUES (?, ?, 'failed', ?, ?, ?)`,
    args: [id, `task ${id}`, failureSignature, now, now],
  })
}

describe('gate-enrichment breadth (ADR-0099)', () => {
  beforeAll(async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-gate-enrichment-breadth-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })

    vi.resetModules()
    process.env.MARS_REPO = repo

    const { resolveStateClient } = await import('../../store/state-client.js')
    const { ensureSchema } = await import('../pg-schema.js')
    client = resolveStateClient()
    await ensureSchema(client)

    const gateEnrichment = await import('../gate-enrichment.js')
    gateEnrichment.resetGateEnrichmentSchemaLatchForTests()
    listEnrichments = gateEnrichment.listEnrichments
    observeFailureSignature = gateEnrichment.observeFailureSignature

    const testAdapter = await import('../../../cli/test-adapter.js')
    const { createTaskStore } = await import('../../store/task-store.js')
    const { resolveContext } = await import('../../context.js')
    runCommandInProcess = testAdapter.runCommandInProcess
    cliDeps = {
      store: createTaskStore(client),
      daemon: testAdapter.makeFakeDaemon(),
      ctx: resolveContext(repo),
    }
  }, 120_000)

  afterAll(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('listEnrichments populates breadth from past task failures sharing the signature', async () => {
    // Two exact matches, one differently-worded same-family match.
    await seedFailedTask(SIG_LIST)
    await seedFailedTask(SIG_LIST)
    await seedFailedTask(SIG_LIST_SIBLING)
    // An unrelated signature must not pollute the count.
    await seedFailedTask(SIG_UNRELATED)

    await observeFailureSignature(client, {
      signature: SIG_LIST,
      originTaskId: 'origin-list',
      errorOutput: 'TS2304: Cannot find name x',
    })

    const entries = await listEnrichments(client)
    const entry = entries.find((e) => e.signature === SIG_LIST)
    expect(entry).toBeDefined()
    expect(entry?.breadth).toEqual({
      exact: 2,
      family: 3,
      windowDays: 30,
    })
  }, 60_000)

  it('a signature unseen in task history renders 0/0 breadth, not a crash', async () => {
    await observeFailureSignature(client, {
      signature: SIG_UNSEEN,
      originTaskId: 'origin-unseen',
      errorOutput: 'integration branch has uncommitted changes',
    })

    const entries = await listEnrichments(client)
    const entry = entries.find((e) => e.signature === SIG_UNSEEN)
    expect(entry?.breadth).toEqual({ exact: 0, family: 0, windowDays: 30 })
  }, 60_000)

  it('mars enrich list renders the exact/family breadth column for a seeded enrichment', async () => {
    await seedFailedTask(SIG_RENDER)
    await seedFailedTask(SIG_RENDER)
    await seedFailedTask(SIG_RENDER_SIBLING)

    await observeFailureSignature(client, {
      signature: SIG_RENDER,
      originTaskId: 'origin-render',
      errorOutput: 'task branch has no commits ahead of integration',
    })

    const result = await runCommandInProcess(['enrich', 'list'], cliDeps)

    expect(result.code).toBe(0)
    const line = result.out.find((l) => l.includes(SIG_RENDER))
    expect(line).toBeDefined()
    expect(line).toContain('breadth=2/3')
  }, 60_000)

  it('mars enrich list --json includes the breadth object verbatim', async () => {
    await seedFailedTask(SIG_JSON)

    await observeFailureSignature(client, {
      signature: SIG_JSON,
      originTaskId: 'origin-json',
      errorOutput: 'task worktree was pruned before verify could run',
    })

    const result = await runCommandInProcess(['enrich', 'list', '--json'], cliDeps)

    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.out.join('\n')) as Array<{
      signature: string
      breadth: { exact: number; family: number; windowDays: number }
    }>
    const entry = parsed.find((e) => e.signature === SIG_JSON)
    expect(entry?.breadth).toEqual({ exact: 1, family: 1, windowDays: 30 })
  }, 60_000)
})
