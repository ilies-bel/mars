import { describe, expect, it } from 'vitest'
import {
  stewardAgent,
  StewardEventSchema,
  renderStewardStormBrief,
  STEWARD_STORM_TOOLS,
  type StewardStormEvent,
} from './steward'
import { agents, getAgentSpec } from './index'

describe('stewardAgent — spec shape', () => {
  it('has id "steward"', () => {
    expect(stewardAgent.name).toBe('steward')
  })

  it('targets the correct model', () => {
    expect(stewardAgent.model).toBe('claude-sonnet-4-6')
  })

  it('has a non-empty systemPrompt', () => {
    expect(stewardAgent.systemPrompt.trim().length).toBeGreaterThan(0)
  })

  it('exposes the inputSchema', () => {
    expect(typeof stewardAgent.inputSchema.parse).toBe('function')
  })
})

describe('StewardEventSchema — parse behaviour', () => {
  it('accepts kpi-degraded events', () => {
    const result = StewardEventSchema.parse({
      kind: 'kpi-degraded',
      signal: 'p95_latency',
      delta: 0.42,
    })
    expect(result.kind).toBe('kpi-degraded')
  })

  it('accepts resource-load events', () => {
    const result = StewardEventSchema.parse({
      kind: 'resource-load',
      metric: 'cpu',
      value: 87.5,
    })
    expect(result.kind).toBe('resource-load')
  })

  it('accepts onboarding events', () => {
    const result = StewardEventSchema.parse({
      kind: 'onboarding',
      stack: 'next.js',
    })
    expect(result.kind).toBe('onboarding')
  })

  it('accepts workflow-suggestion events', () => {
    const result = StewardEventSchema.parse({
      kind: 'workflow-suggestion',
      workflowName: 'nightly-sweep',
      rationale: 'Detected repeated manual runs at 02:00 UTC',
    })
    expect(result.kind).toBe('workflow-suggestion')
  })

  it('accepts signature-storm events with a structured brief', () => {
    const result = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'code:coder-exit-nonzero/api-unreachable',
      streak: 3,
      affectedTaskIds: ['t1', 't2', 't3'],
      failureExcerpts: [
        { taskId: 't1', signature: 'code:coder-exit-nonzero/api-unreachable', excerpt: 'boom' },
      ],
    })
    expect(result.kind).toBe('signature-storm')
  })

  it('defaults failureExcerpts to an empty list', () => {
    const result = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'setup:install-failed/unclassified',
      streak: 3,
      affectedTaskIds: [],
    }) as StewardStormEvent
    expect(result.failureExcerpts).toEqual([])
  })

  it('rejects a signature-storm event missing the signature', () => {
    expect(() =>
      StewardEventSchema.parse({ kind: 'signature-storm', streak: 3, affectedTaskIds: [] }),
    ).toThrow()
  })

  it('rejects an unknown event kind', () => {
    expect(() =>
      StewardEventSchema.parse({ kind: 'unknown-event', foo: 'bar' }),
    ).toThrow()
  })

  it('rejects a kpi-degraded event missing required fields', () => {
    expect(() =>
      StewardEventSchema.parse({ kind: 'kpi-degraded' }),
    ).toThrow()
  })
})

describe('signature-storm dispatch — write-capable, not a read-only explainer', () => {
  const brief = StewardEventSchema.parse({
    kind: 'signature-storm',
    signature: 'code:coder-exit-nonzero/api-unreachable',
    streak: 4,
    affectedTaskIds: ['task-a', 'task-b'],
    failureExcerpts: [
      { taskId: 'task-a', signature: 'code:coder-exit-nonzero/api-unreachable', excerpt: 'ECONNREFUSED' },
    ],
  }) as StewardStormEvent

  it('grants edit tools — the breaker pausing dispatch for prose is the bug', () => {
    expect(STEWARD_STORM_TOOLS).toContain('Edit')
    expect(STEWARD_STORM_TOOLS).toContain('Write')
    expect(stewardAgent.allowedTools).toContain('Edit')
    expect(stewardAgent.deniedTools).toHaveLength(0)
  })

  it('renders the signature, streak, and affected task ids into the brief', () => {
    const rendered = renderStewardStormBrief(brief)
    expect(rendered).toContain('code:coder-exit-nonzero/api-unreachable')
    expect(rendered).toContain('Consecutive failing tasks: 4')
    expect(rendered).toContain('task-a, task-b')
  })

  it('inlines the failure excerpts so the run is self-contained', () => {
    const rendered = renderStewardStormBrief(brief)
    expect(rendered).toContain('ECONNREFUSED')
    expect(rendered).toContain('### task-a')
  })

  it('asks for a committed fix, not an explanation', () => {
    const rendered = renderStewardStormBrief(brief)
    expect(rendered).toMatch(/WRITE-CAPABLE/)
    expect(rendered).toMatch(/git commit/)
    expect(rendered).toMatch(/not a\n?read-only investigation/)
  })

  it('renders cleanly with no excerpts and no affected ids', () => {
    const empty = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'verify:has-diff/no-commits-ahead',
      streak: 3,
      affectedTaskIds: [],
    }) as StewardStormEvent
    const rendered = renderStewardStormBrief(empty)
    expect(rendered).toContain('(none recorded)')
    expect(rendered).not.toContain('## Failure excerpts')
  })
})

describe('agent registry — steward entry', () => {
  it('exposes steward in the agents map', () => {
    expect(agents['steward']).toBeDefined()
  })

  it('resolves steward via getAgentSpec', () => {
    const spec = getAgentSpec('steward')
    expect(spec.name).toBe('steward')
  })

  it('steward spec in registry has an inputSchema', () => {
    const spec = agents['steward']
    expect(typeof spec.inputSchema?.parse).toBe('function')
  })
})
