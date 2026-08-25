/**
 * Payload contracts for the `proposal-promotion` action-queue kind family:
 * draft-proposal, scorer-suggested, promotion-decision, tool-promotion,
 * reflect-recommended.
 *
 * ## Why this family
 *
 * These five kinds are the decision rows an operator actively shapes work
 * from. Each raiser embeds a structured entity id (proposal id, scorer id,
 * ledger id, attempt id) and supporting data so the recipe can render a
 * meaningful action card without a second DB lookup.
 *
 * ## draft-proposal: three raisers, one wide interface
 *
 * `draft-proposal` is raised by three different paths:
 *   - `action-queue-repopulator` on `proposal.added` — `{ proposalId, source }`
 *   - `arc-qa-manifest.maybeSuggestPromotion` — `{ originId, manifestPath }`
 *   - `qa-step-list-flag.suggestQaStepListCapability` — `{ originId }`
 *
 * Their payloads are divergent and none share a natural discriminator, so the
 * contract uses a single wide interface with all fields optional rather than a
 * discriminated union that would require adding a discriminator to existing
 * raisers. The recipe uses `str()` fallbacks for absent fields.
 */

// ── draft-proposal ─────────────────────────────────────────────────────────

/**
 * Wide interface covering all three `draft-proposal` raisers.
 *
 * All fields are optional because no single raiser emits all of them. The
 * recipe falls back gracefully (via `str()`) when a field is absent.
 */
export interface DraftProposalPayload {
  /** Present when raised from a `proposal.added` event. */
  proposalId?: string
  /** The source that created the proposal. Present when raised from `proposal.added`. */
  source?: string
  /** The recipe reads this key with a fallback to `ctx.title`. */
  title?: string
  /** Present when raised from `arc-qa-manifest` or `qa-step-list-flag`. */
  originId?: string
  /** Present when raised from `arc-qa-manifest`. */
  manifestPath?: string
}

// ── scorer-suggested ───────────────────────────────────────────────────────

/**
 * Raised by `action-queue-repopulator` on `scorer.suggested`.
 * Source: `src/core/daemon/action-queue-repopulator.ts` (scorer.suggested handler).
 */
export interface ScorerSuggestedPayload {
  scorerId: string
  workflow: string
}

// ── promotion-decision ─────────────────────────────────────────────────────

/**
 * Raised by `runPromotionDecision` in `src/core/promotion-decide.ts`.
 */
export interface PromotionDecisionPayload {
  workflow: string
  ledgerId: string
  candidateVersionId: string
  incumbentVersionId: string
  candidateScore: number | null
  incumbentScore: number | null
  decision: 'promote' | 'retire'
}

// ── tool-promotion ─────────────────────────────────────────────────────────

/**
 * Raised by `drainToolPromotionLedger` in `src/core/daemon/action-queue-repopulator.ts`.
 */
export interface ToolPromotionPayload {
  attemptId: string
  helperKey: string
  /** Benchmark stats before the change. Null when no evidence was captured. */
  before: unknown
  /** Benchmark stats after the change. Null when no evidence was captured. */
  after: unknown
  motivatingArcIds: string[]
}

// ── reflect-recommended ────────────────────────────────────────────────────

interface KpiDriftItem {
  kpi: string
  deltaPct: number
}

interface FailureClusterItem {
  family: string
  count: number
}

interface TokenSpikeItem {
  taskId: string
  weightedTokens: number
  multipleOfMedian: number
}

/** Evidence gathered by the three reflect-worthiness detectors. */
export interface ReflectEvidence {
  kpiDrift: KpiDriftItem[]
  failureClusters: FailureClusterItem[]
  tokenSpike: TokenSpikeItem | null
}

/**
 * Raised by `runReflectRecommendedDetector` in `src/core/lib/self-evolve-trigger.ts`.
 */
export interface ReflectRecommendedPayload {
  evidence: ReflectEvidence
}

// ── Kind-to-payload map ────────────────────────────────────────────────────

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface ProposalContracts {
  'draft-proposal': DraftProposalPayload
  'scorer-suggested': ScorerSuggestedPayload
  'promotion-decision': PromotionDecisionPayload
  'tool-promotion': ToolPromotionPayload
  'reflect-recommended': ReflectRecommendedPayload
}

/** Representative fixtures for the payload-contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<keyof ProposalContracts, Record<string, unknown>> = {
  'draft-proposal': {
    proposalId: 'prop-abc-123',
    source: 'api',
    title: 'Improve error messages',
  },
  'scorer-suggested': {
    scorerId: 'scorer-def-456',
    workflow: 'task',
  },
  'promotion-decision': {
    workflow: 'task',
    ledgerId: 'ledger-ghi-789',
    candidateVersionId: 'v2',
    incumbentVersionId: 'v1',
    candidateScore: 0.85,
    incumbentScore: 0.72,
    decision: 'promote',
  },
  'tool-promotion': {
    attemptId: 'attempt-jkl-012',
    helperKey: 'fastHelper',
    before: { p50: 120, p95: 240 },
    after: { p50: 45, p95: 90 },
    motivatingArcIds: ['arc-001', 'arc-002'],
  },
  'reflect-recommended': {
    evidence: {
      kpiDrift: [{ kpi: 'failure_rate', deltaPct: 15.3 }],
      failureClusters: [{ family: 'verify/typecheck', count: 4 }],
      tokenSpike: null,
    },
  },
}
