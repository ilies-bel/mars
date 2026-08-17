/**
 * The `mars workflow validate` dry-run seam.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). When a
 * `validateRecorder` is threaded on `ctx.services`, every primitive records
 * its declaration and returns an inert result instead of doing real work.
 */
import { type MarsCtx } from './context'

// ---------------------------------------------------------------------------
// Validation recorder seam (`mars workflow validate`)
// ---------------------------------------------------------------------------

/**
 * One primitive declaration captured during a validation dry-run.
 *
 * `primitive` was a closed union of the seven names a `.record()` call site
 * below could pass. Opened to `string` — the actual set of legal ids/aliases
 * now lives in the open primitive registry (`./registry.ts`), which
 * `validate-workflow.ts` cross-checks each recorded entry against, and which
 * `workflow-lint.ts` derives its authoring-surface allowlist from. This is
 * what keeps those two checks from independently drifting the way the old
 * union and `core/lib/primitive-catalog.ts`'s `PRIMITIVE_NAMES` already had.
 */
export interface ValidateRecorderEntry {
  /** The ctx.step name the primitive ran under (null outside a step). */
  step: string | null
  /** A registered primitive id or alias (see `./registry.ts`). */
  primitive: string
  /** Execution mode the workflow declares for this step. */
  mode: 'auto' | 'manual' | 'full-review'
  /** Step guide for manual or full-review steps; null otherwise. */
  guide: string | null
}

/**
 * When present on `ctx.services`, every primitive records its declaration
 * (step name, primitive, Execution mode, Step guide) and returns an inert
 * result instead of doing real work — a dry-run that enumerates a user-owned
 * workflow's declared runbook with zero side effects. Threaded via services
 * (per-run state), never an env var, so the daemon can validate one workflow
 * while real dispatches run concurrently.
 */
export interface ValidateRecorder {
  record(entry: ValidateRecorderEntry): void
}

export const validationRecorder = (ctx: MarsCtx): ValidateRecorder | null =>
  (ctx.services as { validateRecorder?: ValidateRecorder }).validateRecorder ??
  null
