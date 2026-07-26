/**
 * ActionQueueRow — renders an action-queue item using the recipe-driven
 * alert card design shared with the chat transcript.
 *
 * Falls back gracefully to the legacy `title` / `actions` fields when the
 * backend has not yet migrated a given row to the recipe shape.
 */

import { AlertCard } from '@/widgets/chat/AlertCard'
import type { ActionQueueItem, AlertVerb } from '@/shared/schemas'

interface ActionQueueRowProps {
  item: ActionQueueItem
}

export const ActionQueueRow = ({ item }: ActionQueueRowProps) => {
  // Derive verb list: prefer recipe verbs, fall back to legacy action descriptors.
  // Defensive guard: verbs may be absent on legacy items that bypass schema defaults.
  const recipeVerbs = item.verbs ?? []
  const verbSources: Array<{ op: string; label: string; hint?: string }> =
    recipeVerbs.length > 0
      ? recipeVerbs
      : item.actions.map((a) => ({ op: a.op, label: a.label, hint: a.hint }))

  // Always derive visual style from op so hierarchy is consistent
  // regardless of what the backend sends in the style field.
  const verbs: AlertVerb[] = verbSources.map((v) => ({
    op: v.op,
    label: v.label,
    hint: v.hint,
    style: (['purge', 'dismiss', 'reject'] as string[]).includes(v.op)
      ? 'destructive'
      : (['restart', 'retry'] as string[]).includes(v.op)
      ? 'primary'
      : v.op === 'snooze'
      ? 'snooze'
      : 'default',
  }))

  const summary = item.humanSummary || item.title

  return (
    <AlertCard
      itemId={item.id}
      entityId={item.entityId}
      kind={item.kind}
      summary={summary}
      goal={item.arcGoal ?? undefined}
      detail={item.humanDetail}
      verbs={verbs}
      resolved={item.resolution != null}
      snoozeUntil={item.snoozeUntil}
    />
  )
}
