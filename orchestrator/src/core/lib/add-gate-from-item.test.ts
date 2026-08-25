/**
 * Tests for the `add-gate` entity handler factory.
 *
 * All tests use injected stubs — no DB or daemon process required.
 */

import { describe, expect, it } from 'vitest'
import { createAddGateFromItem, type AddGateFromItemDeps } from './add-gate-from-item.js'
import type { ActionQueueItem } from './action-queue.js'
import type { VerifyGateInput } from '../verify-gates.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeItem = (overrides: Partial<ActionQueueItem> = {}): ActionQueueItem => ({
  id: 'aq-test-001',
  kind: 'verify-uncovered',
  category: 'coverage',
  priority: 'normal',
  status: 'open',
  title: 'Missing verify gate',
  body: 'A task merged without automated coverage',
  payload: {},
  context: {},
  raisedBy: 'system',
  raisedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_000_000,
  seenCount: 1,
  fingerprint: 'fp-001',
  signature: null,
  resolvedAt: null,
  resolution: null,
  resolutionDetails: null,
  resolutionNote: null,
  rootCause: null,
  history: [],
  originTaskId: null,
  liveTaskStatus: null,
  snoozedUntil: null,
  ...overrides,
})

const makeStubs = (
  item: ActionQueueItem | null,
): {
  deps: AddGateFromItemDeps
  addedGates: VerifyGateInput[]
  resolvedItems: { id: string; note: string }[]
} => {
  const addedGates: VerifyGateInput[] = []
  const resolvedItems: { id: string; note: string }[] = []
  const deps: AddGateFromItemDeps = {
    getItem: async (_id) => item,
    addVerifyGate: async (input) => {
      addedGates.push(input)
      return 'gate-stub-uuid'
    },
    resolveItem: async (id, note) => {
      resolvedItems.push({ id, note })
    },
  }
  return { deps, addedGates, resolvedItems }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createAddGateFromItem', () => {
  it('creates gate with source=observation and resolves the item', async () => {
    const proposedGate = {
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      scope: 'orchestrator',
      evidence: 'ts errors observed after merge',
    }
    const item = makeItem({
      id: 'aq-gate-001',
      payload: { proposedGate, scope: 'orchestrator' },
    })
    const { deps, addedGates, resolvedItems } = makeStubs(item)

    await createAddGateFromItem(deps)('aq-gate-001')

    // Gate was registered with the correct fields
    expect(addedGates).toHaveLength(1)
    expect(addedGates[0]).toMatchObject({
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      scope: 'orchestrator',
      evidence: 'ts errors observed after merge',
      source: 'observation',
    })

    // Action-queue item was resolved with the expected note
    expect(resolvedItems).toHaveLength(1)
    expect(resolvedItems[0]).toEqual({ id: 'aq-gate-001', note: 'gate added by operator' })
  })

  it('works when args and evidence are absent from proposedGate', async () => {
    const item = makeItem({
      id: 'aq-gate-002',
      payload: {
        proposedGate: { name: 'lint', cmd: 'npm', scope: '.' },
      },
    })
    const { deps, addedGates, resolvedItems } = makeStubs(item)

    await createAddGateFromItem(deps)('aq-gate-002')

    expect(addedGates[0]).toMatchObject({ name: 'lint', cmd: 'npm', source: 'observation' })
    expect(addedGates[0]?.args).toBeUndefined()
    expect(addedGates[0]?.evidence).toBeUndefined()
    expect(resolvedItems).toHaveLength(1)
  })

  it('throws NOT_FOUND when the item does not exist', async () => {
    const { deps } = makeStubs(null)

    await expect(createAddGateFromItem(deps)('aq-missing-999')).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
      code: 'NOT_FOUND',
    })
  })

  it('throws NO_PROPOSED_GATE when payload has no proposedGate', async () => {
    const item = makeItem({
      id: 'aq-no-gate-003',
      payload: { scope: 'orchestrator' },
    })
    const { deps } = makeStubs(item)

    await expect(createAddGateFromItem(deps)('aq-no-gate-003')).rejects.toMatchObject({
      message: expect.stringContaining('no proposedGate in its payload'),
      code: 'NO_PROPOSED_GATE',
    })
  })

  it('throws INCOMPLETE_PROPOSED_GATE when name is missing', async () => {
    const item = makeItem({
      id: 'aq-incomplete-004',
      payload: { proposedGate: { cmd: 'npx' } },
    })
    const { deps } = makeStubs(item)

    await expect(createAddGateFromItem(deps)('aq-incomplete-004')).rejects.toMatchObject({
      code: 'INCOMPLETE_PROPOSED_GATE',
    })
  })

  it('throws INCOMPLETE_PROPOSED_GATE when cmd is missing', async () => {
    const item = makeItem({
      id: 'aq-incomplete-005',
      payload: { proposedGate: { name: 'typecheck' } },
    })
    const { deps } = makeStubs(item)

    await expect(createAddGateFromItem(deps)('aq-incomplete-005')).rejects.toMatchObject({
      code: 'INCOMPLETE_PROPOSED_GATE',
    })
  })
})
