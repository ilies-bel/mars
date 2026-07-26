import { describe, expect, it } from 'vitest'
import { stewardAgent, StewardEventSchema } from './steward'
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
