import { describe, expect, it } from 'vitest'
import type { DomainFlow } from './types'
import { renderDomainFlow } from './render'

/** Minimal stub that satisfies the DomainFlow interface shape. */
const makeFlow = (partial: Pick<DomainFlow, 'name' | 'nodes'>): DomainFlow => ({
  id: 'test-id',
  arcId: 'arc-id',
  frozenAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...partial,
})

describe('renderDomainFlow', () => {
  it('returns empty string for a flow with no nodes', () => {
    const flow = makeFlow({ name: 'Empty Flow', nodes: [] })
    expect(renderDomainFlow(flow)).toBe('')
  })

  it('renders a non-pivotal event with a bullet marker', () => {
    const flow = makeFlow({
      name: 'Simple Event Flow',
      nodes: [{ kind: 'event', name: 'OrderPlaced', description: 'An order was placed.', pivotal: false }],
    })
    const result = renderDomainFlow(flow)
    expect(result).toContain('• OrderPlaced')
    expect(result).toContain('  An order was placed.')
  })

  it('renders a pivotal event with a diamond marker', () => {
    const flow = makeFlow({
      name: 'Pivotal Event Flow',
      nodes: [{ kind: 'event', name: 'PaymentSettled', description: 'Payment was settled.', pivotal: true }],
    })
    const result = renderDomainFlow(flow)
    expect(result).toContain('◆ PaymentSettled')
    expect(result).toContain('  Payment was settled.')
  })

  it('renders a policy with the Policy prefix', () => {
    const flow = makeFlow({
      name: 'Policy Flow',
      nodes: [{ kind: 'policy', name: 'CancelIfUnpaid', description: 'Cancel order when payment lapses.' }],
    })
    const result = renderDomainFlow(flow)
    expect(result).toContain('→ Policy: CancelIfUnpaid')
    expect(result).toContain('  Cancel order when payment lapses.')
  })

  it('renders a hotspot with a warning marker and its question', () => {
    const flow = makeFlow({
      name: 'Hotspot Flow',
      nodes: [{ kind: 'hotspot', name: 'RetryLogic', question: 'How many retries before escalation?' }],
    })
    const result = renderDomainFlow(flow)
    expect(result).toContain('⚠ Hotspot: RetryLogic — How many retries before escalation?')
  })

  it('prepends the flow name as a heading', () => {
    const flow = makeFlow({
      name: 'Billing Cycle Change',
      nodes: [{ kind: 'event', name: 'InvoiceGenerated', description: 'Invoice was generated.', pivotal: false }],
    })
    const result = renderDomainFlow(flow)
    expect(result.startsWith('## Domain Flow: Billing Cycle Change')).toBe(true)
  })

  it('renders nodes in array order', () => {
    const flow = makeFlow({
      name: 'Ordered Flow',
      nodes: [
        { kind: 'event', name: 'First', description: 'First event.', pivotal: false },
        { kind: 'policy', name: 'Second', description: 'Second policy.' },
        { kind: 'hotspot', name: 'Third', question: 'Third question?' },
      ],
    })
    const result = renderDomainFlow(flow)
    const firstIdx = result.indexOf('First')
    const secondIdx = result.indexOf('Second')
    const thirdIdx = result.indexOf('Third')
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })

  it('separates nodes with double newlines', () => {
    const flow = makeFlow({
      name: 'Multi Node Flow',
      nodes: [
        { kind: 'event', name: 'A', description: 'Alpha.', pivotal: false },
        { kind: 'policy', name: 'B', description: 'Beta.' },
      ],
    })
    const result = renderDomainFlow(flow)
    // The rendered text for node A ends, then there is a blank line, then node B begins.
    expect(result).toContain('  Alpha.\n\n→ Policy: B')
  })

  it('renders mixed node types correctly in a single flow', () => {
    const flow = makeFlow({
      name: 'Full Flow',
      nodes: [
        { kind: 'event', name: 'OrderPlaced', description: 'Order created.', pivotal: false },
        { kind: 'event', name: 'PaymentReceived', description: 'Payment confirmed.', pivotal: true },
        { kind: 'policy', name: 'FraudCheck', description: 'Run fraud detection on every payment.' },
        { kind: 'hotspot', name: 'ChargebackRisk', question: 'Who owns chargeback disputes?' },
      ],
    })
    const result = renderDomainFlow(flow)
    expect(result).toContain('## Domain Flow: Full Flow')
    expect(result).toContain('• OrderPlaced')
    expect(result).toContain('◆ PaymentReceived')
    expect(result).toContain('→ Policy: FraudCheck')
    expect(result).toContain('⚠ Hotspot: ChargebackRisk — Who owns chargeback disputes?')
  })
})
