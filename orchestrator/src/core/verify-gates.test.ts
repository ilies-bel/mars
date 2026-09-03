import { beforeAll, describe, expect, it } from 'vitest'
import { resolveStateClient } from './store/state-client.js'
import { ensureVerifyGatesSchema, addVerifyGate, getVerifyGate } from './verify-gates.js'

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
