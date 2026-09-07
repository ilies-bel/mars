/**
 * Behavioural tests for actionQueueResponseSchema.
 *
 * Tests verify that the schema correctly parses all daemon-returned
 * action-queue item kinds without falling through to the epoch-0 catch
 * sentinel. Each test uses a minimal realistic payload matching what the
 * daemon's buildActionQueueView emits (HR-3 wire envelope: every row is
 * either `{type:'item', row:{...}}` or `{type:'group', ...}`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  actionQueueResponseSchema,
  chatThreadSchema,
  eventsResponseSchema,
  preloadedResponseSchema,
  type ChatThread,
} from './schemas'

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

/** Wrap a flat item in the HR-3 wire envelope that the daemon sends. */
const wire = (row: typeof base & Record<string, unknown>) => ({ type: 'item' as const, row })

describe('eventsResponseSchema', () => {
  it('keeps valid events when one daemon event is malformed', () => {
    const result = eventsResponseSchema.parse({
      events: [
        {
          id: 'event-valid-before',
          timestamp: 1_700_000_000_000,
          kind: 'task_started',
          severity: 'info',
          taskId: 'task-1',
          originId: null,
          phase: 'setup',
          payload: {},
        },
        {
          id: 'event-malformed',
          timestamp: 'not-an-epoch',
          kind: 'timestamp-drift',
        },
        {
          id: 'event-valid-after',
          timestamp: 1_700_000_000_001,
          kind: 'task_completed',
          severity: 'info',
          taskId: 'task-1',
          originId: null,
          phase: 'merge',
          payload: {},
        },
      ],
      nextCursor: null,
    })

    expect(result.events.map((event) => event.id)).toEqual([
      'event-valid-before',
      'event-malformed',
      'event-valid-after',
    ])
    expect(result.events[1]).toMatchObject({
      id: 'event-malformed',
      kind: 'timestamp-drift',
      timestamp: 0,
    })
  })
})

