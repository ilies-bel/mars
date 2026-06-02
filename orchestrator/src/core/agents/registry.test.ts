import { describe, expect, it } from 'vitest'
import { agents } from './index'

describe('agent registry — structural invariants', () => {
  it('is a non-empty list', () => {
    const entries = Object.values(agents)
    expect(entries.length).toBeGreaterThan(0)
  })

  it('every entry has name (id), displayName, and a non-empty systemPrompt', () => {
    for (const entry of Object.values(agents)) {
      expect(typeof entry.name).toBe('string')
      expect(entry.name.length).toBeGreaterThan(0)
      expect(typeof entry.displayName).toBe('string')
      expect((entry.displayName as string).length).toBeGreaterThan(0)
      expect(typeof entry.systemPrompt).toBe('string')
      expect(entry.systemPrompt.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('agent registry — writer entry', () => {
  it('exposes a writer entry', () => {
    expect(agents['writer']).toBeDefined()
  })

  it('writer has id "writer"', () => {
    expect(agents['writer'].name).toBe('writer')
  })

  it('writer has a non-empty systemPrompt', () => {
    expect(agents['writer'].systemPrompt.trim().length).toBeGreaterThan(0)
  })

  it('writer exposes optional tools and model fields', () => {
    const writer = agents['writer']
    // model is required on AgentSpec
    expect(typeof writer.model).toBe('string')
    // tools: allowedTools and deniedTools are arrays (may be empty)
    expect(Array.isArray(writer.allowedTools)).toBe(true)
    expect(Array.isArray(writer.deniedTools)).toBe(true)
  })
})
