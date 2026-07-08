/**
 * Tests for `mars proposal take` CLI behaviour (ADR-0067 / PRD 6c93eb31 slice 8).
 *
 * Covers the five acceptance criteria:
 *   1. Happy path — shaped prd-ready proposal → daemon called with right op+workflow, task id printed.
 *   2. Default workflow — no --workflow flag → daemon receives workflow='live'.
 *   3. Explicit --workflow — --workflow manual → daemon receives workflow='manual'.
 *   4. Non-shaped-proposal error — draft with no PRD body → actionable error, daemon not called.
 *   5. Unknown-id error — nonexistent id → error, daemon not called.
 *
 * All command dispatch uses DYNAMIC imports of test-adapter after vi.resetModules()
 * so every test gets fully fresh module instances (including proposals.ts and its
 * state-client singleton).  Static imports here are type-only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-take-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Dynamically import store + ctx helpers AFTER the module cache reset so
 * they share the same module instances as the command dispatch.
 */
const loadStoreAndCtx = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

/** Create a prd-ready proposal in the local DB and return its id. */
const seedPrdReady = async (): Promise<string> => {
  const { createProposal, addProposalUserStory, promoteProposal, initProposals } =
    await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Take test proposal', {
    source: 'human',
    problem: 'There is a problem to solve',
    solution: 'Here is the solution to the problem',
  })
  await addProposalUserStory(p.id, 'As a user I can do the thing')
  await promoteProposal(p.id)
  return p.id
}

/** Create a bare draft proposal with no PRD body fields set. */
const seedUnshaped = async (): Promise<string> => {
  const { createProposal, initProposals } = await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Unshaped draft', { source: 'human' })
  return p.id
}

/**
 * Run a command in-process using FRESH module instances (after vi.resetModules()).
 * This guarantees the proposal-lookup code in proposalTake uses the same
 * DB connection as seedPrdReady / seedUnshaped.
 */
const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

/**
 * Create a recording fake daemon from fresh module instances.
 */
const makeFake = async (
  responder?: (req: Record<string, unknown>) => unknown,
) => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon(responder as Parameters<typeof makeFakeDaemon>[0])
}

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

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('mars proposal take — happy path', () => {
  it('sends op=proposal.take with the proposal id, prints task id and workflow', async () => {
    const proposalId = await seedPrdReady()
    const fake = await makeFake((req) => {
      if (req['op'] === 'proposal.take') {
        return { proposalId: req['proposalId'], taskId: 'mars-live-task-001' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(['proposal', 'take', proposalId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'proposal.take', proposalId })
    expect(r.out.join('\n')).toContain('mars-live-task-001')
    // Never delegates to the slicer.
    const sliceCalls = fake.calls.filter((c) => (c as { op: string }).op === 'proposal.slice')
    expect(sliceCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Default workflow — no flag → 'live'
// ---------------------------------------------------------------------------

describe('mars proposal take — default workflow', () => {
  it('sends workflow=live when --workflow is omitted', async () => {
    const proposalId = await seedPrdReady()
    let capturedWorkflow: string | undefined
    const fake = await makeFake((req) => {
      if (req['op'] === 'proposal.take') {
        capturedWorkflow = req['workflow'] as string | undefined
        return { proposalId: req['proposalId'], taskId: 'mars-task-default-wf' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(['proposal', 'take', proposalId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(capturedWorkflow).toBe('live')
    expect(r.out.join('\n')).toContain('live')
  })
})

// ---------------------------------------------------------------------------
// 3. Explicit --workflow flag
// ---------------------------------------------------------------------------

describe('mars proposal take — explicit --workflow', () => {
  it('forwards the specified workflow to the daemon', async () => {
    const proposalId = await seedPrdReady()
    let capturedWorkflow: string | undefined
    const fake = await makeFake((req) => {
      if (req['op'] === 'proposal.take') {
        capturedWorkflow = req['workflow'] as string | undefined
        return { proposalId: req['proposalId'], taskId: 'mars-task-manual-wf' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(
      ['proposal', 'take', proposalId, '--workflow', 'manual'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(capturedWorkflow).toBe('manual')
    expect(r.out.join('\n')).toContain('manual')
    // Daemon was called exactly once.
    expect(fake.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Non-shaped-proposal error — draft with no PRD body
// ---------------------------------------------------------------------------

describe('mars proposal take — non-shaped-proposal error', () => {
  it('errors with an actionable message when draft has no PRD body, daemon not called', async () => {
    const proposalId = await seedUnshaped()
    const fake = await makeFake()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(['proposal', 'take', proposalId], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    // Error message names what is missing.
    const errText = r.err.join('\n')
    expect(errText).toContain('not fully shaped')
    expect(errText).toContain('missing')
    // Daemon must never be contacted — error is caught locally.
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Unknown-id error
// ---------------------------------------------------------------------------

describe('mars proposal take — unknown-id error', () => {
  it('errors when the proposal id does not exist, daemon not called', async () => {
    // Ensure DB is initialised but no proposals exist.
    const { initProposals } = await import('../../../core/proposals')
    const { migrateQueueSchema } = await import('../../../core/queue')
    await initProposals()
    await migrateQueueSchema()

    const fake = await makeFake()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(
      ['proposal', 'take', 'nonexistent-proposal-id'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// --help surface
// ---------------------------------------------------------------------------

describe('mars proposal take --help surface', () => {
  it('usage string mentions --workflow <kind>', async () => {
    // Running the command without an id surfaces the usage string via the
    // error sink — the usage must name --workflow.
    const fake = await makeFake()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await run(['proposal', 'take'], { store, ctx, daemon: fake })
    expect(r.code).not.toBe(0)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('--workflow')
  })
})
