/**
 * ActionQueueRow — renders an action-queue item using the recipe-driven
 * alert card design shared with the chat transcript.
 *
 * Falls back gracefully to the legacy `title` / `actions` fields when the
 * backend has not yet migrated a given row to the recipe shape.
 *
 * The last lines of verify output are surfaced inside AlertCard from the
 * `detail.errorExcerpt` field when `operatorGoal` is present.
 */

import { AlertCard } from '@/widgets/chat/AlertCard'
import { signatureFamilyPhrase } from '@/shared/causePhrase'
import { isTaskFailureActionQueueKind, hasResolvableTask } from '@/shared/schemas'
import type { ActionQueueItem, AlertVerb } from '@/shared/schemas'
import { isDestructiveVerb } from '@/entities/actionQueue/destructiveVerb'

interface ActionQueueRowProps {
  item: ActionQueueItem
}

export const ActionQueueRow = ({ item }: ActionQueueRowProps) => {
  const isTaskFailure = isTaskFailureActionQueueKind(item.kind)

  // Derive verb list: prefer recipe verbs, fall back to legacy action descriptors.
  // Defensive guard: verbs may be absent on legacy items that bypass schema defaults.
  const recipeVerbs = item.verbs ?? []
  const verbSources: Array<{ op: string; label: string; hint?: string }> =
    recipeVerbs.length > 0
      ? recipeVerbs
      : item.actions.map((a) => ({ op: a.op, label: a.label, hint: a.hint }))

  // Style is derived from the op/label, never from the style field the backend
  // sends, so one row cannot disagree with the next about what a verb costs.
  //
  // `restart` is DESTRUCTIVE, and is named "Restart".
  //
  // This row used to do the opposite of both. On a task-failure row it
  // relabelled `restart` to "Continue" and styled it `primary` — so the
  // button read as the reversible recovery verb, looked like the recommended
  // action, and wiped the worktree, the branch and every commit the worker had
  // made. `continue` and `restart` are opposite operations in Mars: continue
  // resumes on the existing worktree and keeps the work; restart throws it
  // away. Naming one after the other is not a vocabulary preference.
  //
  // The reversible verb is now offered as itself, first, on rows that can
  // take it — `continue` is a first-class daemon op.
  //
  // isDestructiveVerb is the single shared predicate (entities/actionQueue/
  // destructiveVerb.ts); do NOT pass style here — this row derives style from
  // op/label only, never trusting the server's style field.
  const style = (op: string, label: string): AlertVerb['style'] =>
    isDestructiveVerb({ op, label })
      ? 'destructive'
      : op === 'continue'
        ? 'primary'
        : op === 'snooze'
          ? 'snooze'
          : 'default'

  const canonicalLabel = (op: string, label: string): string => {
    if (op === 'restart') return 'Restart'
    if (op === 'purge' || op === 'drop') return 'Delete task'
    if (op === 'continue') return 'Continue'
    return label
  }

  const derived: AlertVerb[] = verbSources.map((v) => ({
    op: v.op,
    label: canonicalLabel(v.op, v.label),
    hint: v.hint,
    style: style(v.op, canonicalLabel(v.op, v.label)),
  }))

  // A failed task with a worktree can always be continued, and that is the
  // verb Mars itself recommends first (`mars continue` before `mars restart`).
  // The daemon's recipes ship restart/purge but no continue, so the row would
  // otherwise offer only ways to lose work.
  // `hasResolvableTask` is the discriminator because `continue` needs a TASK to
  // resume, and only task-backed rows carry a dag: `failed` and
  // `recovery-abandoned` have one, while `slice-failed` (whose entity is a
  // proposal), `daemon-code-drift` and `signature-wave` do not.
  const offersContinue = derived.some((v) => v.op === 'continue')
  const continuable =
    isTaskFailure && hasResolvableTask(item) && !offersContinue && item.recoveryExhausted !== true
  const verbs: AlertVerb[] = continuable
    ? [{ op: 'continue', label: 'Continue', style: 'primary' as const }, ...derived]
    : derived

  // Prefer humanSummary (recipe-generated, human-readable).
  // If absent, derive a plain phrase from the failure signature before falling
  // back to item.title — which may contain raw machine slugs (DEC-18).
  const summary =
    item.humanSummary ||
    signatureFamilyPhrase(item.humanDetail?.failureSignature) ||
    item.title

  return (
    <AlertCard
      itemId={item.id}
      entityId={item.entityId}
      kind={item.kind}
      summary={summary}
      operatorGoal={item.operatorGoal ?? undefined}
      detail={item.humanDetail}
      verbs={verbs}
      resolved={item.resolution != null}
      snoozeUntil={item.snoozeUntil}
      isTaskBacked={hasResolvableTask(item)}
    />
  )
}
