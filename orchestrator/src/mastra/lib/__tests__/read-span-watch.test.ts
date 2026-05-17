import { describe, expect, it } from 'vitest'
import type { ClaudeEvent } from '../claude-stream'
import {
  createReadSpanWatcher,
  resolveReadSpanLimit,
  type TripInfo,
} from '../read-span-watch'

const assistant = (tools: Array<{ name: string; input?: unknown }>): ClaudeEvent => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: tools.map((t) => ({
      type: 'tool_use',
      id: `t_${t.name}`,
      name: t.name,
      input: t.input ?? {},
    })),
  },
})

describe('createReadSpanWatcher', () => {
  it('does not trip below the limit', () => {
    let tripped: TripInfo | null = null
    const w = createReadSpanWatcher({
      limit: 5,
      onTrip: (info) => {
        tripped = info
      },
    })
    for (let i = 0; i < 4; i += 1) {
      w.observe(assistant([{ name: 'Read', input: { file_path: `src/foo${i}.ts` } }]))
    }
    expect(w.streak).toBe(4)
    expect(w.tripped).toBe(false)
    expect(tripped).toBeNull()
  })

  it('trips exactly at the configured limit', () => {
    let tripped: TripInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onTrip: (info) => {
        tripped = info
      },
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Grep', input: { pattern: 'foo' } }]))
    w.observe(assistant([{ name: 'Glob', input: { pattern: '**/*.ts' } }]))
    expect(w.tripped).toBe(true)
    expect(tripped).not.toBeNull()
    const info = tripped as unknown as TripInfo
    expect(info.limit).toBe(3)
    expect(info.trace).toHaveLength(3)
    expect(info.trace[0].tool).toBe('Read')
    expect(info.trace[1].tool).toBe('Grep')
    expect(info.trace[2].tool).toBe('Glob')
  })

  it('only fires onTrip once even when more events arrive', () => {
    let calls = 0
    const w = createReadSpanWatcher({
      limit: 2,
      onTrip: () => {
        calls += 1
      },
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'b' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'c' } }]))
    expect(calls).toBe(1)
  })

  it('resets the streak on an action-class call', () => {
    let tripped: TripInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onTrip: (info) => {
        tripped = info
      },
    })
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(w.streak).toBe(2)
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'a' } }]))
    expect(w.streak).toBe(0)
    expect(tripped).toBeNull()
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(tripped).toBeNull()
  })

  it('ignores tools that are neither read nor action class', () => {
    let tripped: TripInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onTrip: (info) => {
        tripped = info
      },
    })
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'TodoWrite' }]))
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'WebFetch' }]))
    w.observe(assistant([{ name: 'Read' }]))
    expect(w.tripped).toBe(true)
    expect(tripped).not.toBeNull()
  })

  it('ignores non-assistant events', () => {
    const w = createReadSpanWatcher({
      limit: 2,
      onTrip: () => {
        throw new Error('should not trip on non-assistant events')
      },
    })
    w.observe({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })
    w.observe({ type: 'system', subtype: 'init' })
    expect(w.streak).toBe(0)
  })

  it('Bash counts as an action and resets the streak', () => {
    const w = createReadSpanWatcher({
      limit: 5,
      onTrip: () => {
        throw new Error('should not trip')
      },
    })
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'ls' } }]))
    expect(w.streak).toBe(0)
  })

  it('multiple read tool_uses in one event each count toward the streak', () => {
    let tripped: TripInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onTrip: (info) => {
        tripped = info
      },
    })
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }, { name: 'Grep' }]))
    expect(w.tripped).toBe(true)
    expect(tripped).not.toBeNull()
    expect((tripped as unknown as TripInfo).trace).toHaveLength(3)
  })
})

