import { describe, expect, it } from 'vitest'
import type { ClaudeEvent } from '../claude-stream'
import {
  createReadSpanWatcher,
  resolveReadSpanLimit,
  type ThresholdInfo,
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
  it('does not fire below the limit', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 5,
      onThreshold: (info) => {
        fired = info
      },
    })
    for (let i = 0; i < 4; i += 1) {
      w.observe(assistant([{ name: 'Read', input: { file_path: `src/foo${i}.ts` } }]))
    }
    expect(w.streak).toBe(4)
    expect(w.thresholdReached).toBe(false)
    expect(fired).toBeNull()
  })

  it('fires exactly at the configured limit', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onThreshold: (info) => {
        fired = info
      },
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Grep', input: { pattern: 'foo' } }]))
    w.observe(assistant([{ name: 'Glob', input: { pattern: '**/*.ts' } }]))
    expect(w.thresholdReached).toBe(true)
    expect(fired).not.toBeNull()
    const info = fired as unknown as ThresholdInfo
    expect(info.limit).toBe(3)
    expect(info.trace).toHaveLength(3)
    expect(info.trace[0].tool).toBe('Read')
    expect(info.trace[1].tool).toBe('Grep')
    expect(info.trace[2].tool).toBe('Glob')
  })

  it('only fires onThreshold once per streak even when more reads arrive', () => {
    let calls = 0
    const w = createReadSpanWatcher({
      limit: 2,
      onThreshold: () => {
        calls += 1
      },
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'b' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'c' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'd' } }]))
    expect(calls).toBe(1)
    // The streak keeps growing past the threshold — the watcher is
    // observational and does not freeze its counters.
    expect(w.streak).toBe(4)
  })

  it('resets the streak on an action-class call and re-arms onThreshold', () => {
    let calls = 0
    const w = createReadSpanWatcher({
      limit: 3,
      onThreshold: () => {
        calls += 1
      },
    })
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(w.streak).toBe(2)
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'a' } }]))
    expect(w.streak).toBe(0)
    expect(w.thresholdReached).toBe(false)
    expect(calls).toBe(0)
    // New streak after the reset must reach the limit on its own to fire.
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(calls).toBe(0)
    w.observe(assistant([{ name: 'Read' }]))
    expect(calls).toBe(1)
    expect(w.thresholdReached).toBe(true)
  })

  it('ignores tools that are neither read nor action class', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onThreshold: (info) => {
        fired = info
      },
    })
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'TodoWrite' }]))
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'WebFetch' }]))
    w.observe(assistant([{ name: 'Read' }]))
    expect(w.thresholdReached).toBe(true)
    expect(fired).not.toBeNull()
  })

  it('ignores non-assistant events', () => {
    const w = createReadSpanWatcher({
      limit: 2,
      onThreshold: () => {
        throw new Error('should not fire on non-assistant events')
      },
    })
    w.observe({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })
    w.observe({ type: 'system', subtype: 'init' })
    expect(w.streak).toBe(0)
  })

  it('Bash counts as an action and resets the streak', () => {
    const w = createReadSpanWatcher({
      limit: 5,
      onThreshold: () => {
        throw new Error('should not fire')
      },
    })
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'ls' } }]))
    expect(w.streak).toBe(0)
  })

  it('multiple read tool_uses in one event each count toward the streak', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      onThreshold: (info) => {
        fired = info
      },
    })
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }, { name: 'Grep' }]))
    expect(w.thresholdReached).toBe(true)
    expect(fired).not.toBeNull()
    expect((fired as unknown as ThresholdInfo).trace).toHaveLength(3)
  })

  it('does not kill or interfere — observation is the only side effect', () => {
    // Pinned behaviour: the watcher hands back a ThresholdInfo and that's
    // it. It does not throw, does not call an abort signal, and does not
    // mutate the event stream. The caller decides what (if anything) to
    // do with the signal.
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 2,
      onThreshold: (info) => {
        fired = info
      },
    })
    // No abort controller, no externalAbort wiring — the watcher does not
    // ask for one. Hitting the threshold simply returns the info object.
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(fired).not.toBeNull()
    // Further events keep flowing through — the watcher does not "stop".
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Read' }]))
    expect(w.streak).toBe(4)
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
