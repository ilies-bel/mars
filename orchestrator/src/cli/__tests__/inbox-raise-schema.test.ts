import { describe, expect, it } from 'vitest'
import { inboxRaiseSchema } from '../inbox-raise-schema'

const validBase = {
  kind: 'manual.smoketest',
  category: 'orchestrator' as const,
  priority: 'low' as const,
  title: 'smoke test',
  body: 'body text',
  payload: { foo: 'bar' },
  context: { taskId: 'abc123' },
  raisedBy: 'smoketest:agent',
  signature: 'manual.smoketest:1',
}

describe('inboxRaiseSchema', () => {
  it('parses a fully-formed object and round-trips it', () => {
    const parsed = inboxRaiseSchema.parse(validBase)
    expect(parsed).toEqual(validBase)
  })

  it('rejects when a required field is missing and names the field', () => {
    const { signature: _omitted, ...rest } = validBase
    const result = inboxRaiseSchema.safeParse(rest)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('signature')
    }
  })

  it('rejects when payload is the wrong type', () => {
    const bad = { ...validBase, payload: 'foo' as unknown as Record<string, unknown> }
    const result = inboxRaiseSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('payload')
    }
  })

  it('parses when optional occurrence is omitted', () => {
    const result = inboxRaiseSchema.safeParse(validBase)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.occurrence).toBeUndefined()
    }
  })

  it('parses when occurrence is provided as a record', () => {
    const withOccurrence = { ...validBase, occurrence: { at: '2026-05-10T00:00:00Z' } }
    const result = inboxRaiseSchema.safeParse(withOccurrence)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.occurrence).toEqual({ at: '2026-05-10T00:00:00Z' })
    }
  })

  it('rejects an invalid priority value', () => {
    const bad = { ...validBase, priority: 'medium' as unknown as 'low' }
    const result = inboxRaiseSchema.safeParse(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('priority')
    }
  })

  it('accepts a custom (non-canonical) category string', () => {
    const custom = { ...validBase, category: 'something-bespoke' }
    const result = inboxRaiseSchema.safeParse(custom)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBe('something-bespoke')
    }
  })
})
