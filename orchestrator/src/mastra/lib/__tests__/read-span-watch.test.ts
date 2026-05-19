import { describe, expect, it } from 'vitest'
import type { ClaudeEvent } from '../claude-stream'
import {
  createReadSpanWatcher,
  resolveReadSpanLimit,
  resolveReadSpanAbortLimit,
  stripLeadingPrefixes,
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

  it('action-class Bash resets the streak', () => {
    const w = createReadSpanWatcher({
      limit: 5,
      onThreshold: () => {
        throw new Error('should not fire')
      },
    })
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Read' }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'git add -A' } }]))
    expect(w.streak).toBe(0)
  })

  it('5 consecutive read-only Bash calls trip the watcher', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 5,
      onThreshold: (info) => {
        fired = info
      },
    })
    for (let i = 0; i < 5; i += 1) {
      w.observe(assistant([{ name: 'Bash', input: { command: 'git log --oneline -10' } }]))
    }
    expect(w.thresholdReached).toBe(true)
    expect(fired).not.toBeNull()
    const info = fired as unknown as ThresholdInfo
    expect(info.trace).toHaveLength(5)
    expect(info.trace[0].tool).toBe('Bash')
    expect(info.trace[0].target).toBe('git log --oneline -10')
  })

  it('git add -A mid-sequence resets the streak', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 5,
      onThreshold: (info) => {
        fired = info
      },
    })
    w.observe(assistant([{ name: 'Bash', input: { command: 'git log' } }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'git log' } }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'git log' } }]))
    expect(w.streak).toBe(3)
    w.observe(assistant([{ name: 'Bash', input: { command: 'git add -A' } }]))
    expect(w.streak).toBe(0)
    expect(w.thresholdReached).toBe(false)
    expect(fired).toBeNull()
  })

  it('cat package.json counts as read-class but cat > foo.txt does not', () => {
    const w = createReadSpanWatcher({
      limit: 5,
      onThreshold: () => {},
    })
    w.observe(assistant([{ name: 'Bash', input: { command: 'cat package.json' } }]))
    expect(w.streak).toBe(1)
    // cat with an output redirect is a write — resets the streak
    w.observe(assistant([{ name: 'Bash', input: { command: 'cat > foo.txt' } }]))
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

  it('tracks maxStreak across the whole run, not just the active streak', () => {
    const w = createReadSpanWatcher({ limit: 99, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }, { name: 'Read' }]))
    expect(w.maxStreak).toBe(3)
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'a' } }]))
    expect(w.streak).toBe(0)
    expect(w.maxStreak).toBe(3)
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(w.maxStreak).toBe(3)
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(w.streak).toBe(4)
    expect(w.maxStreak).toBe(4)
  })

  it('counts totalReads and totalActions across the whole run', () => {
    const w = createReadSpanWatcher({ limit: 99, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Read' }, { name: 'Grep' }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'ls' } }]))
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Bash', input: { command: 'git add -A' } }]))
    w.observe(assistant([{ name: 'Write', input: { file_path: 'b' } }]))
    expect(w.totalReads).toBe(3)
    expect(w.totalActions).toBe(3)
  })

  it('thresholdEverReached stays true after a reset, unlike thresholdReached', () => {
    const w = createReadSpanWatcher({ limit: 2, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Read' }, { name: 'Read' }]))
    expect(w.thresholdReached).toBe(true)
    expect(w.thresholdEverReached).toBe(true)
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'a' } }]))
    expect(w.thresholdReached).toBe(false)
    expect(w.thresholdEverReached).toBe(true)
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

describe('investigative Bash commands as discovery', () => {
  it('six consecutive cat-style Bash calls trip log-only threshold', () => {
    let fired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 6,
      onThreshold: (info) => {
        fired = info
      },
    })
    for (let i = 0; i < 6; i += 1) {
      w.observe(assistant([{ name: 'Bash', input: { command: `cat file${i}.ts` } }]))
    }
    expect(w.thresholdReached).toBe(true)
    expect(fired).not.toBeNull()
    expect((fired as unknown as ThresholdInfo).trace).toHaveLength(6)
  })

  it('grep without redirect is read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'grep pattern file.ts' } }]))
    expect(w.streak).toBe(1)
  })

  it('grep with output redirect is action-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'grep foo > out.txt' } }]))
    expect(w.streak).toBe(0)
  })

  it('fd is read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'fd -e ts src/' } }]))
    expect(w.streak).toBe(1)
  })

  it('jq is read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'jq .name package.json' } }]))
    expect(w.streak).toBe(1)
  })

  it('awk is read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: "awk '{print $1}' file.txt" } }]))
    expect(w.streak).toBe(1)
  })

  it('sed -n is read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: "sed -n 'p' file.txt" } }]))
    expect(w.streak).toBe(1)
  })

  it('env FOO=bar prefix stripped — grep becomes read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'env FOO=bar grep pattern file' } }]))
    expect(w.streak).toBe(1)
  })

  it('cd <path> && prefix stripped — cat becomes read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'cd src && cat file.ts' } }]))
    expect(w.streak).toBe(1)
  })

  it('env with destructive command is still action-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(assistant([{ name: 'Bash', input: { command: 'env FOO=bar rm -rf /' } }]))
    expect(w.streak).toBe(0)
  })

  it('chained prefix stripped — cd then env then grep is read-class', () => {
    const w = createReadSpanWatcher({ limit: 5, onThreshold: () => {} })
    w.observe(
      assistant([
        { name: 'Bash', input: { command: 'cd src && env FOO=bar grep pattern file' } },
      ]),
    )
    expect(w.streak).toBe(1)
  })
})

