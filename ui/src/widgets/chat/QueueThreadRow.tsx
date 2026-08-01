/**
 * QueueThreadRow — a projection Thread in the chat sidebar.
 *
 * Renders one open action-queue row as a conversation preview: Mars as the
 * sender, a compact first-message headline, why-now context, and the available
 * Decisions. Projection entries carry no delete affordance — they evaporate
 * only when the row leaves the queue.
 */

import { memo } from 'react'
import { isTaskFailureActionQueueKind, type ActionDescriptor, type ActionQueueItem } from '@/shared/schemas'
import { kindBadgeLabel, whyNowText } from '@/shared/actionQueueDetail'
import { relativeTime } from '@/shared/time'
import { draftRowHeadline } from './queueThreads'

// ---- Shared row helpers ----

export const formatTime = (iso: string): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export const priorityBadgeClass = (priority: string): string => {
  if (priority === 'high') return 'rounded bg-error/10 px-1.5 py-0.5 text-error'
  if (priority === 'normal') return 'rounded bg-warn/10 px-1.5 py-0.5 text-warn'
  return 'rounded px-1.5 py-0.5 text-muted-foreground'
}

const KIND_ICON: Record<string, string> = {
  failed: '⚠',
  'daemon-killed': '⛔',
  'stale-queued': '⏳',
  'arc-failed': '⛓',
  'stale-worktree': '◌',
  'awaiting-validation': '⌁',
  'draft-proposal': '✦',
  'awaiting-human': '⏳',
  'reflect-recommended': '💡',
  'scorer-suggested': '★',
}

/** Ops that receive destructive button styling in the inline resolver. */
const DESTRUCTIVE_OPS_INLINE = new Set(['purge', 'dismiss', 'reject'])

// ---- Row ----

interface RowProps {
  item: ActionQueueItem
  active: boolean
  /** Called with the item's id when the row is clicked. */
  onSelect: (id: string) => void
  /** Non-null when the item has a restart action and the button should render. */
  onRestart: ((entityId: string) => void) | null
  /** True while the restart mutation is in-flight for this specific item. */
  restartPending: boolean
  /** Non-null when the last restart attempt for this item failed; shows inline error. */
  restartError: string | null
  /**
   * Called when any non-restart Decision pill is clicked in the inline
   * resolver. The parent handles the actual mutation (optimistic removal +
   * rollback) so the row stays stateless w.r.t. React Query.
   */
  onAction?: (action: ActionDescriptor, item: ActionQueueItem) => void
  /** When the projection is merged with an alert-origin conversation. */
  hasConversation?: boolean
}

