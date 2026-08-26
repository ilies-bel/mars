/**
 * Tests for reconcileDraftProposalRows — the draft-proposal action-queue
 * reconcile sweep.
 *
 * The invariant: every proposal in status='draft' must have an open
 * draft-proposal action-queue row so `mars action-queue list` reliably
 * surfaces it. If the `action-queue-repopulator` subscriber misses the
 * `proposal.added` event (daemon down, crash, outbox drop), no row is created
 * and nothing ever backfills it without this sweep.
 *
 * Covers three required cases:
 *
 * 1. Draft with no action_queue_items row → gets one raised.
 * 2. Draft with a resolved action_queue_items row → untouched (not re-raised).
 * 3. Idempotency: a second sweep pass over an already-healed DB raises nothing.
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

  it('does not raise a new row for a draft whose action-queue row is already resolved', async () => {
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
    // …then resolve it to simulate a prior operator decision.
    await supersedeActionQueueItemsForOrigin('prop-resolved-001', 'origin-done', 'test')

    const rowsBefore = await rowsForOrigin(client, 'prop-resolved-001')
    expect(rowsBefore).toHaveLength(1)
    expect(rowsBefore[0].status).toBe('resolved')

    const { reconcileDraftProposalRows } = await import('../sweeps.js')
    const { raised } = await reconcileDraftProposalRows()

    // The sweep must not touch a proposal that already has a row (any status).
    expect(raised).toBe(0)

    const rowsAfter = await rowsForOrigin(client, 'prop-resolved-001')
    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0].status).toBe('resolved')
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