describe('hard-abort threshold', () => {
  it('fires onAbort on long run — onThreshold fires at limit, onAbort fires at abortLimit', () => {
    let thresholdFired = false
    let abortFired: ThresholdInfo | null = null
    const w = createReadSpanWatcher({
      limit: 3,
      abortLimit: 5,
      onThreshold: () => {
        thresholdFired = true
      },
      onAbort: (info) => {
        abortFired = info
      },
    })
    for (let i = 0; i < 5; i += 1) {
      w.observe(assistant([{ name: 'Read', input: { file_path: `file${i}.ts` } }]))
    }
    expect(thresholdFired).toBe(true)
    expect(abortFired).not.toBeNull()
    const info = abortFired as unknown as ThresholdInfo
    expect(info.limit).toBe(5)
    expect(info.trace).toHaveLength(5)
  })

  it('abortThresholdReached stays false below abort limit', () => {
    const w = createReadSpanWatcher({
      limit: 3,
      abortLimit: 5,
      onThreshold: () => {},
      onAbort: () => {},
    })
    for (let i = 0; i < 4; i += 1) {
      w.observe(assistant([{ name: 'Read', input: { file_path: `file${i}.ts` } }]))
    }
    expect(w.abortThresholdReached).toBe(false)
  })

  it('abortThresholdReached resets on action', () => {
    const w = createReadSpanWatcher({
      limit: 2,
      abortLimit: 3,
      onThreshold: () => {},
      onAbort: () => {},
    })
    w.observe(assistant([{ name: 'Read', input: { file_path: 'a' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'b' } }]))
    w.observe(assistant([{ name: 'Read', input: { file_path: 'c' } }]))
    expect(w.abortThresholdReached).toBe(true)
    w.observe(assistant([{ name: 'Edit', input: { file_path: 'x' } }]))
    expect(w.abortThresholdReached).toBe(false)
  })
})

describe('resolveReadSpanAbortLimit', () => {
  it('returns undefined when not set', () => {
    delete process.env.MARS_READ_SPAN_ABORT_LIMIT
    expect(resolveReadSpanAbortLimit()).toBeUndefined()
  })

  it('reads from MARS_READ_SPAN_ABORT_LIMIT env var', () => {
    process.env.MARS_READ_SPAN_ABORT_LIMIT = '15'
    try {
      expect(resolveReadSpanAbortLimit()).toBe(15)
    } finally {
      delete process.env.MARS_READ_SPAN_ABORT_LIMIT
    }
  })

  it('falls back to undefined on bogus env value', () => {
    process.env.MARS_READ_SPAN_ABORT_LIMIT = 'not-a-number'
    try {
      expect(resolveReadSpanAbortLimit()).toBeUndefined()
    } finally {
      delete process.env.MARS_READ_SPAN_ABORT_LIMIT
    }
  })

  it('honors positive override argument', () => {
    expect(resolveReadSpanAbortLimit(20)).toBe(20)
  })
})
