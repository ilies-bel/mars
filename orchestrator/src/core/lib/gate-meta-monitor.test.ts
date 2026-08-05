import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from './db.js'

let repo: string
let client: DbClient
let db: typeof import('./db.js')

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-gate-monitor-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo
  db = await import('./db.js')
  client = db.openDb(resolve(repo, '.mars'))
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(client)
})

afterEach(async () => {
  await db.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

const addGate = async (id: string): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO verify_gates
            (id, scope, name, cmd, args_json, required, tier, source, created_at)
          VALUES (?, '.', ?, 'node', '[]', 1, 'task', 'test', ?)`,
    args: [id, id, Date.now()],
  })
}

describe('observeVerifyGateFailure', () => {
  it('records the latest failure and advances only one gate across distinct origins', async () => {
    const { observeVerifyGateFailure } = await import('./gate-meta-monitor.js')
    await addGate('gate-a')
    await addGate('gate-b')

    await expect(observeVerifyGateFailure(client, {
      gateId: 'gate-a', originId: 'origin-1', failureSignature: 'verify:lint/unclassified', failedAt: 10,
    })).resolves.toMatchObject({ streak: 1, thresholdCrossed: false })
    await expect(observeVerifyGateFailure(client, {
      gateId: 'gate-a', originId: 'origin-2', failureSignature: 'verify:lint/unclassified', failedAt: 20,
    })).resolves.toMatchObject({ streak: 2, thresholdCrossed: false })
    await expect(observeVerifyGateFailure(client, {
      gateId: 'gate-b', originId: 'origin-3', failureSignature: 'verify:lint/unclassified', failedAt: 30,
    })).resolves.toMatchObject({ streak: 1, thresholdCrossed: false })

    await expect(client.execute({
      sql: `SELECT last_failure_signature, last_failure_at, last_failure_origin_id
              FROM verify_gates WHERE id = ?`, args: ['gate-a'],
    })).resolves.toMatchObject({ rows: [expect.objectContaining({
      last_failure_signature: 'verify:lint/unclassified', last_failure_at: 20, last_failure_origin_id: 'origin-2',
    })] })
  })

  it('does not advance a systemic streak when the same origin repeats a failure', async () => {
    const { observeVerifyGateFailure } = await import('./gate-meta-monitor.js')
    await addGate('gate-a')

    await observeVerifyGateFailure(client, {
      gateId: 'gate-a', originId: 'origin-1', failureSignature: 'verify:lint/unclassified', failedAt: 10,
    })
    await expect(observeVerifyGateFailure(client, {
      gateId: 'gate-a', originId: 'origin-1', failureSignature: 'verify:lint/unclassified', failedAt: 20,
    })).resolves.toMatchObject({ streak: 1, thresholdCrossed: false })
  })

  it('reports only the threshold-crossing observation', async () => {
    const { GATE_VERDICT_TRIP_THRESHOLD, observeVerifyGateFailure } = await import('./gate-meta-monitor.js')
    await addGate('gate-a')

    for (let i = 0; i < GATE_VERDICT_TRIP_THRESHOLD - 1; i++) {
      await expect(observeVerifyGateFailure(client, {
        gateId: 'gate-a', originId: `origin-${i}`, failureSignature: 'verify:lint/unclassified', failedAt: i,
      })).resolves.toMatchObject({ thresholdCrossed: false })
    }
    await expect(observeVerifyGateFailure(client, {
      gateId: 'gate-a', originId: 'origin-threshold', failureSignature: 'verify:lint/unclassified', failedAt: 99,
    })).resolves.toMatchObject({ thresholdCrossed: true })
    await expect(observeVerifyGateFailure(client, {
      gateId: 'gate-a', originId: 'origin-after', failureSignature: 'verify:lint/unclassified', failedAt: 100,
    })).resolves.toMatchObject({ thresholdCrossed: false })
  })
})
