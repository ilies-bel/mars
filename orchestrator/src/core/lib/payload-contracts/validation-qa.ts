/**
 * Payload contracts for the validation / QA family of action-queue kinds.
 *
 * Kinds owned by this family (`UNAUDITED_KIND_FAMILY` entry: `'validation-qa'`):
 *   - `awaiting-validation`
 *   - `awaiting-validation-preview-gone`
 *   - `behaviour-unverified`
 *   - `mockup-ready`
 *   - `qa-step-list-opt-in`
 *   - `qa-step-list-promote`
 *
 * Sources: the raiser literal at each call site listed in the doc comment of
 * the interface, or (when there is no raiser in the tree) the keys each
 * recipe reads in `action-queue-recipes.ts`.
 */

/**
 * Raised by `tools/verify/review.ts` (the `reviewType: 'manual'` remote-deploy
 * path) when a remote deployment completes or fails. Two separate raise sites
 * emit this kind with different payload shapes:
 *
 *   - success path: `{ taskId, devServerUrl, remoteUrl, branch }`
 *   - failure path: `{ remoteUrl, branch }`
 *
 * `taskId` and `devServerUrl` are therefore optional to accommodate both sites.
 */
export interface AwaitingValidationPayload {
  taskId?: string | null
  devServerUrl?: string | null
  remoteUrl: string | null
  branch: string
}

/**
 * No raiser for this kind exists in the current codebase. The interface is
 * typed from the keys its recipe reads in `action-queue-recipes.ts`.
 *
 * Expected to be raised by a preview-watchdog that detects a deployed preview
 * environment going away while a task is still in the `awaiting-validation`
 * state, so the operator can still decide to validate or reject.
 */
export interface AwaitingValidationPreviewGonePayload {
  devServerUrl?: string | null
  remoteUrl?: string | null
  previewUnavailableAt?: string | null
  branch?: string
}

/**
 * Raised by `workflows/primitives/behaviour-verify.ts` when a task merges
 * (passing static verify) but its behaviour could not be verified against a
 * live surface.
 *
 * Raiser literal (line ~664–694):
 * ```
 * { taskId, originTaskId, proposalId, reason, criteria, devServerLogPath, artifactsDir }
 * ```
 */
export interface BehaviourUnverifiedPayload {
  taskId: string
  originTaskId: string
  /** Fallback draft proposal created for the operator, or `null` when creation failed. */
  proposalId: string | null
  /** Machine-readable reason the live surface was unreachable. */
  reason: string
  criteria: string[]
  devServerLogPath: string | null
  artifactsDir: string
}

/**
 * Raised by `tools/qa/finalize-mockup.ts` when a visual mockup HTML has been
 * generated and copied to the state directory.
 *
 * Raiser literal (line ~113–119):
 * ```
 * { proposalId, taskId }
 * ```
 */
export interface MockupReadyPayload {
  proposalId: string
  taskId: string
}

/**
 * No raiser for this kind exists in the current codebase. The interface is
 * typed from the keys its recipe reads in `action-queue-recipes.ts`.
 *
 * Intended to be raised when an arc completes verification without a QA
 * step-list walk (the walk is opt-in) and the capability has not yet been
 * offered to the operator for this project.
 */
export interface QaStepListOptInPayload {
  arcId: string
}

/**
 * No raiser for this kind exists in the current codebase. The interface is
 * typed from the keys its recipe reads in `action-queue-recipes.ts`.
 *
 * Intended to be raised after a step-list walk completes, asking the operator
 * whether to promote the QA manifest into project documentation.
 */
export interface QaStepListPromotePayload {
  arcId: string
  manifestPath: string
}

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface ValidationQaContracts {
  'awaiting-validation': AwaitingValidationPayload
  'awaiting-validation-preview-gone': AwaitingValidationPreviewGonePayload
  'behaviour-unverified': BehaviourUnverifiedPayload
  'mockup-ready': MockupReadyPayload
  'qa-step-list-opt-in': QaStepListOptInPayload
  'qa-step-list-promote': QaStepListPromotePayload
}

/** Representative fixtures for the payload-contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<keyof ValidationQaContracts, Record<string, unknown>> = {
  'awaiting-validation': {
    taskId: 'mars-a1b2c3d4',
    devServerUrl: 'https://preview.example.com',
    remoteUrl: 'https://preview.example.com',
    branch: 'task/mars-a1b2c3d4',
  },
  'awaiting-validation-preview-gone': {
    devServerUrl: 'https://preview.example.com',
    remoteUrl: 'https://preview.example.com',
    previewUnavailableAt: '2026-08-25T12:00:00.000Z',
    branch: 'task/mars-b2c3d4e5',
  },
  'behaviour-unverified': {
    taskId: 'mars-c3d4e5f6',
    originTaskId: 'mars-c3d4e5f6',
    proposalId: 'prop-abc123',
    reason: 'no-preview-command',
    criteria: ['The button saves the form'],
    devServerLogPath: '/tmp/mars/logs/dev.log',
    artifactsDir: '/tmp/mars/artifacts',
  },
  'mockup-ready': {
    proposalId: 'prop-abc123',
    taskId: 'mars-d4e5f6a7',
  },
  'qa-step-list-opt-in': {
    arcId: 'mars-e5f6a7b8',
  },
  'qa-step-list-promote': {
    arcId: 'mars-f6a7b8c9',
    manifestPath: '/tmp/.mars/qa-passes/mars-f6a7b8c9/manifest.json',
  },
}
