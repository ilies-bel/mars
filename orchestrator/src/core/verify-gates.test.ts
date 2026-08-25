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

  it('returns null for evidence when no evidence is provided', async () => {
    const id = await addVerifyGate({
      name: 'test-without-evidence',
      cmd: 'npx',
      args: ['vitest', 'run'],
    })
    const gate = await getVerifyGate(id)
    expect(gate).not.toBeNull()
    expect(gate!.evidence).toBeNull()
  })
})
