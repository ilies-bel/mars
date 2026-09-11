import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveStateClient } from './store/state-client.js'
import {
  ensureVerifyGatesSchema,
  addVerifyGate,
  getVerifyGate,
  listVerifyGates,
  recordVerifyGatePasses,
  isWholeSuiteCommand,
  assertNotWholeSuiteIntegrationGate,
} from './verify-gates.js'

beforeAll(async () => {
  const client = resolveStateClient()
  await ensureVerifyGatesSchema(client)
})

describe('verify-gates evidence round-trip', () => {
  it('persists and returns evidence when an evidence string is provided', async () => {
    const id = await addVerifyGate({
      name: 'test-with-evidence',
      cmd: 'npx',
      args: ['vitest', 'run'],
      evidence: 'observed 3 consecutive failures across unrelated tasks',
    })
    const gate = await getVerifyGate(id)
    expect(gate).not.toBeNull()
    expect(gate!.evidence).toBe('observed 3 consecutive failures across unrelated tasks')
  })

  it('throws when no evidence is provided for human-sourced gate (DEC-11)', async () => {
    // Human-path gates must carry evidence: no silent null-evidence rows.
    await expect(
      addVerifyGate({
        name: 'test-without-evidence',
        cmd: 'npx',
        args: ['vitest', 'run'],
      }),
    ).rejects.toThrow(/evidence is required/)
  })
})

describe('recordVerifyGatePasses', () => {
  it('stamps last_pass_at on the specified gates', async () => {
    const id = await addVerifyGate({
      name: 'rp-stamp-test',
      cmd: 'echo',
      args: ['ok'],
      evidence: 'test fixture for recordVerifyGatePasses',
    })

    const before = await getVerifyGate(id)
    expect(before!.lastPassAt).toBeNull()

    const t0 = Date.now()
    await recordVerifyGatePasses([id])
    const t1 = Date.now()

    const after = await getVerifyGate(id)
    expect(after!.lastPassAt).not.toBeNull()
    expect(after!.lastPassAt).toBeGreaterThanOrEqual(t0)
    expect(after!.lastPassAt).toBeLessThanOrEqual(t1)
  })

  it('does not stamp gates absent from the passed list', async () => {
    const passedId = await addVerifyGate({
      name: 'rp-passed-gate',
      cmd: 'echo',
      args: ['pass'],
      evidence: 'test fixture for recordVerifyGatePasses selective update',
    })
    const skippedId = await addVerifyGate({
      name: 'rp-skipped-gate',
      cmd: 'echo',
      args: ['skip'],
      evidence: 'test fixture for recordVerifyGatePasses selective update',
    })

    await recordVerifyGatePasses([passedId])

    const passed = await getVerifyGate(passedId)
    const skipped = await getVerifyGate(skippedId)
    expect(passed!.lastPassAt).not.toBeNull()
    expect(skipped!.lastPassAt).toBeNull()
  })

  it('is a no-op for an empty list', async () => {
    await expect(recordVerifyGatePasses([])).resolves.toBeUndefined()
  })


  it('a gate whose lastPassAt is newer than lastFailureAt is considered passing', async () => {
    // This is the core invariant the Control Room panel depends on:
    // once last_pass_at is stamped by the merge worker via recordVerifyGatePasses,
    // the isCurrentlyFailing check (lastFailureAt > lastPassAt) correctly resolves
    // to false — the gate shows as "passing" rather than pinned-as-failing.
    const c = resolveStateClient()
    const id = await addVerifyGate({
      name: 'rp-invariant-test',
      cmd: 'echo',
      args: ['run'],
      evidence: 'test fixture for pass-newer-than-failure invariant',
    })

    // Simulate a historical failure recorded before the pass.
    const failureTime = Date.now() - 5_000
    await c.execute(`UPDATE verify_gates SET last_failure_at = ? WHERE id = ?`, [failureTime, id])

    // Record a passing run (will be stamped with Date.now() > failureTime).
    await recordVerifyGatePasses([id])

    const gate = await getVerifyGate(id)
    expect(gate!.lastPassAt).not.toBeNull()
    expect(gate!.lastFailureAt).not.toBeNull()
    // Pass is more recent than failure → gate is currently passing.
    expect(gate!.lastPassAt!).toBeGreaterThan(gate!.lastFailureAt!)
    // The UI's isCurrentlyFailing formula: lastFailureAt > lastPassAt → false.
    expect(gate!.lastFailureAt! > gate!.lastPassAt!).toBe(false)
  })
})

describe('isWholeSuiteCommand', () => {
  it('returns true for bare npm test', () => {
    expect(isWholeSuiteCommand('npm', ['test'])).toBe(true)
  })

  it('returns true for npm run test', () => {
    expect(isWholeSuiteCommand('npm', ['run', 'test'])).toBe(true)
  })

  it('returns true for npx vitest run with no file argument', () => {
    expect(isWholeSuiteCommand('npx', ['vitest', 'run'])).toBe(true)
  })

  it('returns true for npx vitest with no file argument (watch mode)', () => {
    expect(isWholeSuiteCommand('npx', ['vitest'])).toBe(true)
  })

  it('returns true for vitest run with no file argument', () => {
    expect(isWholeSuiteCommand('vitest', ['run'])).toBe(true)
  })

  it('returns true for npx vitest run with only flag arguments', () => {
    expect(isWholeSuiteCommand('npx', ['vitest', 'run', '--reporter=json'])).toBe(true)
  })

  it('returns false for npx vitest run with a file argument', () => {
    expect(isWholeSuiteCommand('npx', ['vitest', 'run', 'src/core/foo.test.ts'])).toBe(false)
  })

  it('returns false for npm run typecheck (not a test runner)', () => {
    expect(isWholeSuiteCommand('npm', ['run', 'typecheck'])).toBe(false)
  })

  it('returns false for npm run test:src (scoped npm script)', () => {
    expect(isWholeSuiteCommand('npm', ['run', 'test:src'])).toBe(false)
  })
})

