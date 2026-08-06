/**
 * Behaviour tests for scorer-suggestion schema parsing and the accept
 * mutation contract.
 *
 * These tests verify the data-layer boundary:
 *  1. suggestedScorerSchema rejects non-suggested statuses so misclassified
 *     rows never silently appear in the suggestion panel.
 *  2. The accept response parses regardless of which accepted status the
 *     server returns (the status field is widened post-accept).
 *  3. An empty `scorers` array parses without error — the hook can handle a
 *     repo that has no suggestions at all.
 */

import { describe, it, expect } from 'vitest'
import { suggestedScorerSchema } from './useScorerSuggestions'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const baseSuggestion = {
  id: 'sc-abc123',
  workflow: 'task',
  title: 'Production-path completeness',
  rubric:
    'Does the diff wire the production entry point for the feature it claims to ship?',
  status: 'suggested' as const,
  confidence: 0.93,
  evidence: ['chat arc found unwired handler', 'verify passed vacuously'],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
}

// ---------------------------------------------------------------------------
// suggestedScorerSchema
// ---------------------------------------------------------------------------

describe('suggestedScorerSchema', () => {
  it('accepts a well-formed suggested scorer', () => {
    const result = suggestedScorerSchema.parse(baseSuggestion)
    expect(result.id).toBe('sc-abc123')
    expect(result.workflow).toBe('task')
    expect(result.title).toBe('Production-path completeness')
    expect(result.confidence).toBe(0.93)
    expect(result.status).toBe('suggested')
  })

  it('rejects a scorer with status "accepted" — accepted scorers must not appear in the suggestions panel', () => {
    const input = { ...baseSuggestion, status: 'accepted' }
    expect(() => suggestedScorerSchema.parse(input)).toThrow()
  })

  it('rejects a scorer with status "dismissed" — dismissed scorers must not appear in the suggestions panel', () => {
    const input = { ...baseSuggestion, status: 'dismissed' }
    expect(() => suggestedScorerSchema.parse(input)).toThrow()
  })

  it('rejects a scorer with confidence outside [0,1]', () => {
    expect(() => suggestedScorerSchema.parse({ ...baseSuggestion, confidence: 1.5 })).toThrow()
    expect(() => suggestedScorerSchema.parse({ ...baseSuggestion, confidence: -0.1 })).toThrow()
  })

  it('parses an empty evidence array', () => {
    const result = suggestedScorerSchema.parse({ ...baseSuggestion, evidence: [] })
    expect(result.evidence).toEqual([])
  })

  it('rejects a scorer with an empty id', () => {
    expect(() => suggestedScorerSchema.parse({ ...baseSuggestion, id: '' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Accept response contract
// ---------------------------------------------------------------------------

/**
 * After accept the server returns { scorer } with status='accepted'.
 * The accept response schema widens status to z.string() so it parses.
 */
const acceptResponseSchema = z.object({
  scorer: suggestedScorerSchema.extend({ status: z.string() }),
})

describe('accept response schema', () => {
  it('parses an accepted scorer response (status is now "accepted")', () => {
    const payload = {
      scorer: {
        ...baseSuggestion,
        status: 'accepted',
      },
    }
    const result = acceptResponseSchema.parse(payload)
    expect(result.scorer.status).toBe('accepted')
    expect(result.scorer.id).toBe('sc-abc123')
  })

  it('rejects a response missing the scorer wrapper', () => {
    expect(() => acceptResponseSchema.parse({ ...baseSuggestion, status: 'accepted' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Empty suggestions list
// ---------------------------------------------------------------------------

describe('empty scorer suggestions response', () => {
  it('parses { scorers: [] } without error', () => {
    const responseSchema = z.object({ scorers: z.array(suggestedScorerSchema) })
    const result = responseSchema.parse({ scorers: [] })
    expect(result.scorers).toHaveLength(0)
  })
})