describe('genuine analysis-paralysis still trips after PRD f1c48e7b', () => {
  // Slice 5 of PRD f1c48e7b: removing orientation-driven false trips must
  // NOT weaken the guard against a Worker that piles up reads with no
  // plausible intervening action. These tests pin the behaviour the PRD
  // commits to preserving.

  it('trips exactly once on a run of read-class actions exceeding the limit with no intervening action', () => {
    const tripped: TripInfo[] = []
    const w = createReadSpanWatcher({
      limit: 5,
      onTrip: (info) => {
        tripped.push(info)
      },
    })
    // Eight strictly-consecutive read-class actions, no Edit/Write/Bash
    // between them — classic analysis-paralysis shape.
    for (let i = 0; i < 8; i += 1) {
      w.observe(
        assistant([{ name: 'Read', input: { file_path: `src/file${i}.ts` } }]),
      )
    }
    expect(w.tripped).toBe(true)
    expect(tripped).toHaveLength(1)
  })

  it('an intervening action resets the streak so a later read run must again exceed the limit to trip', () => {
    const tripped: TripInfo[] = []
    const w = createReadSpanWatcher({
      limit: 3,
      onTrip: (info) => {
        tripped.push(info)
      },
    })
    // First read run sits one below the limit.
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'b' } }]))
    expect(w.streak).toBe(2)
    // An action lands and the streak (and trace) must reset.
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'a' } }]))
    expect(w.streak).toBe(0)
    expect(w.trace).toHaveLength(0)
    // Two more reads alone must not trip — the reset means the new run
    // starts from zero, not from the prior count.
    w.observe(assistant([{ name: 'Read', input: { file_path: 'c' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'd' } }]))
    expect(w.tripped).toBe(false)
    expect(tripped).toHaveLength(0)
    // A third consecutive read in this new run pushes back to the limit
    // and only now does the guard trip.
    w.observe(assistant([{ name: 'Read', input: { file_path: 'e' } }]))
    expect(w.tripped).toBe(true)
    expect(tripped).toHaveLength(1)
  })

  it('unrelated tools neither extend nor reset the streak', () => {
    const tripped: TripInfo[] = []
    const w = createReadSpanWatcher({
      limit: 3,
      onTrip: (info) => {
        tripped.push(info)
      },
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    expect(w.streak).toBe(1)
    // Unrelated tools must not bump the streak…
    w.observe(assistant([{ name: 'TodoWrite' }]))
    expect(w.streak).toBe(1)
    w.observe(assistant([{ name: 'WebFetch' }]))
    expect(w.streak).toBe(1)
    w.observe(assistant([{ name: 'TaskCreate' }]))
    expect(w.streak).toBe(1)
    // …nor clear it. Two more reads (with unrelated tools sprinkled in)
    // must still reach the limit because the original Read still counts.
    w.observe(assistant([{ name: 'Read', input: { file_path: 'b' } }]))
    expect(w.streak).toBe(2)
    w.observe(assistant([{ name: 'TodoWrite' }]))
    expect(w.streak).toBe(2)
    w.observe(assistant([{ name: 'Read', input: { file_path: 'c' } }]))
    expect(w.tripped).toBe(true)
    expect(tripped).toHaveLength(1)
  })

  it('the trip still reports the configured limit and the full read trace', () => {
    const tripped: TripInfo[] = []
    const w = createReadSpanWatcher({
      limit: 4,
      onTrip: (info) => {
        tripped.push(info)
      },
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'src/a.ts' } }]))
    w.observe(assistant([{ name: 'Grep', input: { pattern: 'foo' } }]))
    w.observe(assistant([{ name: 'Glob', input: { pattern: '**/*.ts' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'src/b.ts' } }]))
    expect(tripped).toHaveLength(1)
    const info = tripped[0]
    expect(info.limit).toBe(4)
    expect(info.trace).toHaveLength(4)
    expect(info.trace.map((t) => t.tool)).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Read',
    ])
    expect(info.trace.map((t) => t.target)).toEqual([
      'src/a.ts',
      'foo',
      '**/*.ts',
      'src/b.ts',
    ])
  })
})

describe('resolveReadSpanLimit', () => {
  it('defaults to 5', () => {
    delete process.env.MARS_READ_SPAN_LIMIT
    expect(resolveReadSpanLimit()).toBe(5)
  })

  it('honors a positive override argument', () => {
    expect(resolveReadSpanLimit(8)).toBe(8)
  })

  it('reads from MARS_READ_SPAN_LIMIT when set', () => {
    process.env.MARS_READ_SPAN_LIMIT = '10'
    try {
      expect(resolveReadSpanLimit()).toBe(10)
    } finally {
      delete process.env.MARS_READ_SPAN_LIMIT
    }
  })

  it('falls back to 5 on a bogus env value', () => {
    process.env.MARS_READ_SPAN_LIMIT = 'not-a-number'
    try {
      expect(resolveReadSpanLimit()).toBe(5)
    } finally {
      delete process.env.MARS_READ_SPAN_LIMIT
    }
  })
})
