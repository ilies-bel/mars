/**
 * ConfirmDestructive — the single arm-then-confirm gate for destructive verbs.
 *
 * Both TriagePage and TaskDetailDrawer import this component so "the single
 * canonical gate" claim in TriagePage's armedVerb comment is actually true.
 *
 * Usage:
 *   const [armedVerb, setArmedVerb] = useState<AlertVerb | null>(null)
 *
 *   // On destructive button click:
 *   setArmedVerb(verb)
 *
 *   // In render:
 *   {armedVerb !== null && (
 *     <ConfirmDestructive
 *       verb={armedVerb}
 *       entityId={item.entityId}
 *       branch={item.humanDetail?.branch ?? null}
 *       continueAvailable={verbs.some((v) => v.op === 'continue')}
 *       pending={pending}
 *       onConfirm={() => void handleVerb(armedVerb.op, armedVerb.hint)}
 *       onCancel={() => setArmedVerb(null)}
 *     />
 *   )}
 */

import type { AlertVerb } from '@/shared/schemas'
import { ActionButton } from '@/components/ActionButton'

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * What the destructive verb actually destroys, in the operator's terms.
 *
 * Each verb gets its own sentence so the operator knows what they're being
 * careful about — "this can't be undone" alone tells them to be careful
 * without naming the cost.
 */
function destructiveConsequence(
  op: string,
  entityId: string,
  branch: string | null,
  /**
   * Whether this row is actually offering Continue. The restart sentence used
   * to recommend Continue unconditionally — including on rows that withhold
   * it because the task's one recovery attempt is spent, and on setup
   * failures with no worktree to continue on. Pointing at a button that is
   * not on screen is worse than not naming an alternative at all.
   */
  continueAvailable: boolean,
): string {
  const hasBranch = branch !== null && branch !== ''
  const where = hasBranch ? `${entityId} (branch ${branch})` : entityId
  switch (op) {
    case 'restart':
      if (!hasBranch) {
        return `Restart ${entityId} — re-runs it from setup. No branch was ever created for this task, so nothing on disk is lost.`
      }
      return continueAvailable
        ? `Restart ${where} — wipes the worktree and branch, losing any commits the worker made. Continue reuses them instead. This can't be undone.`
        : `Restart ${where} — wipes the worktree and branch, losing any commits the worker made. This can't be undone.`
    case 'purge':
    case 'drop':
      return `Delete ${where} — removes the task, its worktree, its branch and its blocker edges. This can't be undone.`
    case 'discard':
      return `Discard ${where} — the task is dropped and anything on its branch goes with it. This can't be undone.`
    default:
      return `${op} on ${where} — this can't be undone.`
  }
}

/**
 * The confirming button's own label.
 *
 * Echoing the trigger's full label gave "Yes, restart (wipe & re-run)" — the
 * parenthetical belongs on the button being decided about, not the one that
 * commits. The consequence sentence beside it already carries the detail.
 */
function confirmLabel(op: string, label: string): string {
  switch (op) {
    case 'restart':
      return 'Yes, restart'
    case 'purge':
    case 'drop':
      return 'Yes, delete'
    case 'discard':
      return 'Yes, discard'
    default:
      return `Yes, ${label.toLowerCase()}`
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface ConfirmDestructiveProps {
  verb: AlertVerb
  entityId: string
  branch: string | null
  continueAvailable: boolean
  pending: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** The single arm-then-confirm gate every destructive verb passes through. */
export const ConfirmDestructive = ({
  verb,
  entityId,
  branch,
  continueAvailable,
  pending,
  onConfirm,
  onCancel,
}: ConfirmDestructiveProps) => (
  <span
    className="flex w-full flex-wrap items-center gap-2 rounded border border-error/40 bg-error/5 px-2 py-1.5"
    data-testid="triage-restart-confirm"
    data-op={verb.op}
  >
    <span className="flex-1 text-micro leading-relaxed text-error">
      {destructiveConsequence(verb.op, entityId, branch, continueAvailable)}
    </span>
    <ActionButton
      variant="danger"
      size="sm"
      disabled={pending !== null}
      pending={pending === verb.op}
      onClick={onConfirm}
      data-testid="triage-restart-confirm-yes"
    >
      {confirmLabel(verb.op, verb.label)}
    </ActionButton>
    <ActionButton
      variant="ghost"
      size="sm"
      disabled={pending !== null}
      onClick={onCancel}
      data-testid="triage-restart-cancel"
    >
      Cancel
    </ActionButton>
  </span>
)
