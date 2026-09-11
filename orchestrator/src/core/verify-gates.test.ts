import { beforeAll, describe, expect, it } from 'vitest'
import { resolveStateClient } from './store/state-client.js'
import { ensureVerifyGatesSchema, addVerifyGate, getVerifyGate, recordVerifyGatePasses } from './verify-gates.js'

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
