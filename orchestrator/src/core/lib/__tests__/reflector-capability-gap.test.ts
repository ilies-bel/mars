/**
 * Unit tests for `applyCapabilityGapVerdicts`.
 *
 * Capability-gap suggestions used to be dead output: the reflector's analyst
 * prompt asked for them, the parser built them, and NOTHING consumed the
 * result. They now land on the same surface as the reflector's other outputs —
 * a draft proposal — so an operator actually sees them.
 *
 * System boundary mocked: the proposals store (`../../proposals`). These tests
 * assert the apply path's decisions (create / fold / discard) and the
 * provenance it stamps, not the DB write itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VerdictedCapabilityGapSuggestion } from '../reflector'

const createProposalMock = vi.hoisted(() =>
  vi.fn(async (_title: string, _opts?: unknown) => ({ id: 'proposal-1' })),
)
const findOpenReflectionDraftByFingerprintMock = vi.hoisted(() =>
  vi.fn(async (_fingerprint: string) => null as { id: string; notes: string } | null),
)
const appendProposalNotesMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _addition: string) => {}),
)

vi.mock('../../proposals', () => ({
  createProposal: createProposalMock,
  findOpenReflectionDraftByFingerprint: findOpenReflectionDraftByFingerprintMock,
  appendProposalNotes: appendProposalNotesMock,
}))

const gap: VerdictedCapabilityGapSuggestion = {
  stepName: 'behaviour-verify',
  capability: 'browser/UI-driving MCP tool',
  description: 'Could not exercise the UI: no browser-driving tool was available.',
  evidence: ['"no browser tool available in this environment"'],
  verdict: 'save',
}

/** The options object handed to createProposal on the Nth call. */
const proposalOpts = (n = 0): Record<string, unknown> =>
  (createProposalMock.mock.calls as unknown as Array<[string, Record<string, unknown>]>)[n][1]

describe('applyCapabilityGapVerdicts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findOpenReflectionDraftByFingerprintMock.mockResolvedValue(null)
  })

  it('lands a save-verdict gap as a draft proposal an operator can see', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')

    const result = await applyCapabilityGapVerdicts([gap], { originArcId: 'arc-1' })

    expect(result).toMatchObject({ saved: 1, absorbed: 0, dropped: 0 })
    expect(result.proposalIds).toEqual(['proposal-1'])

    expect(createProposalMock).toHaveBeenCalledOnce()
    const [title] = createProposalMock.mock.calls[0] as unknown as [string]
    expect(title).toContain('browser/UI-driving MCP tool')
    expect(title).toContain('behaviour-verify')

    const opts = proposalOpts()
    expect(opts.source).toBe('reflection')
    expect(opts.author).toEqual({ kind: 'agent', name: 'capability-gap' })
    // Provenance: which arc reported the gap, and the verbatim evidence.
    expect(String(opts.notes)).toContain('arc-1')
    expect(String(opts.notes)).toContain('no browser tool available')
    // The proposal asks a human to decide; it never promises auto-install.
    expect(String(opts.solution)).toMatch(/never installs or configures/i)
    expect(typeof opts.fingerprint).toBe('string')
  })

  it('folds a repeat of the same gap into the open draft instead of duplicating', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')
    findOpenReflectionDraftByFingerprintMock.mockResolvedValue({
      id: 'proposal-1',
      notes: 'existing',
    })

    const result = await applyCapabilityGapVerdicts([gap], { originArcId: 'arc-2' })

    expect(result).toMatchObject({ saved: 0, absorbed: 1, dropped: 0 })
    expect(createProposalMock).not.toHaveBeenCalled()
    expect(appendProposalNotesMock).toHaveBeenCalledOnce()
    expect(String(appendProposalNotesMock.mock.calls[0][1])).toContain('arc-2')
  })

  it('uses one fingerprint per (step, capability) pair', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')

    await applyCapabilityGapVerdicts(
      [gap, { ...gap, stepName: 'verify', capability: 'network egress' }],
      { originArcId: 'arc-1' },
    )

    expect(createProposalMock).toHaveBeenCalledTimes(2)
    expect(proposalOpts(0).fingerprint).not.toBe(proposalOpts(1).fingerprint)
  })

  it('is stable: the same gap fingerprints identically across arcs', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')

    await applyCapabilityGapVerdicts([gap], { originArcId: 'arc-1' })
    await applyCapabilityGapVerdicts(
      [{ ...gap, description: 'reworded', evidence: ['different quote'] }],
      { originArcId: 'arc-9' },
    )

    // Only stepName + capability feed the fingerprint — a reworded description
    // must not spawn a second draft for the same gap.
    expect(proposalOpts(0).fingerprint).toBe(proposalOpts(1).fingerprint)
  })

  it('discards a drop verdict without writing anything', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')

    const result = await applyCapabilityGapVerdicts([{ ...gap, verdict: 'drop' }], {
      originArcId: 'arc-1',
    })

    expect(result).toMatchObject({ saved: 0, absorbed: 0, dropped: 1 })
    expect(createProposalMock).not.toHaveBeenCalled()
    expect(appendProposalNotesMock).not.toHaveBeenCalled()
  })

  it('never creates a row for an absorb verdict with no existing draft', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')

    const result = await applyCapabilityGapVerdicts([{ ...gap, verdict: 'absorb' }], {
      originArcId: 'arc-1',
    })

    expect(result).toMatchObject({ saved: 0, absorbed: 1, dropped: 0 })
    expect(createProposalMock).not.toHaveBeenCalled()
  })

  it('is a no-op on an empty suggestion list', async () => {
    const { applyCapabilityGapVerdicts } = await import('../reflector')

    const result = await applyCapabilityGapVerdicts([], { originArcId: 'arc-1' })

    expect(result).toEqual({ saved: 0, absorbed: 0, dropped: 0, proposalIds: [] })
    expect(createProposalMock).not.toHaveBeenCalled()
  })
})