export const QueueThreadRow = memo(({
  item,
  active,
  onSelect,
  onRestart,
  restartPending,
  restartError,
  onAction,
  hasConversation = false,
}: RowProps) => {
  const why = whyNowText(item)
  // Non-restart Decisions that appear in the inline resolver and compact pill bar.
  const nonRestartActions = item.actions.filter((a) => a.op !== 'restart')

  return (
    <div
      className={[
        'relative cursor-pointer transition-colors flex items-stretch',
        active ? 'bg-primary/20' : 'hover:bg-primary/10',
      ].join(' ')}
      style={{ contentVisibility: 'auto' }}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      data-aq-row=""
      onClick={() => onSelect(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(item.id)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const allRows = Array.from(
            document.querySelectorAll<HTMLElement>('[data-aq-row]'),
          )
          const idx = allRows.indexOf(e.currentTarget)
          const next = e.key === 'ArrowDown' ? allRows[idx + 1] : allRows[idx - 1]
          next?.focus()
        }
      }}
    >
      <div className="min-w-0 flex-1 px-3 py-2">
        {/* Sender band: all queue rows read like the first message from Mars. */}
        <div className="flex items-baseline gap-2">
          <span aria-hidden="true" className="shrink-0 text-[11px] text-primary">{KIND_ICON[item.kind]}</span>
          <span className="shrink-0 font-mono text-[10px] text-foreground">Mars</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="shrink-0 font-mono text-[9px] uppercase text-muted-foreground">{kindBadgeLabel(item.kind)}</span>
          {hasConversation && (
            <span
              className="shrink-0 font-mono text-[9px] text-muted-foreground"
              title="Conversation started"
              data-testid="projection-has-conversation"
            >
              💬
            </span>
          )}
          <span
            className={`ml-auto shrink-0 font-mono text-[9px] uppercase ${priorityBadgeClass(item.priority)}`}
          >
            {item.priority}
          </span>
        </div>

        {/* Entity ID — monospace, ≥11px for legibility */}
        <span className="break-all font-mono text-[11px] text-primary">
          {item.entityId}
        </span>

        {/* Headline: title, line-clamped */}
        <div
          className={
            item.kind === 'draft-proposal'
              ? 'mt-1 line-clamp-2 break-words font-mono text-[12px] text-foreground'
              : 'mt-1 line-clamp-4 break-words font-mono text-[12px] text-foreground'
          }
          title={item.kind === 'draft-proposal' ? item.title : undefined}
        >
          {item.kind === 'draft-proposal'
            ? draftRowHeadline(item.title) || '(no title)'
            : item.title || '(no title)'}
        </div>

        {/* "Why now" subtitle — explains why the operator must act */}
        {why !== null && (
          <div className="mt-0.5 line-clamp-1 font-mono text-[10px] text-muted-foreground" title={why}>
            {why}
          </div>
        )}

        {/* Timestamp + restart button */}
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-muted-foreground" title={formatTime(item.at)}>
            {relativeTime(item.at)}
          </span>
          {onRestart !== null && (
            <button
              type="button"
              aria-label={`Restart ${item.entityId}`}
              disabled={restartPending}
              onClick={(e) => {
                e.stopPropagation()
                onRestart(item.entityId)
              }}
              className="shrink-0 border border-foreground/60 px-2 py-0.5 font-mono text-[10px] uppercase text-foreground transition hover:bg-primary/20 active:scale-[0.97] disabled:opacity-50"
            >
              {restartPending ? 'Restarting…' : 'Restart'}
            </button>
          )}
        </div>

        {restartError !== null && (
          <div className="mt-1 font-mono text-[10px] text-error">
            {restartError}
          </div>
        )}

        {/* Compact Decision pills — inactive rows; quick visual affordance */}
        {!active && nonRestartActions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {nonRestartActions.slice(0, 3).map((a) => (
              <span
                key={a.id}
                className="border border-primary/20 px-1 font-mono text-[9px] uppercase text-muted-foreground"
              >
                {a.label}
              </span>
            ))}
            {nonRestartActions.length > 3 && (
              <span className="font-mono text-[9px] text-muted-foreground">
                +{nonRestartActions.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Inline resolver — full Decision buttons when row is active/expanded */}
        {active && nonRestartActions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {nonRestartActions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onAction?.(action, item)
                }}
                className={[
                  'border px-2 py-0.5 font-mono text-[10px] uppercase transition active:scale-[0.97]',
                  DESTRUCTIVE_OPS_INLINE.has(action.op)
                    ? 'border-error/50 text-error hover:bg-error/10'
                    : 'border-primary/40 text-foreground hover:bg-primary/20',
                ].join(' ')}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {/* Kind-specific detail blocks — active only */}
        {active && isTaskFailureActionQueueKind(item.kind) && item.diagnosis?.text && (
          <div className="mt-1 line-clamp-2 font-mono text-[10px] text-muted-foreground">
            {item.diagnosis.text}
          </div>
        )}
        {active && item.kind === 'stale-worktree' && (
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {item.staleWorktreeDetail.branch ??
              item.staleWorktreeDetail.prompt?.split('\n')[0]}
          </div>
        )}
        {active && item.kind === 'draft-proposal' && item.body && (
          <div className="mt-1 line-clamp-2 font-mono text-[10px] text-muted-foreground">
            {item.body.split('\n')[0]}
          </div>
        )}
        {active && item.kind === 'awaiting-validation' && item.devServerUrl && (
          <a
            href={item.devServerUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 block truncate font-mono text-[10px] text-foreground underline underline-offset-2"
          >
            {item.devServerUrl}
          </a>
        )}
      </div>
    </div>
  )
})
