/**
 * Tests for the Planner's Domain Flow authoring path (PRD cd54a867 extension).
 *
 * The Planner widens its JSON output to carry an optional `domainFlow` field.
 * When the field is present and non-empty the plan workflow persists a Domain
 * Flow row through the shared upsertFlow / getFlowByArcId store — the same
 * store the chat-agent path uses, with no second implementation.
 *
 * Covered cases:
 *   1. A plan run with a non-empty domainFlow in the worker output persists
 *      a Domain Flow readable via getFlowByArcId.
 *   2. A plan run for a change with no business-domain effect (domainFlow
 *      absent, or present with empty nodes) persists NO flow row.
 *   3. An invalid domainFlow payload is rejected by the shared schema before
 *      any DB write; runPlan rejects and no row is written.
 *
 * Infrastructure: PGlite (in-memory Postgres) so the real domain_flows table
 * is present; runWorkerWithSpan and createProposal are stubbed at the boundary.
 *
 * Trade-off note: the Planner carries the flow inside its parsed JSON output
 * (Option a) rather than calling a tool. The plan workflow persists it with a
 * single upsertFlow call — the same call path as the chat agent, validated by
 * the same domainFlowContentSchema.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── Module stubs (hoisted by vitest) ─────────────────────────────────────────
//
// Mock at the external-I/O boundary only: the worker subprocess and the
// proposal store. Everything else (the domain-flow store, the PGlite DB, the
// workflow engine) runs for real.

vi.mock('../../core/lib/run-worker-with-span', () => ({
  runWorkerWithSpan: vi.fn(),
}))

vi.mock('../../core/proposals', () => ({
  createProposal: vi.fn().mockResolvedValue(undefined),
}))

// getRepoRoot must not resolve a real repo root from the test's CWD.
vi.mock('../../core/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/context')>()
  return { ...actual, getRepoRoot: vi.fn().mockReturnValue('/tmp/fake-repo') }
})

// ── Imports that must come after vi.mock calls ────────────────────────────────

import { runWorkerWithSpan } from '../../core/lib/run-worker-with-span.js'

// ── PGlite fixture ────────────────────────────────────────────────────────────

let repo: string
let queueClient: import('../../core/lib/db.js').DbClient
let storeModule: typeof import('../../core/domain-flow/store.js')
let planModule: { runPlan: (taskId: string, refresh?: boolean) => Promise<unknown> }

beforeAll(async () => {
  // Create a temp git repo so MARS_REPO resolves to a temp dir (satisfies the
  // vitest hermetic-store guard in getDefaultTaskStore).
  repo = mkdtempSync(resolve(tmpdir(), 'mars-plan-df-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'

  // Run schema migrations (creates tasks, domain_flows, workflow_runs, etc.)
  // before importing the plan workflow so every module that resolves DB targets
  // at call time picks up the PGlite env.
  const { migrateQueueSchema, resolveQueueClient } = await import(
    '../../core/queue.js'
  )
  await migrateQueueSchema()
  queueClient = resolveQueueClient()

  // Reset the state-client singleton so it re-resolves against PGlite on the
  // next call to resolveStateClient() (which plan-workflow calls inside its
  // step to persist the Domain Flow).
  const { __resetStateClientForTests } = await import(
    '../../core/store/state-client.js'
  )
  __resetStateClientForTests()

  storeModule = await import('../../core/domain-flow/store.js')
  planModule = await import('../plan-workflow.js')
})

afterAll(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  rmSync(repo, { recursive: true, force: true })
})

// ── Per-test helpers ──────────────────────────────────────────────────────────

/** Insert a minimal tasks row so domain_flows.arc_id FK is satisfied. */
async function insertTask(id: string): Promise<void> {
  await queueClient.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES ($1, 'test task', 'queued', now(), now())`,
    args: [id],
  })
}

/** Delete a tasks row (cascades to domain_flows). */
async function deleteTask(id: string): Promise<void> {
  await queueClient.execute({
    sql: `DELETE FROM tasks WHERE id = $1`,
    args: [id],
  })
}

/** Build a mock worker result with the given JSON payload as stdout. */
function makeWorkerResult(output: unknown): {
  exitCode: number
  stdout: string
  stderr: string
  sessionId: null
  conversation: never[]
  quotaRejected: null
} {
  return {
    exitCode: 0,
    stdout: JSON.stringify(output),
    stderr: '',
    sessionId: null,
    conversation: [],
    quotaRejected: null,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('plan-workflow: Domain Flow authoring', () => {
  let arcId: string

  beforeEach(async () => {
    arcId = randomUUID()
    await insertTask(arcId)
  })

  afterEach(async () => {
    await deleteTask(arcId)
    vi.clearAllMocks()
  })

  // ── Case 1: flow is persisted ───────────────────────────────────────────────

  it('persists a Domain Flow readable via getFlowByArcId when the planner outputs one', async () => {
    vi.mocked(runWorkerWithSpan).mockResolvedValueOnce(
      makeWorkerResult({
        suggestions: [],
        domainFlow: {
          name: 'Billing cycle change',
          nodes: [
            {
              kind: 'event',
              name: 'BillingCycleStarted',
              description: 'A new billing period begins',
              pivotal: true,
            },
            {
              kind: 'policy',
              name: 'InvoicePolicy',
              description: 'Generate invoice on cycle start',
            },
          ],
        },
      }),
    )

    await planModule.runPlan(arcId)

    const flow = await storeModule.getFlowByArcId(queueClient, arcId)

    expect(flow).not.toBeNull()
    expect(flow!.arcId).toBe(arcId)
    expect(flow!.name).toBe('Billing cycle change')
    expect(flow!.nodes).toHaveLength(2)
    expect(flow!.nodes[0]).toMatchObject({
      kind: 'event',
      name: 'BillingCycleStarted',
      pivotal: true,
    })
    expect(flow!.nodes[1]).toMatchObject({
      kind: 'policy',
      name: 'InvoicePolicy',
    })
    expect(flow!.frozenAt).toBeNull()
  })

  // ── Case 2a: no domainFlow field → no artefact ─────────────────────────────

  it('persists no flow when the planner omits domainFlow entirely', async () => {
    vi.mocked(runWorkerWithSpan).mockResolvedValueOnce(
      makeWorkerResult({
        suggestions: [
          {
            title: 'Fix lint errors',
            prompt: 'Run eslint --fix on all changed files.',
            rationale: 'Chore — no domain impact.',
          },
        ],
        // domainFlow is absent
      }),
    )

    await planModule.runPlan(arcId)

    const flow = await storeModule.getFlowByArcId(queueClient, arcId)
    expect(flow).toBeNull()
  })

  // ── Case 2b: domainFlow with empty nodes → no artefact ─────────────────────

  it('persists no flow when the planner provides domainFlow with empty nodes', async () => {
    vi.mocked(runWorkerWithSpan).mockResolvedValueOnce(
      makeWorkerResult({
        suggestions: [],
        domainFlow: {
          name: 'Dependency bump',
          nodes: [], // explicitly empty — no domain effect
        },
      }),
    )

    await planModule.runPlan(arcId)

    const flow = await storeModule.getFlowByArcId(queueClient, arcId)
    expect(flow).toBeNull()
  })

  // ── Case 3: invalid payload rejected by shared schema, no write ────────────

  it('rejects an invalid domainFlow via the shared schema without writing any row', async () => {
    vi.mocked(runWorkerWithSpan).mockResolvedValueOnce(
      makeWorkerResult({
        suggestions: [],
        domainFlow: {
          name: 'Bad flow',
          nodes: [
            // 'unknown-kind' is not in the discriminated union → ZodError
            { kind: 'unknown-kind', name: 'Rogue node' },
          ],
        },
      }),
    )

    // runPlan wraps the step failure as "plan workflow failed: ..."
    await expect(planModule.runPlan(arcId)).rejects.toThrow(/plan workflow/)

    // Nothing must have been written to domain_flows.
    const flow = await storeModule.getFlowByArcId(queueClient, arcId)
    expect(flow).toBeNull()
  })
})
