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
  const verbs: AlertVerb[] =
    recipeVerbs.length > 0
      ? recipeVerbs
      : item.actions.map((a) => ({
          op: a.op,
          label: a.label,
          // Destructive ops get destructive style; everything else default.
          style: (['purge', 'dismiss', 'reject'] as string[]).includes(a.op)
            ? 'destructive'
            : 'default',
        }))

  const summary = item.humanSummary || item.title

  return (
    <AlertCard
      itemId={item.id}
      entityId={item.entityId}
      kind={item.kind}
      summary={summary}
      detail={item.humanDetail}
      verbs={verbs}
      resolved={item.resolution != null}
      snoozeUntil={item.snoozeUntil}
    />
  )
}
