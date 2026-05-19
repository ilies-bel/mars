import { describe, expect, it } from 'vitest'
import type { ClaudeEvent } from '../claude-stream'
import {
  createReadSpanWatcher,
  resolveReadSpanAbortLimit,
  resolveReadSpanLimit,
  stripLeadingPrefixes,
  type RedundantSelfReadInfo,
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

// ---------------------------------------------------------------------------
// Redundant-self-read-after-subagent detector
// ---------------------------------------------------------------------------

describe('redundant-self-read-after-subagent detector', () => {
  // Build an assistant event that invokes a sub-agent (Agent or Explore) with
  // a specific tool_use id so we can correlate it with its result.
  const agentInvocation = (id: string, subagentType = 'Agent'): ClaudeEvent => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: subagentType,
          input: { description: 'find files', prompt: 'search the codebase' },
        },
      ],
    },
  })

  // Build a user event carrying the sub-agent's tool_result (the report).
  const toolResult = (toolUseId: string, text: string): ClaudeEvent => ({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text }],
        },
      ],
    },
  })

  const readFile = (filePath: string): ClaudeEvent =>
    assistant([{ name: 'Read', input: { file_path: filePath } }])

  const actionBash = (command: string): ClaudeEvent =>
    assistant([{ name: 'Bash', input: { command } }])

  // -------------------------------------------------------------------------
  // Tracer-bullet test: mirrors the mars-c44ffb1f event shape
  // -------------------------------------------------------------------------
  it('fires redundant-self-read-after-subagent exactly once when coder re-reads 3+ cited paths (mars-c44ffb1f shape)', () => {
    const events: RedundantSelfReadInfo[] = []
    const w = createReadSpanWatcher({
      limit: 99, // high limit so consecutive-streak watcher never fires
      onThreshold: () => {},
      onRedundantSelfRead: (info) => events.push(info),
    })

    // Sub-agent dispatched
    w.observe(agentInvocation('inv-001'))
    // Sub-agent returns a report naming two files
    w.observe(
      toolResult(
        'inv-001',
        'Found the relevant files: queue.ts handles task queue operations and implement-workflow.ts contains the workflow implementation.',
      ),
    )

    // Coder re-reads the first cited file (redundant read #1)
    w.observe(readFile('/repo/src/queue.ts'))
    // Bash call interleaved — resets streak but detector spans across it
    w.observe(actionBash('git add -A'))
    // Coder re-reads the second cited file (redundant read #2)
    w.observe(readFile('/repo/src/implement-workflow.ts'))
    // Another Bash call
    w.observe(actionBash('git commit -m "wip"'))
    // Coder re-reads the first again (redundant read #3 — fires the tag)
    w.observe(readFile('/repo/src/queue.ts'))

    expect(events).toHaveLength(1)
    const info = events[0]!
    expect(info.subAgentInvocationId).toBe('inv-001')
    expect(info.citedPaths).toContain('queue.ts')
    expect(info.citedPaths).toContain('implement-workflow.ts')
    expect(info.redundantReadPaths).toHaveLength(3)
  })

  it('does not fire when the coder reads paths the sub-agent did not cite (negative case)', () => {
    const events: RedundantSelfReadInfo[] = []
    const w = createReadSpanWatcher({
      limit: 99,
      onThreshold: () => {},
      onRedundantSelfRead: (info) => events.push(info),
    })

    w.observe(agentInvocation('inv-002'))
    w.observe(
      toolResult('inv-002', 'Relevant file: queue.ts is important.'),
    )

    // Read completely unrelated paths — none overlap with cited set
    w.observe(readFile('/repo/src/unrelated-a.ts'))
    w.observe(readFile('/repo/src/unrelated-b.ts'))
    w.observe(readFile('/repo/src/unrelated-c.ts'))
    w.observe(readFile('/repo/src/unrelated-d.ts'))

    expect(events).toHaveLength(0)
  })

  it('emitted log line includes sub-agent invocation id, cited paths, and redundant read paths', () => {
    let captured: RedundantSelfReadInfo | null = null
    const w = createReadSpanWatcher({
      limit: 99,
      onThreshold: () => {},
      onRedundantSelfRead: (info) => {
        captured = info
      },
    })

    w.observe(agentInvocation('inv-003', 'Explore'))
    w.observe(
      toolResult(
        'inv-003',
        'I examined queue.ts and found implement-workflow.ts.',
      ),
    )
    w.observe(readFile('/abs/queue.ts'))
    w.observe(readFile('/abs/implement-workflow.ts'))
    w.observe(readFile('/abs/queue.ts'))

    expect(captured).not.toBeNull()
    const info = captured as unknown as RedundantSelfReadInfo
    expect(info.subAgentInvocationId).toBe('inv-003')
    expect(Array.isArray(info.citedPaths)).toBe(true)
    expect(Array.isArray(info.redundantReadPaths)).toBe(true)
    expect(info.redundantReadPaths).toHaveLength(3)
  })

  it('fires exactly once even when more overlapping reads arrive after the 3rd', () => {
    let callCount = 0
    const w = createReadSpanWatcher({
      limit: 99,
      onThreshold: () => {},
      onRedundantSelfRead: () => {
        callCount += 1
      },
    })

    w.observe(agentInvocation('inv-004'))
    w.observe(toolResult('inv-004', 'See queue.ts for details.'))

    w.observe(readFile('/repo/queue.ts'))
    w.observe(readFile('/repo/queue.ts'))
    w.observe(readFile('/repo/queue.ts')) // fires here
    w.observe(readFile('/repo/queue.ts')) // must not fire again
    w.observe(readFile('/repo/queue.ts')) // must not fire again

    expect(callCount).toBe(1)
  })

  it('works for Explore sub-agents as well as Agent', () => {
    const events: RedundantSelfReadInfo[] = []
    const w = createReadSpanWatcher({
      limit: 99,
      onThreshold: () => {},
      onRedundantSelfRead: (info) => events.push(info),
    })

    w.observe(agentInvocation('inv-005', 'Explore'))
    w.observe(toolResult('inv-005', 'queue.ts is the key file.'))

    w.observe(readFile('/x/queue.ts'))
    w.observe(readFile('/x/queue.ts'))
    w.observe(readFile('/x/queue.ts'))

    expect(events).toHaveLength(1)
  })

  it('does not affect the existing consecutive-read streak behaviour', () => {
    let thresholdFired = false
    const w = createReadSpanWatcher({
      limit: 2,
      onThreshold: () => {
        thresholdFired = true
      },
      onRedundantSelfRead: () => {},
    })

    w.observe(agentInvocation('inv-006'))
    w.observe(toolResult('inv-006', 'queue.ts is relevant.'))

    // Two consecutive reads — hits existing threshold
    w.observe(readFile('/x/queue.ts'))
    w.observe(readFile('/x/queue.ts'))

    expect(thresholdFired).toBe(true)
    expect(w.streak).toBe(2)
  })

  it('does not fire when onRedundantSelfRead is not provided (no crash)', () => {
    const w = createReadSpanWatcher({
      limit: 99,
      onThreshold: () => {},
      // no onRedundantSelfRead
    })

    w.observe(agentInvocation('inv-007'))
    w.observe(toolResult('inv-007', 'queue.ts and implement-workflow.ts.'))
    w.observe(readFile('/x/queue.ts'))
    w.observe(readFile('/x/implement-workflow.ts'))
    w.observe(readFile('/x/queue.ts'))
    // Must not throw
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
