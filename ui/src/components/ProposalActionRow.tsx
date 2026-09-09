import { useCallback, useState } from 'react'
import { postAction, startThreadFromProposal } from '@/shared/api'
import { taskHash } from '@/shared/routing'

/**
 * Props for the `ProposalActionRow` component.
 *
 * The component is self-contained: it owns all per-action state machines and
 * calls the action API helpers internally. The parent only needs to supply the
 * minimal context that cannot be derived inside the component.
 */
export interface ProposalActionRowProps {
  /** ID of the proposal to act on. */
  proposalId: string
  /** Current proposal lifecycle status; reserved for future conditional rendering. */
  status: string
  /**
   * Whether a mockup file exists for this proposal. When true the action row
   * may surface a "View mockup" affordance (consumer slice extensibility).
   */
  mockupExists?: boolean
  /** URL of the proposal's mockup HTML file (used alongside `mockupExists`). */
  mockupUrl?: string
  /**
   * When true, the Promote and Implement live buttons are disabled with a
   * tooltip explaining that the problem or solution must be filled in first.
   * Set by the parent when both `problem` and `solution` are blank.
   */
  bodyEmpty?: boolean
  /**
   * Called after a successful Dismiss so the parent can react (e.g. close the drawer).
   * Optional — omit when no parent-level cleanup is needed on dismiss.
   */
  onDismissed?: () => void
  /**
   * Called when a navigation-triggering action (e.g. Grill) needs the parent to
   * close without scheduling its own exit animation. Optional — the hash change
   * from Grill already unmounts the drawer; pass only when an explicit pre-nav
   * close is desirable.
   */
  onClose?: () => void
  /**
   * Called when an action triggers a navigation so the parent can react (e.g.
   * close an overlay before the hash change completes). Optional.
   */
  onNavigate?: () => void
}

/**
 * Shared action row rendered inside the proposal detail drawer (and any other
 * proposal surface that needs the same five actions). Encapsulates all async
 * state machines for Promote / Grill / Mockup / Implement live / Dismiss.
 *
 * `postAction` and `startThreadFromProposal` are imported from `@/shared/api`
 * so both are independently testable without mounting this component.
 */
