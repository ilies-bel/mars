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
import { relativeTime, formatAbsoluteDateTime } from '@/shared/time'
import { draftRowHeadline } from './queueThreads'
import { signatureFamilyPhrase } from './AlertCard'

// ---- Shared row helpers ----

export const priorityBadgeClass = (priority: string): string => {
  if (priority === 'high') return 'rounded bg-error/10 px-1.5 py-0.5 text-error'
  if (priority === 'normal') return 'rounded bg-warn/10 px-1.5 py-0.5 text-warn'
  return 'rounded px-1.5 py-0.5 text-muted-foreground'
}

const KIND_ICON: Record<string, string> = {
  failed: '⚠',
  'daemon-killed': '⊘',
  'stale-queued': '◔',
  'arc-failed': '⊗',
  'stale-worktree': '◌',
  'awaiting-validation': '⌁',
  'draft-proposal': '✦',
  'awaiting-human': '▸',
  'reflect-recommended': '✦',
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
  /**
   * Optional kind chip displayed beside the sender band.
   * 'alert'    → iron-tinted chip (operational alerts: failed tasks, stale queues…)
   * 'decision' → ochre-tinted chip (decision requests: awaiting-human, plan-approval…)
   * null       → no chip rendered
   */
  kindChip?: 'alert' | 'decision' | null
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
  kindChip = null,
}: RowProps) => {
  const why = whyNowText(item)
  // Non-restart Decisions that appear in the inline resolver and compact pill bar.
  const nonRestartActions = item.actions.filter((a) => a.op !== 'restart')

  return (
    <div
      className={[
        'relative cursor-pointer transition-colors flex items-stretch',
        active ? 'bg-primary/20' : 'hover:bg-accent',
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
          <span aria-hidden="true" className="shrink-0 text-label text-muted-foreground">{KIND_ICON[item.kind]}</span>
          <span className="shrink-0 font-mono text-micro text-foreground">Mars</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="text-micro font-semibold uppercase tracking-[0.07em] shrink-0 text-muted-foreground">{kindBadgeLabel(item.kind)}</span>
          {kindChip === 'alert' && (
            <span
              className="shrink-0 rounded bg-error/15 px-1.5 py-0.5 text-micro font-medium text-error"
              data-testid="kind-chip-alert"
            >
              alert
            </span>
          )}
          {kindChip === 'decision' && (
            <span
              className="shrink-0 rounded bg-status-blocked/15 px-1.5 py-0.5 text-micro font-medium text-status-blocked"
              data-testid="kind-chip-decision"
            >
              decision
            </span>
          )}
          {hasConversation && (
            <span
              aria-label="Discuss in chat"
              title="Discuss in chat"
              className="shrink-0 font-mono text-micro text-muted-foreground"
              data-testid="projection-has-conversation"
            >
              ⊙
            </span>
          )}
          <span
            className={`text-micro font-semibold uppercase tracking-[0.07em] ml-auto shrink-0 ${priorityBadgeClass(item.priority)} text-muted-foreground`}
          >
            {item.priority}
          </span>
        </div>

        {/* Entity ID — monospace, ≥11px for legibility */}
        <span className="break-all font-mono text-label text-muted-foreground">
          {item.entityId}
        </span>

        {/* Headline — §7 narrative hierarchy:
            - draft-proposal: first sentence of title (proposal still being shaped).
            - task-failure with operatorGoal: goal is primary, plain-phrase subhead.
            - everything else: humanSummary || title as sole headline.
            No raw failure-signature slug ever appears on the card face (DEC-18). */}
        {item.kind === 'draft-proposal' ? (
          <div
            className="mt-1 line-clamp-2 break-words font-mono text-body text-foreground"
            title={item.title}
          >
            {draftRowHeadline(item.title) || '(no title)'}
          </div>
        ) : item.operatorGoal ? (
          <>
            <div
              className="mt-1 line-clamp-2 break-words font-mono text-body text-foreground"
              data-testid="queue-row-goal"
            >
              {item.operatorGoal.split('\n')[0]?.trim() || '(no title)'}
            </div>
            {/* Plain-phrase subhead — maps signature family to English; slug stays hidden */}
            {(() => {
              const phrase =
                signatureFamilyPhrase(item.humanDetail?.failureSignature) ??
                item.humanSummary ??
                null
              return phrase ? (
                <div
                  className="mt-0.5 line-clamp-1 font-mono text-micro text-muted-foreground"
                  data-testid="queue-row-subhead"
                >
                  {phrase}
                </div>
              ) : null
            })()}
          </>
        ) : (
          <div className="mt-1 line-clamp-4 break-words font-mono text-body text-foreground">
            {item.humanSummary || item.title || '(no title)'}
          </div>
        )}

        {/* "Why now" subtitle — explains why the operator must act */}
        {why !== null && (
          <div className="mt-0.5 line-clamp-1 font-mono text-micro text-muted-foreground" title={why}>
            {why}
          </div>
        )}

        {/* Timestamp + restart button */}
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="font-mono text-micro text-muted-foreground" title={formatAbsoluteDateTime(item.at)}>
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
              className="text-micro font-semibold uppercase tracking-[0.07em] shrink-0 border border-foreground/60 px-2 py-0.5 text-foreground transition hover:bg-primary/20 active:scale-[0.97] disabled:opacity-50"
            >
              {restartPending ? 'Restarting…' : 'Restart'}
            </button>
          )}
        </div>

        {restartError !== null && (
          <div className="mt-1 font-mono text-micro text-error">
            {restartError}
          </div>
        )}

        {/* Compact Decision pills — inactive rows; quick visual affordance */}
        {!active && nonRestartActions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {nonRestartActions.slice(0, 3).map((a) => (
              <span
                key={a.id}
                className="text-micro font-semibold uppercase tracking-[0.07em] border border-border px-1 text-muted-foreground"
              >
                {a.label}
              </span>
            ))}
            {nonRestartActions.length > 3 && (
              <span className="font-mono text-micro text-muted-foreground">
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
                  'border px-2 py-0.5 text-micro uppercase transition active:scale-[0.97]',
                  DESTRUCTIVE_OPS_INLINE.has(action.op)
                    ? 'border-error/50 text-error hover:bg-error/10'
                    : 'border-border text-foreground hover:bg-primary/20',
                ].join(' ')}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {/* Kind-specific detail blocks — active only */}
        {active && isTaskFailureActionQueueKind(item.kind) && item.diagnosis?.text && (
          <div className="mt-1 line-clamp-2 font-mono text-micro text-muted-foreground">
            {item.diagnosis.text}
          </div>
        )}
        {active && item.kind === 'stale-worktree' && (
          <div className="mt-1 truncate font-mono text-micro text-muted-foreground">
            {item.staleWorktreeDetail.branch ??
              item.staleWorktreeDetail.prompt?.split('\n')[0]}
          </div>
        )}
        {active && item.kind === 'draft-proposal' && item.body && (
          <div className="mt-1 line-clamp-2 font-mono text-micro text-muted-foreground">
            {item.body.split('\n')[0]}
          </div>
        )}
        {active && item.kind === 'awaiting-validation' && item.devServerUrl && (
          <a
            href={item.devServerUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 block truncate font-mono text-micro text-foreground underline underline-offset-2"
          >
            {item.devServerUrl}
          </a>
        )}
      </div>
    </div>
  )
})
