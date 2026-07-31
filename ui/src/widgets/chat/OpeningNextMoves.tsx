import { kindBadgeLabel } from '@/shared/actionQueueDetail'
import { isAlertQueueItem } from './queueThreads'

/**
 * Minimal row shape needed to render the opening queue summary.
 * Both real ActionQueueItems and synthetic rows derived from useTasks()
 * (e.g. tasks with status 'blocked' that are not yet in the action queue)
 * satisfy this interface.
 */
export interface DisplayRow {
  id: string
  kind: string
  title: string
  humanSummary: string
}

interface Group {
  key: string
  label: string
  items: DisplayRow[]
}

/**
 * Group rules (semantically truthful):
 *
 *  kind === 'blocked'        → "blocked tasks"   (synthetic rows from useTasks,
 *                               tasks whose status is 'blocked' in the DB)
 *  kind === 'draft-proposal' → "proposals to refine"
 *  anything else             → "alerts"           (failed-task, stale-worktree,
 *                               awaiting-validation, arc-failed, awaiting-human,
 *                               reflect-recommended, scorer-suggested, …)
 *
 * The "alerts" group must never be labelled "blocked tasks" — those are two
 * distinct states and conflating them misleads the operator.
 */
function groupQueueItems(rows: DisplayRow[]): Group[] {
  const alerts = rows.filter((r) => r.kind !== 'blocked' && isAlertQueueItem(r))
  const blocked = rows.filter((r) => r.kind === 'blocked')
  const proposals = rows.filter((r) => r.kind === 'draft-proposal')

  const groups: Group[] = []

  if (alerts.length > 0) {
    groups.push({
      key: 'alerts',
      label: alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`,
      items: alerts,
    })
  }

  if (blocked.length > 0) {
    groups.push({
      key: 'blocked',
      label: blocked.length === 1 ? '1 blocked task' : `${blocked.length} blocked tasks`,
      items: blocked,
    })
  }

  if (proposals.length > 0) {
    groups.push({
      key: 'proposals',
      label:
        proposals.length === 1
          ? '1 proposal to refine'
          : `${proposals.length} proposals to refine`,
      items: proposals,
    })
  }

  return groups
}

interface Props {
  rows: DisplayRow[]
  onPick: (row: DisplayRow) => void
}

export const OpeningNextMoves = ({ rows, onPick }: Props) => {
  if (rows.length === 0) return null

  const groups = groupQueueItems(rows)

  return (
    <div
      data-testid="opening-next-moves"
      className="mt-3 flex flex-col gap-4"
      aria-label="Pending work"
    >
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <span
            className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            data-testid="queue-group-header"
          >
            {group.label}
          </span>
          <div className="flex flex-col gap-0.5">
            {group.items.map((row, idx) => (
              <button
                key={row.id}
                type="button"
                data-testid="next-move-chip"
                className={[
                  'flex items-start gap-2 rounded px-2 py-1.5 text-left font-mono transition-colors',
                  'hover:bg-primary/10 active:scale-[0.98]',
                  idx === 0 ? 'text-foreground' : 'text-muted-foreground',
                ].join(' ')}
                onClick={() => onPick(row)}
              >
                <span className="mt-0.5 shrink-0 rounded border border-primary/25 px-1 font-mono text-[9px] uppercase text-primary">
                  {kindBadgeLabel(row.kind)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {row.title || row.humanSummary || kindBadgeLabel(row.kind)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
