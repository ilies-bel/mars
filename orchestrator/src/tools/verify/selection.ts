/**
 * Verify step selection helpers shared by the `review` shell and consumer
 * slices. Split out of `workflows/primitives/index.ts` (TARGET §2.1).
 */
import { SPEC_VERIFY_CMD_STEP, type VerifyStepSpec } from '../../core/lib/git/verify'

// ---------------------------------------------------------------------------
// Spec-verifyCmd step builder (shared contract for consumer slices)
// ---------------------------------------------------------------------------

/**
 * Build a {@link VerifyStepSpec} that executes `spec.verifyCmd` verbatim as a
 * required verify step. The command is run through the shell (`sh -c`) so it
 * may contain pipes, redirects, and multi-command chains exactly as the task
 * author wrote them.
 *
 * Returns `null` when `verifyCmd` is null or empty so callers can test for
 * the absent-spec case without special-casing the string.
 *
 * **Used by consumer slices:**
 *   - "Execute spec.verifyCmd verbatim as a required verify step" — inserts
 *     this spec into the `steps` array before calling `verifyChanges`.
 *   - "Record per-command exit code and command line in verifyOutput" — uses
 *     the resulting `RanVerifyStep.exitCode` to surface the faithful exit code
 *     in the verifyOutput text and in recovery prompts.
 */
export const buildSpecVerifyCmdStep = (verifyCmd: string | null | undefined): VerifyStepSpec | null => {
  if (!verifyCmd || verifyCmd.trim().length === 0) return null
  return {
    name: SPEC_VERIFY_CMD_STEP,
    cmd: 'sh',
    args: ['-c', verifyCmd.trim()],
    required: true,
    tier: 'task',
  }
}
