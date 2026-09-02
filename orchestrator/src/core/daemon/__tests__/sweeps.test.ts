/**
 * Tests for the draft-proposal action-queue reconcile invariant:
 *
 *   Every draft proposal has exactly one open draft-proposal row, AND
 *   every open draft-proposal row maps to a draft proposal.
 *
 * Two reconcilers enforce the two directions:
 *
 * - `reconcileDraftProposalRows` (sweeps.ts) — proposals → rows:
 *   Draft proposals with no OPEN row get one raised. Covers two failure modes:
 *   (a) missed event: the `action-queue-repopulator` subscriber was not
 *       draining when `proposal.added` fired (daemon down, crash, outbox drop).
 *   (b) stale resolution: a prior path resolved the row (e.g. as `superseded`)
 *       without updating the proposal status — the proposal is still `draft`
 *       but invisible to operators.
 *
 * - `reconcileStaleProposalAqRows` (reconcilers.ts) — rows → proposals:
 *   Open draft-proposal rows whose proposal is absent or no longer draft get
 *   closed. Covers the case where a proposal is dismissed / promoted after the
 *   row was raised but before the row was operator-resolved.
 *   Join key: `origin_task_id` (unified with the raise half).
 *
 * Covers:
 *
 * proposals → rows (reconcileDraftProposalRows):
 * 1. Draft with no action_queue_items row → gets one raised.
 * 2. Draft with a resolved action_queue_items row → re-raised (Reading 2).
 * 3. Re-raise is idempotent: after first re-raise, second pass raises nothing.
 * 4. Idempotency: a second sweep pass over an already-healed DB raises nothing.
 *
 * rows → proposals (reconcileStaleProposalAqRows):
 * 5. Open row whose proposal is dismissed → row gets closed.
 * 6. Open row whose proposal is still draft → row is left open.
 * 7. Open row with no matching proposal at all → row gets closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-sweeps-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

async function makeClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../lib/db.js')
  const { ensureSchema } = await import('../../lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

async function insertDraftProposal(
  client: DbClient,
  id: string,
  opts: { title?: string; source?: string } = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO proposals (id, title, status, source, created_at, updated_at)
          VALUES ($1, $2, 'draft', $3, $4, $5)`,
    args: [id, opts.title ?? `Proposal ${id}`, opts.source ?? 'planner', Date.now(), Date.now()],
  })
}

/** Return all action_queue_items rows keyed to originTaskId (any status). */
async function rowsForOrigin(
  client: DbClient,
  originId: string,
): Promise<Array<{ status: string; kind: string }>> {
  const r = await client.execute({
    sql: `SELECT status, kind FROM action_queue_items WHERE origin_task_id = $1`,
    args: [originId],
  })
  return (r.rows as unknown as Array<{ status: string; kind: string }>)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcileDraftProposalRows', { timeout: 120_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    client = await makeClient(repo)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises a draft-proposal action-queue row for a draft with no existing row', async () => {
    await insertDraftProposal(client, 'prop-no-row-001', {
      title: 'Improve error messages',
      source: 'planner',
    })

    const { reconcileDraftProposalRows } = await import('../sweeps.js')
    const { raised } = await reconcileDraftProposalRows()

    expect(raised).toBe(1)

    const rows = await rowsForOrigin(client, 'prop-no-row-001')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('open')
    expect(rows[0].kind).toBe('draft-proposal')
  })

  it('re-raises a row for a draft whose only action-queue row is already resolved', async () => {
    // Reading 2 (chosen): a draft proposal that has no OPEN row must be
    // re-raised even when a resolved row already exists. A resolved row means
    // some path closed the notification without updating the proposal's status;
    // the proposal is still actionable and the operator must see it.
    await insertDraftProposal(client, 'prop-resolved-001', {
      title: 'Add caching layer',
      source: 'planner',
    })

    // First, raise an open row via raiseActionQueueItem…
    const { raiseActionQueueItem, supersedeActionQueueItemsForOrigin } = await import(
      '../../lib/action-queue.js'
    )
    await raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: 'Draft proposal: Add caching layer',
      body: 'Proposal `prop-resolved-001` from `planner` is ready for review.',
      payload: { proposalId: 'prop-resolved-001', source: 'planner' },
      context: {},
      raisedBy: 'test',
      signature: 'prop-resolved-001',
      originTaskId: 'prop-resolved-001',
    })
    // …then resolve it to simulate a stale resolution (row closed without
    // updating the proposal status — the invariant violation we are healing).
    await supersedeActionQueueItemsForOrigin('prop-resolved-001', 'origin-done', 'test')

    const rowsBefore = await rowsForOrigin(client, 'prop-resolved-001')
    expect(rowsBefore).toHaveLength(1)
    expect(rowsBefore[0].status).toBe('resolved')

    const { reconcileDraftProposalRows } = await import('../sweeps.js')
    const { raised } = await reconcileDraftProposalRows()

    // The sweep must re-raise: the proposal is still draft but has no open row.
    expect(raised).toBe(1)

    const rowsAfter = await rowsForOrigin(client, 'prop-resolved-001')
    // There should now be two rows: the old resolved one and the new open one.
    expect(rowsAfter).toHaveLength(2)
    const openRows = rowsAfter.filter((r) => r.status === 'open')
    expect(openRows).toHaveLength(1)
    expect(openRows[0].kind).toBe('draft-proposal')
  })

  it('does not re-raise when the open row already exists (idempotent re-raise)', async () => {
    // After the first re-raise heals a resolved-row proposal, a second pass
    // must find the new open row and skip — no duplicate row.
    await insertDraftProposal(client, 'prop-resolved-idem-001', {
      title: 'Add caching layer v2',
      source: 'planner',
    })

    const { raiseActionQueueItem, supersedeActionQueueItemsForOrigin } = await import(
      '../../lib/action-queue.js'
    )
    await raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: 'Draft proposal: Add caching layer v2',
      body: 'Proposal `prop-resolved-idem-001` from `planner` is ready for review.',
      payload: { proposalId: 'prop-resolved-idem-001', source: 'planner' },
      context: {},
      raisedBy: 'test',
      signature: 'prop-resolved-idem-001',
      originTaskId: 'prop-resolved-idem-001',
    })
    await supersedeActionQueueItemsForOrigin('prop-resolved-idem-001', 'origin-done', 'test')

    const { reconcileDraftProposalRows } = await import('../sweeps.js')

    const first = await reconcileDraftProposalRows()
    expect(first.raised).toBe(1) // heals the resolved row

    const second = await reconcileDraftProposalRows()
    expect(second.raised).toBe(0) // open row now exists → no re-raise

    const rows = await rowsForOrigin(client, 'prop-resolved-idem-001')
    const openRows = rows.filter((r) => r.status === 'open')
    expect(openRows).toHaveLength(1)
  })

  it('is idempotent — a second pass raises no duplicate rows', async () => {
    await insertDraftProposal(client, 'prop-idempotent-001', {
      title: 'Refactor queue module',
      source: 'planner',
    })

    const { reconcileDraftProposalRows } = await import('../sweeps.js')

    const first = await reconcileDraftProposalRows()
    expect(first.raised).toBe(1)

    const second = await reconcileDraftProposalRows()
    expect(second.raised).toBe(0)

    // Only one row must exist after two passes.
    const rows = await rowsForOrigin(client, 'prop-idempotent-001')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// Rows → proposals direction: reconcileStaleProposalAqRows
// ---------------------------------------------------------------------------

describe('reconcileStaleProposalAqRows', { timeout: 120_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    client = await makeClient(repo)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('closes an open draft-proposal row whose proposal has been dismissed', async () => {
    // Insert a draft proposal and a corresponding open action-queue row.
    await insertDraftProposal(client, 'prop-dismissed-001', {
      title: 'Optimize startup time',
      source: 'planner',
    })
    const { raiseActionQueueItem } = await import('../../lib/action-queue.js')
    await raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: 'Draft proposal: Optimize startup time',
      body: 'Proposal `prop-dismissed-001` from `planner` is ready for review.',
      payload: { proposalId: 'prop-dismissed-001', source: 'planner' },
      context: {},
      raisedBy: 'test',
      signature: 'prop-dismissed-001',
      originTaskId: 'prop-dismissed-001',
    })

    // Dismiss the proposal (move it out of draft status).
    await client.execute({
      sql: `UPDATE proposals SET status = 'dismissed', updated_at = $1 WHERE id = $2`,
      args: [Date.now(), 'prop-dismissed-001'],
    })

    const { reconcileStaleProposalAqRows } = await import('../reconcilers.js')
    const { closed } = await reconcileStaleProposalAqRows()

    expect(closed).toBe(1)

    const rows = await rowsForOrigin(client, 'prop-dismissed-001')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('resolved')
  })

  it('leaves an open draft-proposal row untouched when the proposal is still draft', async () => {
    await insertDraftProposal(client, 'prop-still-draft-001', {
      title: 'Add structured logging',
      source: 'planner',
    })
    const { raiseActionQueueItem } = await import('../../lib/action-queue.js')
    await raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: 'Draft proposal: Add structured logging',
      body: 'Proposal `prop-still-draft-001` from `planner` is ready for review.',
      payload: { proposalId: 'prop-still-draft-001', source: 'planner' },
      context: {},
      raisedBy: 'test',
      signature: 'prop-still-draft-001',
      originTaskId: 'prop-still-draft-001',
    })

    const { reconcileStaleProposalAqRows } = await import('../reconcilers.js')
    const { closed } = await reconcileStaleProposalAqRows()

    expect(closed).toBe(0)

    const rows = await rowsForOrigin(client, 'prop-still-draft-001')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('open')
  })

  it('closes an open draft-proposal row whose proposal does not exist at all', async () => {
    // Raise a row for a proposal that was never inserted.
    const { raiseActionQueueItem } = await import('../../lib/action-queue.js')
    await raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: 'Draft proposal: Ghost proposal',
      body: 'Proposal `ghost-proposal-001` from `planner` is ready for review.',
      payload: { proposalId: 'ghost-proposal-001', source: 'planner' },
      context: {},
      raisedBy: 'test',
      signature: 'ghost-proposal-001',
      originTaskId: 'ghost-proposal-001',
    })

    const { reconcileStaleProposalAqRows } = await import('../reconcilers.js')
    const { closed } = await reconcileStaleProposalAqRows()

    expect(closed).toBe(1)

    const rows = await rowsForOrigin(client, 'ghost-proposal-001')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('resolved')
  })
})
