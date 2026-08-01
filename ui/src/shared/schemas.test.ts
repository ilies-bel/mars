/**
 * Behavioural tests for actionQueueResponseSchema.
 *
 * Tests verify that the schema correctly parses all daemon-returned
 * action-queue item kinds without falling through to the epoch-0 catch
 * sentinel. Each test uses a minimal realistic payload matching what the
 * daemon's buildActionQueueView emits.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { actionQueueResponseSchema, chatThreadSchema, type ChatThread } from './schemas'

// Minimal base fields shared across all item kinds.
const base = {
  id: 'row-1',
  entityId: 'entity-1',
  priority: 'high' as const,
  title: 'Test title',
  body: 'Test body',
  at: '2024-06-01T12:00:00.000Z',
  dag: null,
  errorKind: 'some-kind',
  actions: [],
  humanSummary: '',
  verbs: [],
}

describe('actionQueueResponseSchema — known kinds parse correctly', () => {
  it('parses awaiting-human without falling to epoch-0 sentinel', () => {
    const input = [{ ...base, kind: 'awaiting-human', leaseState: null }]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(result[0]!.kind).toBe('awaiting-human')
  })

  it('parses awaiting-human with a populated leaseState', () => {
    const input = [
      {
        ...base,
        kind: 'awaiting-human',
        leaseState: {
          leaseOwner: 'user@host',
          leasedAt: '2024-06-01T11:00:00.000Z',
          leaseNote: null,
        },
      },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result[0]!.kind).toBe('awaiting-human')
    // After narrowing we can access leaseState
    const row = result[0]!
    if (row.kind === 'awaiting-human') {
      expect(row.leaseState?.leaseOwner).toBe('user@host')
    }
  })

  it('parses reflect-recommended without falling to epoch-0 sentinel', () => {
    const input = [{ ...base, kind: 'reflect-recommended' }]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(result[0]!.kind).toBe('reflect-recommended')
  })

  it('parses scorer-suggested without falling to epoch-0 sentinel', () => {
    const input = [{ ...base, kind: 'scorer-suggested' }]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(result[0]!.kind).toBe('scorer-suggested')
  })

  it('preserves the correct `at` timestamp for awaiting-human rows', () => {
    const ts = '2024-09-15T08:30:00.000Z'
    const input = [{ ...base, kind: 'awaiting-human', at: ts, leaseState: null }]
    const result = actionQueueResponseSchema.parse(input)
    expect(result[0]!.at).toBe(ts)
  })

  it('handles a mixed array including new and pre-existing kinds', () => {
    const input = [
      { ...base, id: 'r1', kind: 'awaiting-human', leaseState: null },
      { ...base, id: 'r2', kind: 'reflect-recommended' },
      { ...base, id: 'r3', kind: 'scorer-suggested' },
      { ...base, id: 'r4', kind: 'failed' },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(4)
    // No epoch-0 sentinels in a valid mixed array
    for (const row of result) {
      expect(row.at).not.toBe('1970-01-01T00:00:00.000Z')
    }
    const kinds = result.map((r) => r.kind)
    expect(kinds).toContain('awaiting-human')
    expect(kinds).toContain('reflect-recommended')
    expect(kinds).toContain('scorer-suggested')
    expect(kinds).toContain('failed')
  })
})

describe('chatThreadSchema — session-free contract', () => {
  it('drops legacy provider-session fields from a chat thread payload', () => {
    const thread = chatThreadSchema.parse({
      id: 'thread-1',
      title: 'Test chat',
      status: 'idle',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
      sessionId: 'provider-session-1',
      contextSeeded: true,
    })

    expect(thread).not.toHaveProperty('sessionId')
    expect(thread).not.toHaveProperty('contextSeeded')
  })

  it('infers a chat thread without provider-session fields', () => {
    expectTypeOf<ChatThread>().not.toHaveProperty('sessionId')
    expectTypeOf<ChatThread>().not.toHaveProperty('contextSeeded')
  })
})
