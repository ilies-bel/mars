/**
 * Registry-wide guard for the derived-row/recipe payload contract.
 *
 * A `daemon-code-drift` row and its recipe drifted: the derivation emitted
 * `sourceSha`/`currentSha` while `action-queue-recipes.ts` read
 * `runningCommit`/`headCommit`, so the alert's detail panel rendered nothing
 * even though the daemon held every value the recipe wanted. The exact same
 * class of bug had already hit the `failed` kind once before (see
 * `derived-conditions-failed-recovery.test.ts`'s "diagnostic payload" suite).
 *
 * Two hand-written regression tests fix two instances. This test fixes the
 * *class*: for every condition kind this module (`derived-conditions.ts`)
 * derives, it produces one representative row, calls the matching recipe's
 * `humanDetail` with a payload wrapped in a Proxy that records every key
 * actually read, and asserts each of those keys exists on the row's real
 * payload. A future kind that renames a payload field without updating its
 * recipe (or vice versa) fails this test immediately instead of silently
 * rendering an empty detail panel.
 *
 * Scope note: this module derives 9 of the `CONDITION_KINDS` (the rest —
 * `phantom-task`, `worktree-ahead`, `orphaned-origin`, `steward-repeat`,
 * `e2e-tooling-missing`, `stale-queued-summary` — are derived elsewhere, out
 * of this file's join surface). Of those 9, `subscriber-stalled` and
 * `stale-worktree` were found to *already* have drifted payload/recipe
 * contracts while writing this test (subscriber-stalled's recipe read
 * `subscriberName`/`errorExcerpt`/`failCount`, none of which the derivation
 * emitted; stale-worktree's derivation emitted an empty payload against a
 * recipe expecting `worktree`/`branch`/`uncommittedFiles`). Both have since
 * been fixed and are now covered below like any other kind:
 *
 * - `stale-worktree`: its derivation now emits
 *   `status`/`prompt`/`branch`/`ageHours`/`updatedAt`, and the recipe was
 *   rewritten to match — the *condition* itself is age-based, not dirty-tree
 *   based, so `uncommittedFiles` was dropped rather than computed: populating
 *   it would mean a `git status` probe per candidate worktree on every
 *   action-queue read, a separate, scoped-out design call.
 * - `subscriber-stalled`: the recipe's `subscriberName` field was renamed to
 *   `subscriberId` to match the derivation (it's an id, not a human name),
 *   the derivation was renamed to emit `errorExcerpt` instead of `lastError`
 *   to match the recipe, and a new `subscriber_stalls.fail_count` column now
 *   backs `failCount` end-to-end.
 *
 * The exclusion set below is consequently empty; it is kept as the seam for
 * any future kind that has to be quarantined while its drift is tracked
 * separately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'
import { createConditionItemsSource } from '../view/derived-conditions.js'
import { lookupRecipe, type RecipeContext } from '../../lib/action-queue-recipes.js'
import type { ActionQueueKind } from '../../lib/action-queue-kinds.js'
import type { PersistedActionQueueRow } from '../view/action-queue.js'

// ── DB helpers (mirrors derived-conditions-failed-recovery.test.ts) ─────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-payload-contract-test-'))
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

/**
 * Read every payload key a recipe's `humanDetail` actually accesses for one
 * row, by wrapping the payload in a recording Proxy. Order-independent,
 * survives `str()`/optional-chaining wrappers — anything that resolves to a
 * `payload['key']` property access is captured.
 */
function keysReadByHumanDetail(row: PersistedActionQueueRow): Set<string> {
  const seen = new Set<string>()
  const recordingPayload = new Proxy(row.payload, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') seen.add(prop)
      return Reflect.get(target, prop, receiver)
    },
  })
  const kind = row.kind as ActionQueueKind
  const ctx: RecipeContext = {
    kind,
    entityId: (row.context['taskId'] as string | undefined) ?? row.id,
    payload: recordingPayload,
    context: row.context,
    title: row.title,
    body: row.body,
    raisedAt: new Date(row.raisedAt).toISOString(),
  }
  lookupRecipe(kind).humanDetail(ctx)
  return seen
}

