import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProposalDetail, ProgressTask } from '@/shared/schemas'
import { CopyButton } from '@/components/CopyButton'
import { CollapsibleSection } from '@/components/CollapsibleSection'

interface ProposalDetailDrawerProps {
  /** Full proposal record sourced from GET /api/proposals/:id. */
  proposal: ProposalDetail
  /** Clears the `#/proposal/<id>` hash so the drawer closes. */
  onClose: () => void
  /**
   * Task list already loaded by the Progress tab. Used to show child tasks
   * when the proposal status is `sliced`. No new HTTP request is made.
   */
  tasks?: ProgressTask[]
}

/**
 * Status-badge colour pairs for the proposal lifecycle. The class shape
 * mirrors the task `StatusChip` legend (rounded, mono, uppercase) so the two
 * drawers read as one visual family. Unknown statuses fall back to the neutral
 * iron treatment rather than rendering nothing.
 */
const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-primary/10 text-primary',
  'prd-ready': 'bg-warn/15 text-warn',
  sliced: 'bg-warn/15 text-warn',
  dismissed: 'bg-primary/10 text-primary line-through',
}

const badgeClass = (status: string): string =>
  STATUS_BADGE[status] ?? 'bg-primary/10 text-primary'

/**
 * Copy-pasteable CLI commands shown in the drawer for each proposal status.
 * Informational only — separate action buttons handle mutations.
 */
const STATUS_CLI_VERBS: Record<string, string[]> = {
  draft: ['promote', 'show'],
  'prd-ready': ['slice', 'show'],
  sliced: ['show'],
  dismissed: ['show'],
}

/**
 * A collapsible proposal body section with optional "Read more / Show less"
 * clamping for long text. Open by default so the content is visible on first
 * paint — operators can close a section they don't need.
 *
 * Called four times (problem / solution / outOfScope / notes), satisfying the
 * multi-caller requirement and keeping clamp logic in one place.
 */
const BodySection = ({
  label,
  text,
  testId,
  maxLines = 8,
}: {
  label: string
  text: string
  testId: string
  maxLines?: number
  children?: ReactNode
}) => {
  const [expanded, setExpanded] = useState(false)
  const lineCount = text.split('\n').length
  const isLong = lineCount > maxLines

  return (
    <section data-testid={testId} className="border-b border-primary/40 px-4 py-3">
      <CollapsibleSection label={label} defaultOpen>
        <div>
          <p
            className="whitespace-pre-wrap font-mono text-xs text-foreground"
            style={
              isLong && !expanded
                ? {
                    display: '-webkit-box',
                    WebkitLineClamp: maxLines,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }
                : undefined
            }
          >
            {text}
          </p>
          {isLong ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 font-mono text-[10px] text-primary underline hover:text-foreground"
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          ) : null}
        </div>
      </CollapsibleSection>
    </section>
  )
}

/** Navigate to a chat thread by writing the `#/chat?thread=<id>` hash. */
const navigateToThread = (threadId: string): void => {
  if (typeof window === 'undefined') return
  window.location.hash = `#/chat?thread=${encodeURIComponent(threadId)}`
}

const BASE = typeof import.meta !== 'undefined' && import.meta.env
  ? (import.meta.env.VITE_API_BASE ?? '')
  : ''

