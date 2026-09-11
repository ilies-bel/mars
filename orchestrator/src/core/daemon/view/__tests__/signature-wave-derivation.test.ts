/**
 * Unit tests for the signature-wave derived condition.
 *
 * Acceptance criteria (from the task brief):
 *  1. A fixture of 6 "Unknown Vcs implementation" + 5 "no worktree available"
 *     tasks, ALL with `setup:unhandled/unclassified`, splits into TWO waves of
 *     6 and 5 — not one wave of 11.
 *  2. Six errors differing only by an embedded 8-hex task id normalise to the
 *     same key and produce one wave of 6.
 *  3. A task with a non-diagnostic signature and empty/null error joins no wave.
 *  4. Wave titles name the cause text; raw failure signatures do NOT appear in
 *     the title.
 *  5. A named-cause signature (signatureNamesASharedCause = true) still forms
 *     a wave when N tasks share the same failure family.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../../lib/db.js'

// ── DB helpers ────────────────────────────────────────────────────────────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-wave-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

async function makeClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../../lib/db.js')
  const { ensureSchema } = await import('../../../lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

/** Insert a minimal failed task row with a failure_signature and error. */
async function seedFailedTask(
  client: DbClient,
  id: string,
  failureSignature: string,
  error: string | null,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, failure_signature, error, created_at, updated_at)
          VALUES (?, ?, 'failed', ?, ?, NOW(), NOW())`,
    args: [id, `task ${id}`, failureSignature, error ?? null],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deriveSignatureWaveConditions', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    client = await makeClient(repo)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── 1. The 11-task wave splits into 6 + 5 by normalised error cause ─────

  it('splits 6 "Unknown Vcs" + 5 "no worktree" tasks into two separate waves', async () => {
    // All 11 tasks share setup:unhandled/unclassified — the old code would fold
    // them into one wave of 11.  The new code groups by normalised error text,
    // producing two distinct waves.
    for (let i = 1; i <= 6; i++) {
      await seedFailedTask(
        client,
        `vcs-${i}`,
        'setup:unhandled/unclassified',
        `Unknown Vcs implementation 'local-git' - known: (none registered)`,
      )
    }
    for (let i = 1; i <= 5; i++) {
      await seedFailedTask(
        client,
        `wt-${i}`,
        'setup:unhandled/unclassified',
        `no worktree available: call setupWorktree(ctx, ...) before running agents`,
      )
    }

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    // Must produce exactly 2 waves, not 1.
    expect(rows).toHaveLength(2)

    const counts = rows.map((r) => r.payload['caughtTaskCount'] as number).sort((a, b) => a - b)
    expect(counts).toEqual([5, 6])

    // Neither wave should contain tasks from the other group.
    const ids6 = rows.find((r) => (r.payload['caughtTaskCount'] as number) === 6)
      ?.payload['caughtTaskIds'] as string[]
    const ids5 = rows.find((r) => (r.payload['caughtTaskCount'] as number) === 5)
      ?.payload['caughtTaskIds'] as string[]

    expect(ids6?.every((id) => id.startsWith('vcs-'))).toBe(true)
    expect(ids5?.every((id) => id.startsWith('wt-'))).toBe(true)
  })

  // ── 2. Six tasks differing only by an embedded task-id → one wave of 6 ──

  it('normalises errors differing only by embedded 8-hex task ids into one wave', async () => {
    // The normaliser strips hex runs of 8+ chars, so these six error strings
    // all collapse to the same key and land in one wave.
    const taskIds = [
      'mars-1bb3d8e6',
      'mars-2cc4e9f7',
      'mars-3dd5fa08',
      'mars-4ee6ab19',
      'mars-5ff7bc2a',
      'mars-60a8cd3b',
    ]
    for (const [i, tid] of taskIds.entries()) {
      await seedFailedTask(
        client,
        `api-${i}`,
        'code:unhandled/unclassified',
        `code: task ${tid} re-queued: API unreachable (attempt 1/10)`,
      )
    }

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['caughtTaskCount']).toBe(6)
  })

  // ── 3. Tasks with empty/null error join no wave ────────────────────────────

  it('skips tasks with unnamed cause AND empty error from all waves', async () => {
    // The 5 tasks with errors can form a wave together.
    for (let i = 1; i <= 5; i++) {
      await seedFailedTask(
        client,
        `has-error-${i}`,
        'setup:unhandled/unclassified',
        `some real error message`,
      )
    }
    // This task's signature does not name a cause, and its error is null →
    // no key can be derived → it must be excluded from any wave.
    await seedFailedTask(client, 'no-error', 'setup:unhandled/unclassified', null)

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    // Only the 5 error-bearing tasks form a wave; the null-error task is skipped.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['caughtTaskCount']).toBe(5)
    const waveIds = rows[0]!.payload['caughtTaskIds'] as string[]
    expect(waveIds).not.toContain('no-error')
  })

  // ── 4. Wave titles contain the cause text; no raw signature in title ───────

  it('emits a title containing the error cause and no raw signature', async () => {
    const errorMsg = `Unknown Vcs implementation 'local-git' - known: (none registered)`
    for (let i = 1; i <= 4; i++) {
      await seedFailedTask(
        client,
        `vcs2-${i}`,
        'setup:unhandled/unclassified',
        errorMsg,
      )
    }

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    const title = rows[0]!.title

    // Title must name the cause (the first line of the error).
    expect(title).toContain(`Unknown Vcs implementation`)
    // Title must NOT expose the raw machine signature.
    expect(title).not.toContain('setup:unhandled/unclassified')
    expect(title).not.toContain('unclassified')
    // Cause is in the title, not only in the body/payload.
    expect(title).toMatch(/tasks failed the same way/)
  })

  // ── 5. Named-cause signature forms a wave by failure family ──────────────

  it('groups named-cause signatures by failure family into one wave', async () => {
    // verify:typecheck/typecheck-error names a real cause → sig key space.
    // Four tasks with this signature should form one wave of 4.
    for (let i = 1; i <= 4; i++) {
      await seedFailedTask(
        client,
        `tc-${i}`,
        'verify:typecheck/typecheck-error',
        `src/foo.ts(10,5): error TS2304: Cannot find name 'bar'`,
      )
    }

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['caughtTaskCount']).toBe(4)
    // For a sig-keyed wave, the title uses the warmTitle from resolveFailureKind.
    // It must not be the raw signature.
    expect(rows[0]!.title).not.toContain('verify:typecheck')
  })

  // ── 6. Singleton named-cause task falls through to individual failed row ─

  it('does not form a wave from a singleton worktree-lease-held task', async () => {
    // code:worktree-lease-held/unclassified names a real cause (sig key space)
    // but is only one task — it should fall out of any wave and surface as its
    // own `failed` row.
    await seedFailedTask(
      client,
      'mars-lease',
      'code:worktree-lease-held/unclassified',
      `worktree /.../mars-1bb3d8e6 is already leased`,
    )

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    // No wave — singleton.
    expect(rows).toHaveLength(0)
  })

  // ── 7. Wave body does not contain raw signature prose ─────────────────────

  it('keeps raw signature out of the wave body prose', async () => {
    const errorMsg = `no worktree available: call setupWorktree(ctx, ...) before running`
    for (let i = 1; i <= 4; i++) {
      await seedFailedTask(client, `no-wt-${i}`, 'setup:unhandled/unclassified', errorMsg)
    }

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    expect(rows).toHaveLength(1)
    // Body prose must not expose the machine signature.
    const body = rows[0]!.body
    expect(body).not.toContain('setup:unhandled/unclassified')
    // But payload carries it for diagnostic use.
    expect(rows[0]!.payload['signature']).toBe('setup:unhandled/unclassified')
  })

  // ── 8. Two err-keyed waves sharing one raw failure_signature → distinct ids ─
  //
  // This is the regression test for the identity-collision bug fixed in this
  // task.  Before the fix, both waves derived their id and signature from
  // group.canonical (= the raw failure_signature, shared by all err-keyed
  // buckets that carry 'setup:unhandled/unclassified').  Two distinct buckets
  // therefore produced the SAME id, breaking the React key and snooze/verb
  // targeting in the action queue.
  //
  // The fix derives id and signature from the bucket's partition key
  // (err:<normKey>), which is unique per distinct error text.

  it('two err-keyed waves sharing one raw failure_signature emit different ids and signatures', async () => {
    // Both groups share setup:unhandled/unclassified as the failure_signature,
    // but have distinct error texts → different err-keyed buckets.
    for (let i = 1; i <= 3; i++) {
      await seedFailedTask(
        client,
        `vcs-dedup-${i}`,
        'setup:unhandled/unclassified',
        `Unknown Vcs implementation 'local-git' - known: (none registered)`,
      )
    }
    for (let i = 1; i <= 3; i++) {
      await seedFailedTask(
        client,
        `wt-dedup-${i}`,
        'setup:unhandled/unclassified',
        `no worktree available: call setupWorktree(ctx, ...) before running agents`,
      )
    }

    const { createConditionItemsSource } = await import('../derived-conditions.js')
    const source = createConditionItemsSource({ getClient: () => client })
    const rows = await source.derive({ kinds: new Set(['signature-wave']) })

    // Two distinct waves must be produced (split by err key, not by raw sig).
    expect(rows).toHaveLength(2)

    const [row0, row1] = rows as [typeof rows[number], typeof rows[number]]

    // Before the fix: both rows carry the same id (derived from group.canonical
    // = 'setup:unhandled/unclassified') — this assertion would FAIL.
    // After the fix: each row is identified by its unique bucket key.
    expect(row0.id).not.toBe(row1.id)

    // Same for the row-level signature field.
    expect(row0.signature).not.toBe(row1.signature)

    // Sanity: the diagnostic payload.signature still carries the raw sig.
    expect(row0.payload['signature']).toBe('setup:unhandled/unclassified')
    expect(row1.payload['signature']).toBe('setup:unhandled/unclassified')
  })
})