/** Kinds this test excludes — see the file-header scope note for why. */
const KNOWN_DRIFTED_KINDS = new Set<string>()

describe('derived condition payload / recipe contract', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient
  let crashMarkerPath: string

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    client = await makeClient(repo)
    crashMarkerPath = join(repo, '.mars', 'crash-marker.json')
    writeFileSync(
      crashMarkerPath,
      JSON.stringify({ pid: 4242, startedAt: '2026-08-01T00:00:00.000Z', crashDetectedAt: '2026-08-01T00:05:00.000Z' }),
    )

    // failed
    await client.execute({
      sql: `INSERT INTO tasks
              (id, prompt, status, failure_signature, failure_reason_code,
               branch, worktree_path, error, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, NOW(), NOW())`,
      args: [
        'contract-failed',
        'task contract-failed',
        'code:unclassified',
        'code:unclassified',
        'task/contract-failed',
        '/repo/.mars/worktrees/contract-failed',
        'boom',
      ],
    })

    // stale-queued — updated an hour ago, well past the default 10 min threshold
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'queued', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      args: ['contract-queued', 'task contract-queued'],
    })

    // gate-broken
    await client.execute({
      sql: `INSERT INTO verify_gates
              (id, name, cmd, created_at, state, quarantine_signature, last_failure_at, last_failure_origin_id)
            VALUES (?, ?, ?, ?, 'quarantined', ?, ?, ?)`,
      args: [
        'contract-gate',
        'contract-gate',
        'npm test',
        Date.now(),
        'verdict:contract',
        Date.now(),
        'contract-failed',
      ],
    })

    // stale-worktree — a non-terminal task whose worktree directory's mtime
    // is older than the (default 24h) threshold.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, branch, created_at, updated_at)
            VALUES (?, ?, 'running', ?, NOW() - INTERVAL '30 hours', NOW() - INTERVAL '30 hours')`,
      args: ['contract-stale-worktree', 'task contract-stale-worktree', 'task/contract-stale-worktree'],
    })
    const staleWorktreeDir = join(repo, '.mars', 'worktrees', 'contract-stale-worktree')
    mkdirSync(staleWorktreeDir, { recursive: true })
    const agedMs = Date.now() - 30 * 3_600_000
    utimesSync(staleWorktreeDir, agedMs / 1000, agedMs / 1000)

    // subscriber-stalled
    await client.execute({
      sql: `INSERT INTO subscriber_stalls (subscriber_id, event_id, last_error, fail_count)
            VALUES (?, ?, ?, ?)`,
      args: ['contract-subscriber', 42, 'boom', 3],
    })
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('every derived kind (except the known, separately-tracked drifted ones) emits every payload key its recipe reads', async () => {
    // Group 1 — kinds indifferent to pause state.
    const group1 = await createConditionItemsSource({
      getClient: () => client,
      crashMarkerPath,
      repoRoot: repo,
      getCodeDrift: () => ({
        sourceSha: 'a'.repeat(40),
        currentSha: 'b'.repeat(40),
        dependencyDrift: true,
        behindBy: 3,
      }),
      isBaselinePoisoned: () => true,
      baselineDetail: () => ({ failingGateName: 'contract-gate', output: 'gate output' }),
    }).derive({
      kinds: new Set([
        'failed',
        'gate-broken',
        'daemon-died',
        'daemon-code-drift',
        'baseline-broken',
        'stale-worktree',
        'subscriber-stalled',
      ]),
    })

    // Group 2 — stale-queued requires dispatch NOT paused.
    const group2 = await createConditionItemsSource({
      getClient: () => client,
      getPauseState: () => ({ paused: false, reason: null, since: null, detail: null }),
      getActiveWorkerCount: () => 0,
      getImplementCap: () => 10,
    }).derive({ kinds: new Set(['stale-queued']) })

    // Group 3 — signature-storm requires dispatch paused with reason 'storm'.
    const group3 = await createConditionItemsSource({
      getClient: () => client,
      getPauseState: () => ({
        paused: true,
        reason: 'storm',
        since: '2026-08-01T00:00:00.000Z',
        detail: 'signature storm: verdict:contract x3',
      }),
    }).derive({ kinds: new Set(['signature-storm']) })

    const rows = [...group1, ...group2, ...group3]
    const derivedKinds = new Set(rows.map((r) => r.kind))

    // Sanity: this test is only useful while it actually exercises every
    // kind it claims to — if a derivation stops producing a row, the
    // contract check below silently stops covering it.
    for (const kind of [
      'failed',
      'stale-queued',
      'gate-broken',
      'daemon-died',
      'daemon-code-drift',
      'baseline-broken',
      'signature-storm',
      'stale-worktree',
      'subscriber-stalled',
    ]) {
      expect(derivedKinds.has(kind), `expected a '${kind}' row to be derivable in this fixture`).toBe(true)
    }

    for (const row of rows) {
      if (KNOWN_DRIFTED_KINDS.has(row.kind)) continue
      const readKeys = keysReadByHumanDetail(row)
      for (const key of readKeys) {
        expect(
          Object.prototype.hasOwnProperty.call(row.payload, key),
          `'${row.kind}' recipe's humanDetail reads payload['${key}'], but the derived row's payload has no such key (keys present: ${Object.keys(row.payload).join(', ')})`,
        ).toBe(true)
      }
    }
  })

  it('baseline-broken payload carries gateOutput and recipe exposes it in humanDetail', async () => {
    const gateStdout = 'FAIL src/core/lib/__tests__/foo.test.ts\n  × it blows up\n\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 1 total'
    const source = createConditionItemsSource({
      getClient: () => client,
      isBaselinePoisoned: () => true,
      baselineDetail: () => ({ failingGateName: 'tests', output: gateStdout }),
    })
    const rows = await source.derive({ kinds: new Set(['baseline-broken']) })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // The payload must carry gateOutput (the tail-trimmed excerpt).
    expect(typeof row.payload['gateOutput']).toBe('string')
    expect((row.payload['gateOutput'] as string)).toContain('FAIL src/core/lib/__tests__/foo.test.ts')
    // The recipe must expose it in humanDetail so the UI can render it.
    const recipe = lookupRecipe('baseline-broken')
    const detail = recipe.humanDetail({
      kind: 'baseline-broken',
      entityId: row.id,
      payload: row.payload,
      context: row.context,
      title: row.title,
      body: row.body,
      raisedAt: new Date(row.raisedAt).toISOString(),
    })
    expect(detail['gateOutput']).toContain('FAIL src/core/lib/__tests__/foo.test.ts')
    expect(detail['gateOutput']).toContain('Tests: 1 failed, 1 total')
    // The full output stays in body for `mars action-queue show`.
    expect(row.body).toContain('FAIL src/core/lib/__tests__/foo.test.ts')
  })

  it('daemon-code-drift renders the running and head shas via its recipe', async () => {
    const source = createConditionItemsSource({
      getClient: () => client,
      getCodeDrift: () => ({
        sourceSha: 'abc1234abc1234abc1234abc1234abc1234abc1',
        currentSha: 'def5678def5678def5678def5678def5678def5',
        dependencyDrift: false,
        behindBy: 5,
      }),
    })
    const rows = await source.derive({ kinds: new Set(['daemon-code-drift']) })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    const recipe = lookupRecipe('daemon-code-drift')
    const detail = recipe.humanDetail({
      kind: 'daemon-code-drift',
      entityId: row.id,
      payload: row.payload,
      context: row.context,
      title: row.title,
      body: row.body,
      raisedAt: new Date(row.raisedAt).toISOString(),
    })
    expect(detail['runningCommit']).toBe('abc1234abc1234abc1234abc1234abc1234abc1')
    expect(detail['headCommit']).toBe('def5678def5678def5678def5678def5678def5')
    expect(detail['behindBy']).toBe(5)

    const summary = recipe.humanSummary({
      kind: 'daemon-code-drift',
      entityId: row.id,
      payload: row.payload,
      context: row.context,
      title: row.title,
      body: row.body,
      raisedAt: new Date(row.raisedAt).toISOString(),
    })
    expect(summary.toLowerCase()).toContain('update')
    expect(summary).toContain('abc1234')
    expect(summary).toContain('def5678')
  })
})