async function postAction(op: string, entityId: string): Promise<{ taskIds?: string[] }> {
  const r = await fetch(`${BASE}/api/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, entityId }),
  })
  if (!r.ok) {
    let message = `POST /api/actions → ${r.status}`
    try {
      const body = await r.json() as { error?: string }
      if (typeof body.error === 'string' && body.error.length > 0) message = body.error
    } catch { /* ignore JSON parse errors */ }
    throw new Error(message)
  }
  return r.json() as Promise<{ taskIds?: string[] }>
}

async function startThreadFromProposal(proposalId: string): Promise<{ threadId: string }> {
  const r = await fetch(`${BASE}/api/proposals/${encodeURIComponent(proposalId)}/thread`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`POST /api/proposals/${proposalId}/thread → ${r.status}`)
  return r.json() as Promise<{ threadId: string }>
}

/**
 * Proposal detail drawer — renders at `#/proposal/<id>`.
 *
 * Shows the full proposal body (title, problem, solution, user stories,
 * outOfScope, notes) plus an action row with Promote, Grill, and Dismiss
 * buttons wired to the existing server surfaces.
 */
export const ProposalDetailDrawer = ({
  proposal,
  onClose,
  tasks = [],
}: ProposalDetailDrawerProps) => {
  const childTasks = proposal.status === 'sliced'
    ? tasks.filter((t) => t.parentProposalId === proposal.id)
    : []
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  const [promoteState, setPromoteState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; taskId?: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [grillState, setGrillState] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [dismissState, setDismissState] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'done' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  /**
   * Initiates the exit animation (180 ms) then calls the onClose prop.
   * All close triggers (button, scrim, Escape) funnel through here so the
   * transition always plays before the parent unmounts the drawer.
   */
  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // On open: save the previously focused element and move focus into the drawer.
  // On close (cleanup): restore focus to where it was.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    drawerRef.current?.focus()
    return () => {
      prev?.focus?.()
    }
  }, [])

  // Escape-to-close + Tab focus trap.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
        return
      }
      if (e.key === 'Tab') {
        const container = drawerRef.current
        if (!container) return
        const focusable = [
          ...container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === container) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClose])

  const handlePromote = useCallback(async () => {
    if (promoteState.kind === 'pending') return
    setPromoteState({ kind: 'pending' })
    try {
      const result = await postAction('promote', proposal.id)
      // Surface the first created task ID so the user can navigate to it.
      setPromoteState({ kind: 'done', taskId: result.taskIds?.[0] })
    } catch (err) {
      setPromoteState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposal.id, promoteState.kind])

  const handleGrill = useCallback(async () => {
    if (grillState.kind === 'pending') return
    setGrillState({ kind: 'pending' })
    try {
      const { threadId } = await startThreadFromProposal(proposal.id)
      // Navigate to the created thread. Do NOT call handleClose() here —
      // handleClose schedules onClose() for 180 ms later, which would call
      // navigateReplace('#/progress') and overwrite the #/chat?thread=<id>
      // destination. The hash change itself causes App.tsx to re-render, setting
      // proposalId → null, which unmounts this drawer without any explicit close.
      navigateToThread(threadId)
    } catch (err) {
      setGrillState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposal.id, grillState.kind])

  const handleDismiss = useCallback(async () => {
    if (dismissState.kind === 'pending') return
    setDismissState({ kind: 'pending' })
    try {
      await postAction('dismiss', proposal.id)
      setDismissState({ kind: 'done' })
    } catch (err) {
      setDismissState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposal.id, dismissState.kind])

  const isDraft = proposal.status === 'draft'

  // Format createdAt timestamp as a locale date string.
  const createdLabel = proposal.createdAt
    ? new Date(proposal.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) so clicks outside dismiss the panel */}
      <div
        data-testid="proposal-detail-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 bg-foreground/40"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Proposal detail"
        data-testid="proposal-detail-drawer"
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-primary/40 bg-background shadow-2xl outline-none"
      >
      <header className="flex items-start justify-between gap-3 border-b border-primary/40 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h2
            data-testid="proposal-detail-title"
            className="break-words font-mono text-sm text-foreground"
          >
            {proposal.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="proposal-detail-status"
              aria-label={`status ${proposal.status}`}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${badgeClass(
                proposal.status,
              )}`}
            >
              {proposal.status}
            </span>
            <span
              data-testid="proposal-detail-source"
              className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground"
            >
              {proposal.source}
            </span>
            {proposal.author && (
              <span
                data-testid="proposal-detail-author"
                className="font-mono text-[9px] text-muted-foreground"
              >
                {proposal.author.name}
              </span>
            )}
            {createdLabel && (
              <span
                data-testid="proposal-detail-created"
                className="font-mono text-[9px] text-muted-foreground"
              >
                {createdLabel}
              </span>
            )}
            {proposal.userStories.length > 0 && (
              <span
                data-testid="proposal-detail-story-count"
                className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground"
              >
                {proposal.userStories.length}{' '}
                {proposal.userStories.length === 1 ? 'story' : 'stories'}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close proposal detail"
          data-testid="proposal-detail-close"
          className="shrink-0 rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-primary hover:bg-primary/10"
        >
          Close
        </button>
      </header>

      {/* Action row — Promote / Grill / Dismiss — visible for actionable statuses */}
      {(isDraft) && (
        <div
          data-testid="proposal-action-row"
          className="flex items-center gap-2 border-b border-primary/40 px-4 py-2"
        >
          {/* Promote */}
          {promoteState.kind === 'done' ? (
            <span className="font-mono text-[10px] text-primary">
              {promoteState.taskId
                ? <>Promoted → <a href={`#/task/${encodeURIComponent(promoteState.taskId)}`} className="underline">{promoteState.taskId}</a></>
                : 'Promoted'}
            </span>
          ) : (
            <button
              type="button"
              data-testid="btn-promote"
              onClick={() => { void handlePromote() }}
              disabled={promoteState.kind === 'pending'}
              className="rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {promoteState.kind === 'pending' ? 'Promoting…' : 'Promote'}
            </button>
          )}
          {promoteState.kind === 'error' && (
            <span className="font-mono text-[9px] text-destructive">{promoteState.message}</span>
          )}

          {/* Grill */}
          <button
            type="button"
            data-testid="btn-grill"
            onClick={() => { void handleGrill() }}
            disabled={grillState.kind === 'pending'}
            className="rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {grillState.kind === 'pending' ? 'Opening…' : 'Grill'}
          </button>
          {grillState.kind === 'error' && (
            <span data-testid="grill-error" className="font-mono text-[9px] text-destructive">{grillState.message}</span>
          )}

          {/* Dismiss */}
          {dismissState.kind === 'done' ? (
            <span className="font-mono text-[10px] text-muted-foreground">Dismissed</span>
          ) : (
            <button
              type="button"
              data-testid="btn-dismiss"
              onClick={() => { void handleDismiss() }}
              disabled={dismissState.kind === 'pending'}
              className="rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-primary/5 disabled:opacity-50"
            >
              {dismissState.kind === 'pending' ? 'Dismissing…' : 'Dismiss'}
            </button>
          )}
          {dismissState.kind === 'error' && (
            <span className="font-mono text-[9px] text-destructive">{dismissState.message}</span>
          )}
        </div>
      )}

      {/* Scrollable body — problem, solution, user stories, outOfScope, notes, sliced tasks */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {proposal.problem.trim() ? (
          <BodySection
            label="Problem"
            text={proposal.problem}
            testId="proposal-detail-problem"
          />
        ) : null}

        {proposal.solution.trim() ? (
          <BodySection
            label="Solution"
            text={proposal.solution}
            testId="proposal-detail-solution"
          />
        ) : null}

        {proposal.userStories.length > 0 ? (
          <section
            data-testid="proposal-detail-stories"
            className="border-b border-primary/40 px-4 py-3"
          >
            <CollapsibleSection label="User stories" defaultOpen>
              <ol className="flex flex-col gap-1.5">
                {proposal.userStories.map((story, idx) => (
                  <li key={idx} className="flex gap-2 font-mono text-xs text-foreground">
                    <span className="shrink-0 text-muted-foreground">{idx + 1}.</span>
                    <span>{story}</span>
                  </li>
                ))}
              </ol>
            </CollapsibleSection>
          </section>
        ) : null}

        {proposal.outOfScope.trim() ? (
          <BodySection
            label="Out of scope"
            text={proposal.outOfScope}
            testId="proposal-detail-out-of-scope"
          />
        ) : null}

        {proposal.notes.trim() ? (
          <BodySection
            label="Notes"
            text={proposal.notes}
            testId="proposal-detail-notes"
          />
        ) : null}

        {childTasks.length > 0 ? (
          <section
            data-testid="sliced-tasks"
            className="flex flex-col gap-2 border-b border-primary/40 px-4 py-3"
          >
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Sliced tasks
            </h3>
            <ul className="flex flex-col gap-1.5">
              {childTasks.map((task) => (
                <li key={task.id}>
                  <a
                    href={`#/task/${encodeURIComponent(task.id)}`}
                    className="flex items-center gap-2 rounded border border-primary/20 px-2 py-1.5 font-mono text-xs transition-colors hover:bg-primary/5"
                  >
                    <span className="shrink-0 text-primary">{task.id}</span>
                    <span
                      className={`inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeClass(task.status)}`}
                    >
                      {task.status}
                    </span>
                    <span className="min-w-0 truncate text-foreground">
                      {task.prompt.split('\n')[0]?.slice(0, 80) ?? ''}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* CLI commands — read-only, status-appropriate, copy-to-clipboard */}
      <section className="border-t border-primary/40 px-4 py-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          CLI
        </p>
        {(STATUS_CLI_VERBS[proposal.status] ?? ['show']).map((verb) => {
          const cmd = `mars proposal ${verb} ${proposal.id}`
          return (
            <div key={verb} className="mb-1.5 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-primary/10 px-2 py-1 font-mono text-xs text-foreground">
                {cmd}
              </code>
              <CopyButton
                text={cmd}
                data-testid="copy-cli-cmd"
                aria-label={`Copy: ${cmd}`}
              />
            </div>
          )
        })}
      </section>
    </aside>
    </>
  )
}
