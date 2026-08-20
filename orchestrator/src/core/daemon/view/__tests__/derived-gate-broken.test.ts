/**
 * Regression guard: a `gate-broken` row must not outlive its subject.
 *
 * `verify_gates.last_failure_origin_id` is history — it is never cleared when
 * the task it names is purged. The derivation used to copy that id straight
 * into `payload.originTaskId`, so the operator got a row whose task link
 * resolved to nothing ("details not found"). `gate-broken` is a *condition*
 * kind (ADR-0057: derived on read, never stored), so a dangling reference is
 * avoidable at derivation time rather than something a sweep has to clean up.
 *
 * The subject of the row is the gate, so its identity (scope/name) is what the
 * title must render.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../../lib/db.js'
import { createConditionItemsSource } from '../derived-conditions.js'

const insertGate = async (
  client: DbClient,
  gateId: string,
  scope: string,
  name: string,
  originId: string | null,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO verify_gates
            (id, scope, name, cmd, created_at, state, quarantine_signature,
             last_failure_at, last_failure_origin_id)
          VALUES (?, ?, ?, 'npm test', ?, 'quarantined', ?, ?, ?)`,
    args: [
      gateId,
      scope,
      name,
      1_760_000_000_000,
      `verify:${name}/typecheck-error`,
      1_760_000_000_000,
      originId,
    ],
  })
}

describe('gate-broken derivation', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'mars-gate-broken-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    const { openDb } = await import('../../../lib/db.js')
    const { ensureSchema } = await import('../../../lib/pg-schema.js')
    client = openDb(resolve(repo, '.mars'))
    await ensureSchema(client)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const derive = async () =>
    createConditionItemsSource({ getClient: () => client }).derive({
      kinds: new Set(['gate-broken']),
    })

  it('renders the gate identity and drops the link when the origin task is gone', async () => {
    await insertGate(client, 'gate-vanished', 'ui', 'typecheck', 'mars-6340b827')

    const rows = await derive()

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toContain('ui/typecheck')
    expect(rows[0]!.title).not.toContain('mars-6340b827')
    expect(rows[0]!.payload['originTaskId']).toBeNull()
    expect(rows[0]!.payload['gate']).toBe('gate-vanished')
  })

  it('keeps the origin link when the task still exists', async () => {
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'failed', NOW(), NOW())`,
      args: ['mars-alive01', 'task mars-alive01'],
    })
    await insertGate(client, 'gate-live', 'orchestrator', 'typecheck', 'mars-alive01')

    const rows = await derive()

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['originTaskId']).toBe('mars-alive01')
    expect(rows[0]!.title).toContain('orchestrator/typecheck')
  })

  it('renders a gate that never recorded an origin task at all', async () => {
    await insertGate(client, 'gate-no-origin', '.', 'build', null)

    const rows = await derive()

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload['originTaskId']).toBeNull()
    expect(rows[0]!.title).toContain('./build')
  })
})
