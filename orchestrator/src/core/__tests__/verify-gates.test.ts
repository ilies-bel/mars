/**
 * Tests for verify-gates.ts — the DB-backed verify step registry.
 *
 * Covers:
 * - ensureVerifyGatesSchema: creates the table idempotently
 * - addVerifyGate: inserts a gate, returns a usable id, applies defaults
 * - removeVerifyGate: deletes by id and by {scope, name}
 * - listVerifyGates: returns all gates and their health in scope+created_at order
 * - loadVerifyGates: returns active VerifyScope[] matching the selectVerifySteps shape
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../lib/db.js'

let repo: string
let client: DbClient
// Keep a reference to the db module so we can force-close all PGlite
// instances in afterEach (including any refs held by state-client singletons).
let dbModule: typeof import('../lib/db.js')

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-vg-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo

  dbModule = await import('../lib/db.js')
  client = dbModule.openDb(resolve(repo, '.mars'))
})

afterEach(async () => {
  // Force-close all PGlite instances (including any ref held by the
  // state-client singleton that vi.resetModules() will orphan next turn).
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('ensureVerifyGatesSchema', () => {
  it('creates the verify_gates table idempotently', async () => {
    const { ensureVerifyGatesSchema } = await import('../verify-gates.js')
    // First call creates the table
    await ensureVerifyGatesSchema(client)
    // Second call must not throw (IF NOT EXISTS)
    await expect(ensureVerifyGatesSchema(client)).resolves.toBeUndefined()
    // Table is queryable
    const r = await client.execute(
      `SELECT COUNT(*) AS cnt FROM verify_gates`,
    )
    expect(r.rows[0]).toMatchObject({ cnt: 0 })
  })
})

describe('addVerifyGate', () => {
  it('inserts a gate with defaults and returns a non-empty id', async () => {
    const { addVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    const id = await addVerifyGate({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] })

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const gates = await listVerifyGates()
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({
      id,
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      required: true,
      tier: 'task',
      source: 'human',
      scope: '.',
    })
    expect(typeof gates[0].createdAt).toBe('number')
    expect(gates[0].createdAt).toBeGreaterThan(0)
  })

  it('respects all optional fields when provided', async () => {
    const { addVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({
      scope: 'apps/web',
      name: 'test',
      cmd: 'npm',
      args: ['test', '--', '--run'],
      required: false,
      tier: 'integration',
      source: 'operator',
    })

    const gates = await listVerifyGates()
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({
      scope: 'apps/web',
      name: 'test',
      cmd: 'npm',
      args: ['test', '--', '--run'],
      required: false,
      tier: 'integration',
      source: 'operator',
    })
  })

  it('stores empty args array correctly', async () => {
    const { addVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({ name: 'lint', cmd: 'eslint' })
    const gates = await listVerifyGates()
    expect(gates[0].args).toEqual([])
  })

  it('resolves an open coverage-gap alert when the new gate covers its scope', async () => {
    const { ensureSchema } = await import('../lib/pg-schema.js')
    await ensureSchema(client)
    await client.execute({
      sql: `INSERT INTO action_queue_items (
              id, kind, category, priority, state, title, body, payload,
              context, raised_by, raised_at, fingerprint
            ) VALUES (?, 'verify-uncovered', 'orchestrator', 'normal', 'open', ?, ?, ?, '{}', 'test', ?, ?)`,
      args: [
        'coverage-row',
        'No gate covers apps/web',
        "CAN'T-VERIFY",
        JSON.stringify({
          scope: 'apps/web',
          changedPaths: ['apps/web/src/App.tsx'],
          recipe: 'add-verify-gate',
        }),
        Date.now(),
        'coverage:apps/web',
      ],
    })

    const { addVerifyGate } = await import('../verify-gates.js')
    await addVerifyGate({ scope: 'apps/web', name: 'test', cmd: 'npm' })

    const row = await client.execute({
      sql: `SELECT state, resolution_note FROM action_queue_items WHERE id = ?`,
      args: ['coverage-row'],
    })
    expect(row.rows[0]).toMatchObject({
      state: 'resolved',
      resolution_note: 'covered by verify gate for apps/web',
    })
  })
})

describe('removeVerifyGate', () => {
  it('deletes a gate by id', async () => {
    const { addVerifyGate, removeVerifyGate, listVerifyGates } =
      await import('../verify-gates.js')
    const id = await addVerifyGate({ name: 'typecheck', cmd: 'npx' })

    await removeVerifyGate(id)

    const gates = await listVerifyGates()
    expect(gates).toHaveLength(0)
  })

  it('deletes a gate by {scope, name}', async () => {
    const { addVerifyGate, removeVerifyGate, listVerifyGates } =
      await import('../verify-gates.js')
    await addVerifyGate({ scope: 'apps/web', name: 'test', cmd: 'npm' })

    await removeVerifyGate({ scope: 'apps/web', name: 'test' })

    const gates = await listVerifyGates()
    expect(gates).toHaveLength(0)
  })

  it('silently does nothing when the gate does not exist', async () => {
    const { removeVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    await expect(removeVerifyGate('non-existent-id')).resolves.toBeUndefined()
    await expect(
      removeVerifyGate({ scope: '.', name: 'no-such-step' }),
    ).resolves.toBeUndefined()
    expect(await listVerifyGates()).toHaveLength(0)
  })
})

describe('listVerifyGates', () => {
  it('returns gates ordered by scope then created_at', async () => {
    const { addVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({ scope: 'apps/web', name: 'test', cmd: 'npm' })
    await addVerifyGate({ scope: '.', name: 'typecheck', cmd: 'npx' })
    await addVerifyGate({ scope: '.', name: 'lint', cmd: 'eslint' })

    const gates = await listVerifyGates()
    expect(gates).toHaveLength(3)
    // Root scope first (lexicographic: '.' < 'apps/web')
    expect(gates[0].scope).toBe('.')
    expect(gates[1].scope).toBe('.')
    expect(gates[2].scope).toBe('apps/web')
  })

  it('returns an empty array when no gates exist', async () => {
    const { listVerifyGates } = await import('../verify-gates.js')
    await expect(listVerifyGates()).resolves.toEqual([])
  })

  it('keeps quarantined gates visible with their latest failure evidence', async () => {
    const { addVerifyGate, quarantineVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    const id = await addVerifyGate({ name: 'typecheck', cmd: 'npx' })

    await quarantineVerifyGate(client, id, 'verify:typecheck:exit-1', 'origin-123')

    await expect(listVerifyGates()).resolves.toEqual([
      expect.objectContaining({
        id,
        state: 'quarantined',
        quarantineSignature: 'verify:typecheck:exit-1',
        lastFailureSignature: 'verify:typecheck:exit-1',
        lastFailureOriginId: 'origin-123',
        quarantinedAt: expect.any(Number),
        lastFailureAt: expect.any(Number),
      }),
    ])
  })
})

describe('loadVerifyGates', () => {
  it('returns an empty array when no gates exist', async () => {
    const { loadVerifyGates } = await import('../verify-gates.js')
    await expect(loadVerifyGates(client)).resolves.toEqual([])
  })

  it('groups gates by scope into VerifyScope[]', async () => {
    const { addVerifyGate, loadVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({ scope: '.', name: 'typecheck', cmd: 'npx', args: ['tsc'] })
    await addVerifyGate({ scope: '.', name: 'lint', cmd: 'eslint', required: false })
    await addVerifyGate({ scope: 'apps/web', name: 'test', cmd: 'npm', args: ['test'] })

    const scopes = await loadVerifyGates(client)

    expect(scopes).toHaveLength(2)

    const rootScope = scopes.find((s) => s.scope === '.')
    expect(rootScope).toBeDefined()
    expect(rootScope!.steps).toHaveLength(2)
    expect(rootScope!.steps[0]).toMatchObject({
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc'],
      required: true,
      tier: 'task',
      dir: '.',
    })
    expect(rootScope!.steps[1]).toMatchObject({
      name: 'lint',
      cmd: 'eslint',
      required: false,
      dir: '.',
    })

    const webScope = scopes.find((s) => s.scope === 'apps/web')
    expect(webScope).toBeDefined()
    expect(webScope!.steps).toHaveLength(1)
    expect(webScope!.steps[0]).toMatchObject({
      name: 'test',
      cmd: 'npm',
      args: ['test'],
      dir: 'apps/web',
    })
  })

  it('sets dir on each step equal to its scope', async () => {
    const { addVerifyGate, loadVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({ scope: 'packages/core', name: 'build', cmd: 'tsc' })

    const scopes = await loadVerifyGates(client)
    expect(scopes[0].steps[0].dir).toBe('packages/core')
  })

  it('omits tier from step spec when tier is task (selectVerifySteps compat)', async () => {
    const { addVerifyGate, loadVerifyGates } = await import('../verify-gates.js')
    // Default tier is 'task'
    await addVerifyGate({ scope: '.', name: 'typecheck', cmd: 'npx' })

    const scopes = await loadVerifyGates(client)
    const step = scopes[0].steps[0]
    // 'task' is a valid tier value so it should be present
    expect(step.tier).toBe('task')
  })

  it('preserves integration tier steps', async () => {
    const { addVerifyGate, loadVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({
      scope: '.',
      name: 'full-suite',
      cmd: 'npm',
      args: ['test'],
      tier: 'integration',
    })

    const scopes = await loadVerifyGates(client)
    expect(scopes[0].steps[0].tier).toBe('integration')
  })

  it('excludes quarantined gates until activation while retaining their latest failure', async () => {
    const { addVerifyGate, activateVerifyGate, loadVerifyGates, listVerifyGates, quarantineVerifyGate } =
      await import('../verify-gates.js')
    const quarantined = await addVerifyGate({ scope: '.', name: 'typecheck', cmd: 'npx' })
    await addVerifyGate({ scope: '.', name: 'lint', cmd: 'eslint' })

    await quarantineVerifyGate(client, quarantined, 'verify:typecheck:exit-1', 'origin-123')
    await quarantineVerifyGate(client, quarantined, 'verify:typecheck:exit-1', 'origin-123')

    await expect(loadVerifyGates(client)).resolves.toEqual([
      expect.objectContaining({
        scope: '.',
        steps: [expect.objectContaining({ name: 'lint' })],
      }),
    ])

    await activateVerifyGate(quarantined)
    await activateVerifyGate(quarantined)

    const scopes = await loadVerifyGates(client)
    expect(scopes[0].steps.map((step) => step.name)).toEqual(['typecheck', 'lint'])
    await expect(listVerifyGates()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: quarantined,
        state: 'active',
        quarantinedAt: null,
        quarantineSignature: null,
        lastFailureSignature: 'verify:typecheck:exit-1',
        lastFailureOriginId: 'origin-123',
        lastFailureAt: expect.any(Number),
      }),
    ]))
  })
})
