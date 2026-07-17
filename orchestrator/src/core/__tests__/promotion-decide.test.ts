import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Pure function — no DB needed
// ---------------------------------------------------------------------------

import { decidePromotion } from '../promotion-decide'

describe('decidePromotion (pure)', () => {
  it('returns "promote" when trial mean strictly beats incumbent mean', () => {
    const result = decidePromotion({
      trialScores: [0.9, 0.85, 0.88, 0.87, 0.91],
      incumbentScores: [0.7, 0.72, 0.68, 0.71, 0.69],
      minSamples: 5,
    })
    expect(result).toBe('promote')
  })

  it('returns "retire" when trial mean is below incumbent mean', () => {
    const result = decidePromotion({
      trialScores: [0.5, 0.55, 0.52, 0.48, 0.51],
      incumbentScores: [0.8, 0.82, 0.79, 0.81, 0.83],
      minSamples: 5,
    })
    expect(result).toBe('retire')
  })

  it('returns "retire" when trial mean equals incumbent mean (no strict improvement)', () => {
    const result = decidePromotion({
      trialScores: [0.7, 0.7, 0.7, 0.7, 0.7],
      incumbentScores: [0.7, 0.7, 0.7, 0.7, 0.7],
      minSamples: 5,
    })
    expect(result).toBe('retire')
  })

  it('returns "insufficient-data" when trial array is too short', () => {
    const result = decidePromotion({
      trialScores: [0.9, 0.9],
      incumbentScores: [0.7, 0.7, 0.7, 0.7, 0.7],
      minSamples: 5,
    })
    expect(result).toBe('insufficient-data')
  })

  it('returns "insufficient-data" when incumbent array is too short', () => {
    const result = decidePromotion({
      trialScores: [0.9, 0.9, 0.9, 0.9, 0.9],
      incumbentScores: [0.7],
      minSamples: 5,
    })
    expect(result).toBe('insufficient-data')
  })

  it('returns "insufficient-data" when both arrays are empty', () => {
    const result = decidePromotion({
      trialScores: [],
      incumbentScores: [],
      minSamples: 1,
    })
    expect(result).toBe('insufficient-data')
  })

  it('accepts minSamples=1 as the minimum floor', () => {
    const result = decidePromotion({
      trialScores: [0.9],
      incumbentScores: [0.7],
      minSamples: 1,
    })
    expect(result).toBe('promote')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — require a real in-memory SQLite DB
// ---------------------------------------------------------------------------

// Module interfaces — loaded fresh per test via vi.resetModules()
interface PromotionDecideMod {
  runPromotionDecision: typeof import('../promotion-decide').runPromotionDecision
}
interface WorkflowConfigsMod {
  initWorkflowConfigs: typeof import('../workflow-configs').initWorkflowConfigs
  insertWorkflowConfig: typeof import('../workflow-configs').insertWorkflowConfig
  getActiveWorkflowConfig: typeof import('../workflow-configs').getActiveWorkflowConfig
  getTrialWorkflowConfig: typeof import('../workflow-configs').getTrialWorkflowConfig
  __resetWorkflowConfigsForTests: typeof import('../workflow-configs').__resetWorkflowConfigsForTests
}
interface ScorerResultsMod {
  initScorerResults: typeof import('../scorer-results').initScorerResults
  __resetScorerResultsForTests: typeof import('../scorer-results').__resetScorerResultsForTests
}
interface PromotionLedgerMod {
  initPromotionLedger: typeof import('../promotion-ledger').initPromotionLedger
  listPromotionLedgerEntries: typeof import('../promotion-ledger').listPromotionLedgerEntries
  __resetPromotionLedgerForTests: typeof import('../promotion-ledger').__resetPromotionLedgerForTests
}
interface StateClientMod {
  resolveStateClient: typeof import('../store/state-client').resolveStateClient
  __resetStateClientForTests: typeof import('../store/state-client').__resetStateClientForTests
}
interface ActionQueueMod {
  raiseActionQueueItem: typeof import('../lib/action-queue').raiseActionQueueItem
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-pd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface TestMods {
  pd: PromotionDecideMod
  wc: WorkflowConfigsMod
  sr: ScorerResultsMod
  pl: PromotionLedgerMod
  sc: StateClientMod
  aq: ActionQueueMod
}

const loadMods = async (repo: string): Promise<TestMods> => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  const pd = (await import('../promotion-decide')) as unknown as PromotionDecideMod
  const wc = (await import('../workflow-configs')) as unknown as WorkflowConfigsMod
  const sr = (await import('../scorer-results')) as unknown as ScorerResultsMod
  const pl = (await import('../promotion-ledger')) as unknown as PromotionLedgerMod
  const sc = (await import('../store/state-client')) as unknown as StateClientMod
  const aq = (await import('../lib/action-queue')) as unknown as ActionQueueMod

  // Initialise all tables.
  await wc.initWorkflowConfigs()
  await sr.initScorerResults()
  await pl.initPromotionLedger()

  return { pd, wc, sr, pl, sc, aq }
}

/** Insert a scored result row directly via SQL (bypass idempotency / scorerId uniqueness). */
const insertScoredResult = async (
  client: Awaited<ReturnType<StateClientMod['resolveStateClient']>>,
  opts: {
    workflow: string
    versionId: string
    score: number
    index: number
  },
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO scorer_results
            (id, scorer_id, task_id, workflow, score, rationale, status, created_at, workflow_config_version_id)
          VALUES (?, ?, ?, ?, ?, '', 'scored', ?, ?)`,
    args: [
      `sr-${opts.index}`,
      `scorer-${opts.index}`,
      `task-${opts.index}`,
      opts.workflow,
      opts.score,
      Date.now() + opts.index,
      opts.versionId,
    ],
  })
}

describe('runPromotionDecision (integration)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('trial beats incumbent → trial promoted, incumbent retired, ledger row written', async () => {
    const { pd, wc, pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    // Insert incumbent (baseline) and trial workflow-config versions.
    const incumbent = await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    const trial = await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    // Seed scores: trial clearly better (mean 0.9 vs 0.6).
    for (let i = 0; i < 5; i++) {
      await insertScoredResult(client, { workflow: 'task', versionId: trial.id, score: 0.9, index: i })
      await insertScoredResult(client, { workflow: 'task', versionId: incumbent.id, score: 0.6, index: i + 100 })
    }

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })

    expect(outcome).toBe('promote')

    // Check DB row statuses.
    const updatedTrial = await wc.getTrialWorkflowConfig(client, 'task')
    expect(updatedTrial).toBeNull() // no longer 'trial'

    const updatedIncumbent = await wc.getActiveWorkflowConfig(client, 'task')
    // The new active is the promoted trial.
    expect(updatedIncumbent?.id).toBe('wfc-v2')
    expect(updatedIncumbent?.status).toBe('promoted')

    // Ledger entry written.
    const ledger = await pl.listPromotionLedgerEntries(client, 'task')
    expect(ledger).toHaveLength(1)
    expect(ledger[0].decision).toBe('promoted')
    expect(ledger[0].candidateVersionId).toBe('wfc-v2')
    expect(ledger[0].incumbentVersionId).toBe('wfc-v1')
    expect(ledger[0].candidateN).toBe(5)
    expect(ledger[0].incumbentN).toBe(5)
  })

  it('trial loses to incumbent → trial retired, incumbent unchanged, ledger row written', async () => {
    const { pd, wc, pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const incumbent = await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    const trial = await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    // Seed scores: incumbent is better (mean 0.85 vs 0.5).
    for (let i = 0; i < 5; i++) {
      await insertScoredResult(client, { workflow: 'task', versionId: trial.id, score: 0.5, index: i })
      await insertScoredResult(client, { workflow: 'task', versionId: incumbent.id, score: 0.85, index: i + 100 })
    }

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })

    expect(outcome).toBe('retire')

    // Trial is now retired.
    const afterTrial = await wc.getTrialWorkflowConfig(client, 'task')
    expect(afterTrial).toBeNull() // retired, no longer 'trial'

    // Incumbent stays in its original status (baseline).
    const afterIncumbent = await wc.getActiveWorkflowConfig(client, 'task')
    expect(afterIncumbent?.id).toBe('wfc-v1')
    expect(afterIncumbent?.status).toBe('baseline')

    // Ledger row written with 'retired' decision.
    const ledger = await pl.listPromotionLedgerEntries(client, 'task')
    expect(ledger).toHaveLength(1)
    expect(ledger[0].decision).toBe('retired')
    expect(ledger[0].candidateVersionId).toBe('wfc-v2')
  })

  it('too few samples → no status changes, no ledger row written', async () => {
    const { pd, wc, pl, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    // Only 2 scores each — below minSamples=5.
    await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v2', score: 0.9, index: 0 })
    await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v2', score: 0.88, index: 1 })
    await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v1', score: 0.7, index: 100 })
    await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v1', score: 0.72, index: 101 })

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })

    expect(outcome).toBe('insufficient-data')

    // No status changes.
    const activeTrial = await wc.getTrialWorkflowConfig(client, 'task')
    expect(activeTrial?.status).toBe('trial')

    const activeIncumbent = await wc.getActiveWorkflowConfig(client, 'task')
    expect(activeIncumbent?.status).toBe('baseline')

    // No ledger row.
    const ledger = await pl.listPromotionLedgerEntries(client, 'task')
    expect(ledger).toHaveLength(0)
  })

  it('returns null when no trial config exists', async () => {
    const { pd, wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    // Only incumbent, no trial.
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })
    expect(outcome).toBeNull()
  })

  it('returns null when no incumbent config exists', async () => {
    const { pd, wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    // Only trial, no baseline/promoted.
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })
    expect(outcome).toBeNull()
  })

  it('promote decision raises one action_queue_items row with kind=promotion-decision referencing the ledger id', async () => {
    const { pd, wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    // trial mean 0.9 vs incumbent mean 0.6 → promote
    for (let i = 0; i < 5; i++) {
      await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v2', score: 0.9, index: i })
      await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v1', score: 0.6, index: i + 100 })
    }

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })
    expect(outcome).toBe('promote')

    // Exactly one action_queue_items row with kind='promotion-decision'.
    const rows = await client.execute(
      `SELECT id, kind, body, payload, state FROM action_queue_items WHERE kind = 'promotion-decision'`,
    )
    expect(rows.rows).toHaveLength(1)

    const row = rows.rows[0] as unknown as { id: string; kind: string; body: string; payload: string; state: string }
    expect(row.kind).toBe('promotion-decision')
    expect(row.state).toBe('open')

    // Body is human-readable and mentions the workflow, scores, and decision.
    expect(row.body).toContain('Workflow task:')
    expect(row.body).toContain('decision: promote')
    expect(row.body).toContain('0.900')

    // Payload references the ledger entry id.
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    expect(typeof payload.ledgerId).toBe('string')
    expect((payload.ledgerId as string).startsWith('pl-')).toBe(true)
    expect(payload.workflow).toBe('task')
    expect(payload.decision).toBe('promote')
  })

  it('retire decision also raises one action_queue_items row', async () => {
    const { pd, wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    // incumbent mean 0.85 vs trial mean 0.5 → retire
    for (let i = 0; i < 5; i++) {
      await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v2', score: 0.5, index: i })
      await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v1', score: 0.85, index: i + 100 })
    }

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })
    expect(outcome).toBe('retire')

    const rows = await client.execute(
      `SELECT id, kind, body, payload, state FROM action_queue_items WHERE kind = 'promotion-decision'`,
    )
    expect(rows.rows).toHaveLength(1)

    const row = rows.rows[0] as unknown as { body: string; state: string }
    expect(row.state).toBe('open')
    expect(row.body).toContain('decision: retire')
  })

  it('insufficient-data outcome raises no action_queue_items row', async () => {
    const { pd, wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    // Only 2 scores each — below minSamples=5
    await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v2', score: 0.9, index: 0 })
    await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v1', score: 0.7, index: 100 })

    const outcome = await pd.runPromotionDecision(client, 'task', { minSamples: 5 })
    expect(outcome).toBe('insufficient-data')

    // action_queue_items table may not exist yet (raiseActionQueueItem was never called).
    // Guard with sqlite_master check.
    const tableExists = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='action_queue_items'`,
    )
    if (tableExists.rows.length > 0) {
      const rows = await client.execute(
        `SELECT id FROM action_queue_items WHERE kind = 'promotion-decision'`,
      )
      expect(rows.rows).toHaveLength(0)
    }
  })

  it('raising the same ledger id twice is idempotent (seen_count bumps, no new row)', async () => {
    const { pd, wc, sc, aq } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash1',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash2',
      status: 'trial',
    })

    for (let i = 0; i < 5; i++) {
      await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v2', score: 0.9, index: i })
      await insertScoredResult(client, { workflow: 'task', versionId: 'wfc-v1', score: 0.6, index: i + 100 })
    }

    await pd.runPromotionDecision(client, 'task', { minSamples: 5 })

    // Retrieve the ledger id from the action_queue row's payload.
    const firstRows = await client.execute(
      `SELECT payload FROM action_queue_items WHERE kind = 'promotion-decision'`,
    )
    expect(firstRows.rows).toHaveLength(1)
    const payload = JSON.parse(
      (firstRows.rows[0] as unknown as { payload: string }).payload,
    ) as Record<string, unknown>
    const ledgerId = payload.ledgerId as string

    // Re-raise with the same signature — should be idempotent.
    await aq.raiseActionQueueItem({
      kind: 'promotion-decision',
      category: 'daemon',
      priority: 'normal',
      title: 'Promotion decision: task',
      body: 'duplicate raise',
      payload: { ledgerId },
      context: {},
      raisedBy: 'test',
      signature: `promotion-decision:${ledgerId}`,
    })

    // Still only one row.
    const afterRows = await client.execute(
      `SELECT seen_count FROM action_queue_items WHERE kind = 'promotion-decision'`,
    )
    expect(afterRows.rows).toHaveLength(1)
    expect(Number((afterRows.rows[0] as unknown as { seen_count: number }).seen_count)).toBe(2)
  })
})
