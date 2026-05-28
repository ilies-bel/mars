/**
 * Built-in failure-reason catalog. Ships defaults baked into the `mars` binary
 * so a freshly initialised repo has a meaningful set of operator-facing failure
 * codes before any consumer overrides are written.
 *
 * Override semantics live in `lib/failure-reasons.ts`: a file under
 * `.mars/failure-reasons/<code>.yaml` whose `code` matches an entry here
 * replaces that entry wholesale (no deep-merge — the consumer owns the record).
 * Files introducing new codes are additive.
 *
 * Recipe references are reserved for a later slice — every entry here records
 * `recipe: null` for now. The first wired recipe arrives in slice F.
 */
import type { FailureReason } from '../lib/failure-reasons'

/**
 * Action menu shared by every catalog entry. Order matters: the inbox UI
 * renders buttons in this order, and `restart` is the conventional default.
 */
const COMMON_ACTIONS: FailureReason['availableActions'] = [
  {
    id: 'restart',
    label: 'Restart from scratch',
    cliHint: 'mars restart <id>',
  },
  {
    id: 'purge',
    label: 'Drop permanently',
    cliHint: 'mars purge <id>',
  },
  {
    id: 'dismiss',
    label: 'Dismiss',
    cliHint: null,
  },
]

/**
 * The seed catalog. Add to this list when a new failure surface lands; ship
 * a corresponding `.mars/failure-reasons/<code>.yaml` via `mars init` on the
 * next minor binary release.
 */
export const BUILT_IN_FAILURE_REASONS: readonly FailureReason[] = [
  {
    code: 'verify:typecheck',
    userMessage: 'Type checks failed during verification.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'verify:test',
    userMessage: 'Tests failed during verification.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'verify:lint',
    userMessage: 'Linting failed during verification.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'verify:main-dirty',
    userMessage:
      'The integration branch had uncommitted changes when this task tried to verify.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'code:no-edits-made',
    userMessage: 'The coder finished without writing any changes.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'code:timeout',
    userMessage: 'The coder did not finish within its time budget.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'code:over-budget',
    userMessage:
      'The coder exhausted its token budget without completing.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'merge:vcs-supervisor-aborted',
    userMessage:
      'The merge supervisor (Vega) could not reconcile a conflict and aborted.',
    recipe: null,
    availableActions: COMMON_ACTIONS,
  },
  {
    code: 'unknown',
    userMessage:
      'An unrecognised failure was recorded. Inspect the task transcript for details.',
    recipe: null,
    availableActions: [
      ...COMMON_ACTIONS,
      {
        id: 'investigate',
        label: 'Investigate',
        cliHint: null,
      },
    ],
  },
]

/** Sentinel code used as the fallback entry on `FailureReasonCatalog.get`. */
export const UNKNOWN_FAILURE_CODE = 'unknown'