export const ProposalActionRow = ({
  proposalId,
  bodyEmpty,
  onDismissed,
}: ProposalActionRowProps) => {
  const [promoteState, setPromoteState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; taskId?: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const [grillState, setGrillState] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const [mockupState, setMockupState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; taskId: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const [implementLiveState, setImplementLiveState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; taskId: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const [dismissState, setDismissState] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'done' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const handlePromote = useCallback(async () => {
    if (promoteState.kind === 'pending') return
    setPromoteState({ kind: 'pending' })
    try {
      const result = await postAction('promote', proposalId)
      setPromoteState({ kind: 'done', taskId: result.taskIds?.[0] })
    } catch (err) {
      setPromoteState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, promoteState.kind])

  const handleGrill = useCallback(async () => {
    if (grillState.kind === 'pending') return
    setGrillState({ kind: 'pending' })
    try {
      const { threadId } = await startThreadFromProposal(proposalId)
      // Navigate to the created thread. Do NOT call onClose() here —
      // handleClose schedules onClose() for 180 ms later, which would call
      // navigateReplace('#/progress') and overwrite the #/chat?thread=<id>
      // destination. The hash change itself causes App.tsx to re-render, setting
      // proposalId → null, which unmounts the drawer without any explicit close.
      if (typeof window !== 'undefined') {
        window.location.hash = `#/chat?thread=${encodeURIComponent(threadId)}`
      }
    } catch (err) {
      setGrillState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, grillState.kind])

  const handleMockup = useCallback(async () => {
    if (mockupState.kind === 'pending') return
    setMockupState({ kind: 'pending' })
    try {
      const result = await postAction('proposal.mockup', proposalId)
      const taskId = (result as { taskId?: string }).taskId ?? ''
      setMockupState({ kind: 'done', taskId })
    } catch (err) {
      setMockupState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, mockupState.kind])

  const handleImplementLive = useCallback(async () => {
    if (implementLiveState.kind === 'pending') return
    setImplementLiveState({ kind: 'pending' })
    try {
      const result = await postAction('proposal.implement-live', proposalId)
      const taskId = (result as { taskId?: string }).taskId ?? ''
      setImplementLiveState({ kind: 'done', taskId })
    } catch (err) {
      setImplementLiveState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, implementLiveState.kind])

  const handleDismiss = useCallback(async () => {
    if (dismissState.kind === 'pending') return
    setDismissState({ kind: 'pending' })
    try {
      await postAction('dismiss', proposalId)
      setDismissState({ kind: 'done' })
      onDismissed?.()
    } catch (err) {
      setDismissState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, dismissState.kind, onDismissed])

  return (
    <div
      data-testid="proposal-action-row"
      className="flex items-center gap-2 border-b border-border px-4 py-2"
    >
      {/* Promote */}
      {promoteState.kind === 'done' ? (
        <span className="font-mono text-micro text-primary">
          {promoteState.taskId
            ? (
              <>
                Promoted →{' '}
                <a
                  href={taskHash(promoteState.taskId)}
                  className="underline"
                >
                  {promoteState.taskId}
                </a>
              </>
            )
            : 'Promoted'}
        </span>
      ) : (
        <button
          type="button"
          data-testid="btn-promote"
          onClick={() => { void handlePromote() }}
          disabled={promoteState.kind === 'pending' || !!bodyEmpty}
          title={bodyEmpty ? 'Fill in the problem or solution first' : undefined}
          className="rounded border border-border px-2 py-0.5 font-mono text-body text-primary hover:bg-foreground/5 disabled:opacity-50"
        >
          {promoteState.kind === 'pending' ? 'Promoting…' : 'Promote'}
        </button>
      )}
      {promoteState.kind === 'error' && (
        <span className="font-mono text-micro text-destructive">{promoteState.message}</span>
      )}

      {/* Grill */}
      <button
        type="button"
        data-testid="btn-grill"
        onClick={() => { void handleGrill() }}
        disabled={grillState.kind === 'pending'}
        className="rounded border border-border px-2 py-0.5 font-mono text-body text-primary hover:bg-foreground/5 disabled:opacity-50"
      >
        {grillState.kind === 'pending' ? 'Opening…' : 'Grill'}
      </button>
      {grillState.kind === 'error' && (
        <span data-testid="grill-error" className="font-mono text-micro text-destructive">
          {grillState.message}
        </span>
      )}

      {/* Mockup */}
      {mockupState.kind === 'done' ? (
        <span className="font-mono text-micro text-primary">
          Mockup queued →{' '}
          <a href={taskHash(mockupState.taskId)} className="underline">
            {mockupState.taskId}
          </a>
        </span>
      ) : (
        <button
          type="button"
          data-testid="btn-mockup"
          onClick={() => { void handleMockup() }}
          disabled={mockupState.kind === 'pending'}
          className="rounded border border-border px-2 py-0.5 font-mono text-body text-primary hover:bg-foreground/5 disabled:opacity-50"
        >
          {mockupState.kind === 'pending' ? 'Queuing…' : 'Mockup'}
        </button>
      )}
      {mockupState.kind === 'error' && (
        <span className="font-mono text-micro text-destructive">{mockupState.message}</span>
      )}

      {/* Implement live */}
      {implementLiveState.kind === 'done' ? (
        <span className="font-mono text-micro text-primary">
          Live task →{' '}
          <a
            href={taskHash(implementLiveState.taskId)}
            className="underline"
          >
            {implementLiveState.taskId}
          </a>
        </span>
      ) : (
        <button
          type="button"
          data-testid="btn-implement-live"
          onClick={() => { void handleImplementLive() }}
          disabled={implementLiveState.kind === 'pending' || !!bodyEmpty}
          title={bodyEmpty ? 'Fill in the problem or solution first' : undefined}
          className="rounded border border-border px-2 py-0.5 font-mono text-body text-primary hover:bg-foreground/5 disabled:opacity-50"
        >
          {implementLiveState.kind === 'pending' ? 'Queuing…' : 'Implement live'}
        </button>
      )}
      {implementLiveState.kind === 'error' && (
        <span className="font-mono text-micro text-destructive">{implementLiveState.message}</span>
      )}

      {/* Dismiss */}
      {dismissState.kind === 'done' ? (
        <span className="text-micro text-muted-foreground">Dismissed</span>
      ) : (
        <button
          type="button"
          data-testid="btn-dismiss"
          onClick={() => { void handleDismiss() }}
          disabled={dismissState.kind === 'pending'}
          className="rounded border border-border px-2 py-0.5 font-mono text-body text-muted-foreground hover:bg-foreground/5 disabled:opacity-50"
        >
          {dismissState.kind === 'pending' ? 'Dismissing…' : 'Dismiss'}
        </button>
      )}
      {dismissState.kind === 'error' && (
        <span className="font-mono text-micro text-destructive">{dismissState.message}</span>
      )}
    </div>
  )
}
