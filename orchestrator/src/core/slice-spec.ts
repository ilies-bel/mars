/**
 * Parsed plan for a task slice emitted by the slicer workflow.
 *
 * Kept in core because queue persistence owns the plan, while workflows only
 * validate and produce it. This module deliberately contains types only.
 */
export interface SubDeliverableSpec {
  title: string
  whatToBuild: string
  acceptanceCriteria: string[]
  files?: string[]
}

export interface SliceSpec {
  title: string
  type: 'HITL' | 'AFK'
  kind: 'coder' | 'hitl'
  whatToBuild: string
  acceptanceCriteria: string[]
  blockedBy: number[]
  readFirst: string[]
  prescriptiveAction: string
  modifies: string[]
  creates: string[]
  verifyCmd: string | null
  mergeMode: 'auto' | 'gated'
  subDeliverable?: SubDeliverableSpec
}