describe('whole-suite integration gate rejection', () => {
  it('addVerifyGate rejects a required integration-tier gate with bare npm test', async () => {
    await expect(
      addVerifyGate({
        name: 'whole-suite-npm-test',
        cmd: 'npm',
        args: ['test'],
        tier: 'integration',
        required: true,
        evidence: 'test fixture for whole-suite rejection',
      }),
    ).rejects.toMatchObject({ code: 'WHOLE_SUITE_INTEGRATION_GATE' })
  })

  it('addVerifyGate rejects a required integration-tier gate with npx vitest run (no file)', async () => {
    await expect(
      addVerifyGate({
        name: 'whole-suite-vitest-run',
        cmd: 'npx',
        args: ['vitest', 'run'],
        tier: 'integration',
        required: true,
        evidence: 'test fixture for whole-suite rejection',
      }),
    ).rejects.toMatchObject({ code: 'WHOLE_SUITE_INTEGRATION_GATE' })
  })

  it('addVerifyGate allows a required integration-tier gate with a scoped vitest command', async () => {
    const id = await addVerifyGate({
      name: 'scoped-integration-gate',
      cmd: 'npx',
      args: ['vitest', 'run', 'src/core/cross-package.test.ts'],
      tier: 'integration',
      required: true,
      evidence: 'test fixture for scoped integration gate',
    })
    const gate = await getVerifyGate(id)
    expect(gate).not.toBeNull()
    expect(gate!.required).toBe(true)
    expect(gate!.tier).toBe('integration')
  })

  it('addVerifyGate allows a non-required integration-tier gate with bare npm test', async () => {
    // Non-required whole-suite gates are informational only — they do not hold
    // the merge lock and the budget constraint does not apply to them.
    const id = await addVerifyGate({
      name: 'informational-whole-suite',
      cmd: 'npm',
      args: ['test'],
      tier: 'integration',
      required: false,
      evidence: 'test fixture for non-required whole-suite gate',
    })
    const gate = await getVerifyGate(id)
    expect(gate).not.toBeNull()
    expect(gate!.required).toBe(false)
  })

  it('addVerifyGate allows a required task-tier gate with npm test (task tier does not hold merge lock)', async () => {
    // The restriction only applies to integration-tier gates — task-tier gates
    // run outside the merge lock via onVerifyRebasedTree and can be whole-suite
    // if the operator accepts the verify-step budget trade-off.
    const id = await addVerifyGate({
      name: 'task-tier-npm-test',
      cmd: 'npm',
      args: ['test'],
      tier: 'task',
      evidence: 'test fixture for task-tier whole-suite gate',
    })
    const gate = await getVerifyGate(id)
    expect(gate).not.toBeNull()
    expect(gate!.tier).toBe('task')
  })

  it('assertNotWholeSuiteIntegrationGate is independently callable without a DB insertion', () => {
    expect(() =>
      assertNotWholeSuiteIntegrationGate('integration', true, 'npm', ['test'], 'my-gate'),
    ).toThrow(/whole suite/)
    // Non-throwing variants
    expect(() =>
      assertNotWholeSuiteIntegrationGate('task', true, 'npm', ['test'], 'my-gate'),
    ).not.toThrow()
    expect(() =>
      assertNotWholeSuiteIntegrationGate('integration', false, 'npm', ['test'], 'my-gate'),
    ).not.toThrow()
    expect(() =>
      assertNotWholeSuiteIntegrationGate('integration', true, 'npx', ['vitest', 'run', 'src/foo.test.ts'], 'my-gate'),
    ).not.toThrow()
  })
})

describe('whole-suite migration in ensureVerifyGatesSchema', () => {
  it('downgrades an existing required integration gate with a whole-suite command to non-required', async () => {
    const c = resolveStateClient()
    // Seed a broken row directly, bypassing addVerifyGate validation, to simulate
    // a pre-guardrail registration that exists in the database.
    const brokenId = randomUUID()
    await c.execute(
      `INSERT INTO verify_gates (id, scope, name, cmd, args_json, required, tier, source, created_at, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        brokenId,
        '.',
        `migration-test-${brokenId.slice(0, 8)}`,
        'npm',
        '["test"]',
        1,
        'integration',
        'test',
        Date.now(),
        'seeded for migration test',
      ],
    )

    // Confirm the row is required before migration
    const before = await getVerifyGate(brokenId)
    expect(before!.required).toBe(true)

    // Run the migration (idempotent — safe to call again on an existing schema)
    await ensureVerifyGatesSchema(c)

    // After migration, the gate must be non-required
    const after = await getVerifyGate(brokenId)
    expect(after!.required).toBe(false)
  })

  it('no required integration gate in the registry has a whole-suite command after migration', async () => {
    const gates = await listVerifyGates()
    const offenders = gates.filter(
      (g) => g.tier === 'integration' && g.required && isWholeSuiteCommand(g.cmd, g.args),
    )
    expect(offenders).toHaveLength(0)
  })
})
