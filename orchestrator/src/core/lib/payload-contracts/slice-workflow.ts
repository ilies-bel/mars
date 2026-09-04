/**
 * Payload contracts for the slice-workflow action-queue kind family.
 *
 * Kinds: `slices-dropped`, `slice-failed`, `hitl-slice-needs-operator`,
 *        `slicer-transport-outage`
 *
 * All four are raised inside `src/workflows/slice-workflow.ts` by the slicer
 * that turns a PRD into task rows.
 */

import type { OccurrenceTrail } from './shared'

/**
 * The slicer pre-flight found slices that were already satisfied on main and
 * dropped them before dispatching the survivors.
 *
 * Raised at: src/workflows/slice-workflow.ts (kind `slices-dropped`)
 */
export interface SlicesDroppedPayload extends OccurrenceTrail {
  /** ID of the PRD this slice run was for. */
  proposalId: string
  /** Number of slices dropped as already-satisfied on main. */
  droppedCount: number
  /** Number of slices that survived and will dispatch normally. */
  survivorCount: number
}

/**
 * The slicer workflow could not produce tasks for a PRD — it failed and
 * reverted the proposal to `prd-ready`.
 *
 * Raised at: src/workflows/slice-workflow.ts (kind `slice-failed`)
 */
export interface SliceFailedPayload extends OccurrenceTrail {
  /** ID of the PRD this slice run was for. */
  proposalId: string
  /** Human-readable title of the PRD, carried so the UI can display it without a lookup. */
  proposalTitle?: string
  /** Human-readable description of the failure (from `describeSliceFailure`). */
  error: string
}

/**
 * A HITL (human-in-the-loop) slice is waiting for an operator to complete a
 * manual step before the arc can proceed.
 *
 * Raised at: src/workflows/slice-workflow.ts (kind `hitl-slice-needs-operator`)
 */
export interface HitlSliceNeedsOperatorPayload extends OccurrenceTrail {
  /** ID of the PRD this HITL slice belongs to. */
  proposalId: string
  /** 1-based position of this HITL slice within the PRD. */
  sliceIndex: number
  /** ID of the Coder sub-task that will deliver the artifact for this step. */
  subTaskId: string
}

/**
 * The provider transport layer was unreachable during slicing — DNS failure,
 * TCP connect refusal, or firewall block. All affected PRDs are reset to
 * `prd-ready` (no `last_slice_error`) so the startup reconciler re-dispatches
 * them automatically when the provider is healthy again.
 *
 * This alert uses a FIXED signature (`'slicer:provider-transport'`) so N
 * concurrent transport failures produce exactly ONE action-queue row.
 *
 * Raised at: src/workflows/slice-workflow.ts (kind `slicer-transport-outage`)
 */
export interface SlicerTransportOutagePayload extends OccurrenceTrail {
  /** ID of the PRD that triggered this alert (one representative PRD per row). */
  proposalId: string
  /** Human-readable title of that PRD. */
  proposalTitle?: string
  /** The raw error message from the transport failure. */
  error: string
}

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface SliceWorkflowContracts {
  'slices-dropped': SlicesDroppedPayload
  'slice-failed': SliceFailedPayload
  'hitl-slice-needs-operator': HitlSliceNeedsOperatorPayload
  'slicer-transport-outage': SlicerTransportOutagePayload
}

/** Representative fixtures for the payload/recipe contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<
  'slices-dropped' | 'slice-failed' | 'hitl-slice-needs-operator' | 'slicer-transport-outage',
  Record<string, unknown>
> = {
  'slices-dropped': {
    proposalId: 'prop-abc123',
    droppedCount: 2,
    survivorCount: 5,
  },
  'slice-failed': {
    proposalId: 'prop-abc123',
    proposalTitle: 'Ship the feature',
    error: 'slicer process exited with code 1: model refused to slice',
  },
  'hitl-slice-needs-operator': {
    proposalId: 'prop-abc123',
    sliceIndex: 3,
    subTaskId: 'mars-deadbeef',
  },
  'slicer-transport-outage': {
    proposalId: 'prop-abc123',
    proposalTitle: 'Ship the feature',
    error: 'provider worker exited 1: API Error: Connection refused (ConnectionRefused)',
  },
}