describe('actionQueueResponseSchema — known kinds parse correctly', () => {
  it('parses awaiting-human without falling to epoch-0 sentinel', () => {
    const input = [wire({ ...base, kind: 'awaiting-human', leaseState: null })]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('item')
    const row = result[0]!.type === 'item' ? result[0]!.row : null
    expect(row?.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(row?.kind).toBe('awaiting-human')
  })

  it('parses awaiting-human with a populated leaseState', () => {
    const input = [
      wire({
        ...base,
        kind: 'awaiting-human',
        leaseState: {
          leaseOwner: 'user@host',
          leasedAt: '2024-06-01T11:00:00.000Z',
          leaseNote: null,
        },
      }),
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result[0]!.type).toBe('item')
    const row = result[0]!.type === 'item' ? result[0]!.row : null
    expect(row?.kind).toBe('awaiting-human')
    if (row?.kind === 'awaiting-human') {
      expect(row.leaseState?.leaseOwner).toBe('user@host')
    }
  })

  it('parses reflect-recommended without falling to epoch-0 sentinel', () => {
    const input = [wire({ ...base, kind: 'reflect-recommended' })]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    const row = result[0]!.type === 'item' ? result[0]!.row : null
    expect(row?.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(row?.kind).toBe('reflect-recommended')
  })

  it('parses scorer-suggested without falling to epoch-0 sentinel', () => {
    const input = [wire({ ...base, kind: 'scorer-suggested' })]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    const row = result[0]!.type === 'item' ? result[0]!.row : null
    expect(row?.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(row?.kind).toBe('scorer-suggested')
  })

  it('preserves the correct `at` timestamp for awaiting-human rows', () => {
    const ts = '2024-09-15T08:30:00.000Z'
    const input = [wire({ ...base, kind: 'awaiting-human', at: ts, leaseState: null })]
    const result = actionQueueResponseSchema.parse(input)
    const row = result[0]!.type === 'item' ? result[0]!.row : null
    expect(row?.at).toBe(ts)
  })

  it('handles a mixed array including new and pre-existing kinds', () => {
    const input = [
      wire({ ...base, id: 'r1', kind: 'awaiting-human', leaseState: null }),
      wire({ ...base, id: 'r2', kind: 'reflect-recommended' }),
      wire({ ...base, id: 'r3', kind: 'scorer-suggested' }),
      wire({ ...base, id: 'r4', kind: 'failed' }),
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(4)
    // No epoch-0 sentinels in a valid mixed array
    for (const entry of result) {
      const at = entry.type === 'item' ? entry.row.at : entry.firstAt
      expect(at).not.toBe('1970-01-01T00:00:00.000Z')
    }
    const kinds = result.map((r) => r.type === 'item' ? r.row.kind : r.kind)
    expect(kinds).toContain('awaiting-human')
    expect(kinds).toContain('reflect-recommended')
    expect(kinds).toContain('scorer-suggested')
    expect(kinds).toContain('failed')
  })

  /**
   * The fixtures above carry `verbs: []`, which is why they never caught the
   * real defect: the daemon's `failed` recipe emits a destructive verb, its
   * style word disagreed with this schema's enum, and one unrecognised style
   * value fails the WHOLE row — the catch then rebuilt it minus `arcGoal`,
   * `humanSummary` and `humanDetail`. Every failed alert rendered as a bare
   * title with no cause, and both `at` and `kind` (all the tests above assert)
   * survived that, so the suite stayed green.
   *
   * The verbs below are copied from the `failed` recipe in
   * orchestrator/src/core/lib/action-queue-recipes.ts. If that recipe's style
   * vocabulary drifts from `alertVerbSchema` again, this fails.
   */
  it('keeps the narrative fields on a failed row carrying real daemon verbs', () => {
    const input = [
      wire({
        ...base,
        kind: 'failed',
        arcGoal: '# Some task prompt excerpt',
        humanSummary: 'A task got stuck and Mars used up its retry.',
        humanDetail: {
          raisedAt: '2024-06-01T12:00:00.000Z',
          entityId: 'entity-1',
          failureSignature: 'code:context-exhausted/unclassified',
          errorExcerpt: 'context budget exhausted (maxContextTokens) mid-code',
          branch: 'task/entity-1',
          worktree: '/repo/.mars/worktrees/entity-1',
        },
        verbs: [
          { op: 'restart', label: 'Restart', style: 'primary' },
          { op: 'purge', label: 'Discard task', style: 'destructive' },
          { op: 'dismiss', label: 'Dismiss', style: 'default' },
          { op: 'snooze', label: 'Snooze', style: 'default' },
        ],
      }),
    ]

    const entry = actionQueueResponseSchema.parse(input)[0]!
    expect(entry.type).toBe('item')
    const row = entry.type === 'item' ? entry.row : null

    expect(row?.kind).toBe('failed')
    expect(row?.verbs).toHaveLength(4)
    // The fields the catch-sentinel drops. Their loss is what made the queue
    // unreadable, and none of it is recoverable client-side.
    expect(row?.arcGoal).toBe('# Some task prompt excerpt')
    expect(row?.humanSummary).toBe('A task got stuck and Mars used up its retry.')
    expect(row?.humanDetail?.failureSignature).toBe('code:context-exhausted/unclassified')
    expect(row?.humanDetail?.branch).toBe('task/entity-1')
  })
})

describe('actionQueueResponseSchema — at sentinel threading', () => {
  it('uses raw.row.at for an item row whose inner kind is unrecognised by the union', () => {
    // 'tool-promotion' is absent from every union variant, so the inner item parse
    // hits the catch. The re-parse as kind='failed' also fails because
    // priority:'critical' is not in the schema, forcing the sentinel path.
    // The sentinel must use raw.row.at rather than the hardcoded epoch-0 string.
    const ts = '2026-08-15T10:00:00.000Z'
    const input = [
      {
        type: 'item' as const,
        row: {
          ...base,
          at: ts,
          kind: 'tool-promotion',
          priority: 'critical', // invalid → forces the final sentinel path
          errorKind: 'tool-promotion',
        },
      },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('item')
    const row = result[0]!.type === 'item' ? result[0]!.row : null
    expect(row?.at).toBe(ts)
    expect(row?.at).not.toBe('1970-01-01T00:00:00.000Z')
  })

  it('throws a parse error when at is absent from an item row with unrecognised kind', () => {
    // Both the inner union parse and the re-parse-as-failed fail, and raw.row.at
    // is absent. The sentinel must propagate a parse error rather than silently
    // defaulting to epoch-0 ("56y ago").
    const { at: _dropped, ...noAt } = base
    const input = [
      {
        type: 'item' as const,
        row: {
          ...noAt,
          kind: 'tool-promotion',
          priority: 'critical', // keeps the row out of the re-parse-as-failed success path
          errorKind: 'tool-promotion',
        },
      },
    ]
    expect(() => actionQueueResponseSchema.parse(input)).toThrow()
  })

  it('degrades a malformed group row to a sentinel group without throwing', () => {
    // Group rows have no `at` field — the catch must never trigger the
    // at-missing throw for them.
    const input = [
      {
        type: 'group' as const,
        kind: 'failed',
        count: 'not-a-number', // invalid
        causeLabel: 'context window exhausted',
        signature: 'code:context-exhausted/unclassified',
        firstAt: '2026-01-01T00:00:00.000Z',
        lastAt: '2026-01-02T00:00:00.000Z',
        priority: 'high',
        members: [],
      },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('group')
  })
})

/**
 * Contract tests: parse LITERAL payload shapes copied from the real daemon
 * wire format (commit 452bef166, HR-3 shared view layer). If the daemon wire
 * format changes and the schema is not updated, these tests fail before the
 * page goes blank — exactly the signal that was missing during the outage.
 */
describe('actionQueueResponseSchema — wire format contract', () => {
  it('parses a literal item wire row as emitted by the daemon', () => {
    const input = [
      {
        "type": "item",
        "row": {
          "id": "failed-task:t-abc123",
          "kind": "failed",
          "entityId": "t-abc123",
          "priority": "high",
          "title": "Task failed",
          "body": "The task failed with context exhausted.",
          "at": "2026-09-01T10:00:00.000Z",
          "dag": null,
          "errorKind": "failed",
          "actions": [],
          "humanSummary": "A task got stuck and Mars used up its retry.",
          "verbs": [{ "op": "continue", "label": "Continue", "style": "primary" }],
          "decisions": [],
          "recoveryExhausted": false,
          "failureReasonCode": "code:context-exhausted/unclassified"
        }
      },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('item')
    if (result[0]!.type === 'item') {
      expect(result[0]!.row.kind).toBe('failed')
      expect(result[0]!.row.at).toBe('2026-09-01T10:00:00.000Z')
      expect(result[0]!.row.failureReasonCode).toBe('code:context-exhausted/unclassified')
    }
  })

  it('parses a literal group wire row as emitted by the daemon', () => {
    const input = [
      {
        "type": "group",
        "kind": "failed",
        "count": 18,
        "causeLabel": "context window exhausted",
        "signature": "code:context-exhausted/unclassified",
        "firstAt": "2026-09-01T08:00:00.000Z",
        "lastAt": "2026-09-01T10:00:00.000Z",
        "priority": "high",
        "class": "alert",
        "previewIds": ["t-1", "t-2", "t-3"],
        "members": []
      },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('group')
    if (result[0]!.type === 'group') {
      expect(result[0]!.count).toBe(18)
      expect(result[0]!.causeLabel).toBe('context window exhausted')
      expect(result[0]!.signature).toBe('code:context-exhausted/unclassified')
      expect(result[0]!.priority).toBe('high')
    }
  })

  it('parses a mixed response with both item and group rows', () => {
    const input = [
      {
        "type": "group",
        "kind": "failed",
        "count": 5,
        "causeLabel": "verify timeout",
        "signature": "verify:timeout/unknown",
        "firstAt": "2026-09-01T08:00:00.000Z",
        "lastAt": "2026-09-01T09:00:00.000Z",
        "priority": "normal",
        "previewIds": [],
        "members": []
      },
      {
        "type": "item",
        "row": {
          "id": "stale-worktree:t-xyz",
          "kind": "stale-worktree",
          "entityId": "t-xyz",
          "priority": "low",
          "title": "Stale worktree",
          "body": "The worktree has not been updated in 48 hours.",
          "at": "2026-09-01T10:00:00.000Z",
          "dag": null,
          "errorKind": "stale-worktree",
          "actions": [],
          "humanSummary": "",
          "verbs": [],
          "decisions": [],
          "staleWorktreeDetail": {
            "prompt": "implement X",
            "status": "running",
            "ageHours": 48,
            "updatedAt": "2026-08-30T10:00:00.000Z",
            "branch": "task/t-xyz",
            "empty": false,
            "investigation": null
          }
        }
      },
    ]
    const result = actionQueueResponseSchema.parse(input)
    expect(result).toHaveLength(2)
    expect(result[0]!.type).toBe('group')
    expect(result[1]!.type).toBe('item')
    if (result[1]!.type === 'item') {
      expect(result[1]!.row.kind).toBe('stale-worktree')
    }
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

describe('preloadedResponseSchema', () => {
  it('accepts a client-only proposal Subject target', () => {
    expect(preloadedResponseSchema.parse({
      id: 'grill-draft-1',
      label: 'Grill: Make queue clearer',
      target: { type: 'client', op: 'open-proposal-subject', entityId: 'draft-1' },
    })).toMatchObject({
      target: { type: 'client', op: 'open-proposal-subject', entityId: 'draft-1' },
    })
  })
})
