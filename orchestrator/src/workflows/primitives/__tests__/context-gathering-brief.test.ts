import { describe, expect, it } from 'vitest'
import { CONTEXT_GATHERING_BRIEF } from '../../context-gathering-brief'

// ---------------------------------------------------------------------------
// CONTEXT_GATHERING_BRIEF — codegraph-first exploration directive
// ---------------------------------------------------------------------------

describe('CONTEXT_GATHERING_BRIEF — codegraph-first exploration directive', () => {
  it('mentions codegraph as the preferred exploration tool', () => {
    expect(CONTEXT_GATHERING_BRIEF.toLowerCase()).toContain('codegraph')
  })

  it('degrades gracefully by conditioning on tool availability', () => {
    // The directive must not assume codegraph is always present.
    // Acceptable forms: "if codegraph", "when codegraph", "if available", etc.
    const lower = CONTEXT_GATHERING_BRIEF.toLowerCase()
    const hasConditional =
      lower.includes('if codegraph') ||
      lower.includes('when codegraph') ||
      lower.includes('if available') ||
      lower.includes('when available') ||
      lower.includes('if the codegraph') ||
      lower.includes('are available') ||
      lower.includes('is available')
    expect(hasConditional).toBe(true)
  })

  it('tells the coder to reach for codegraph before grep or Read', () => {
    // The directive should establish priority: codegraph first, grep/Read as fallback.
    const lower = CONTEXT_GATHERING_BRIEF.toLowerCase()
    const hasFirst = lower.includes('first') || lower.includes('before') || lower.includes('prefer')
    expect(hasFirst).toBe(true)
  })

  it('names a codegraph tool invocation pattern', () => {
    // The directive should name at least one concrete codegraph sub-command or tool
    // so the coder knows what to call.
    const hasQuery = CONTEXT_GATHERING_BRIEF.includes('codegraph query') ||
      CONTEXT_GATHERING_BRIEF.includes('codegraph callers') ||
      CONTEXT_GATHERING_BRIEF.includes('codegraph callees') ||
      CONTEXT_GATHERING_BRIEF.includes('codegraph_')
    expect(hasQuery).toBe(true)
  })
})
