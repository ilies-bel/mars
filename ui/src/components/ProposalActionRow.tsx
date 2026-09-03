/**
 * ProposalActionRow — action buttons for draft proposals.
 *
 * Self-contained: owns all per-action state machines and calls the action API
 * helpers internally. The parent only needs to supply the proposal ID and
 * current status.
 *
 * Currently rendered for `draft` proposals (the parent guards the status before
 * mounting this component). The `status` prop is exposed so future callers that
 * gate different action sets per-status can pass the full lifecycle value without
 * a breaking interface change.
 */

import { useCallback, useState } from 'react'

const BASE =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env.VITE_API_BASE ?? '')
    : ''

async function postAction(op: string, entityId: string): Promise<{ taskIds?: string[]; taskId?: string }> {
  const r = await fetch(`${BASE}/api/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, entityId }),
  })
  if (!r.ok) {
    let message = `POST /api/actions → ${r.status}`
    try {
      const body = (await r.json()) as { error?: string }
      if (typeof body.error === 'string' && body.error.length > 0) message = body.error
    } catch {
      /* ignore JSON parse errors */
    }
    throw new Error(message)
  }
  return r.json() as Promise<{ taskIds?: string[]; taskId?: string }>
}

async function startThreadFromProposal(proposalId: string): Promise<{ threadId: string }> {
  const r = await fetch(`${BASE}/api/proposals/${encodeURIComponent(proposalId)}/thread`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`POST /api/proposals/${proposalId}/thread → ${r.status}`)
  return r.json() as Promise<{ threadId: string }>
}

export interface ProposalActionRowProps {
  /** ID of the proposal to act on. */
  proposalId: string
  /** Current proposal lifecycle status; informational — parent should gate mounting on 'draft'. */
  status: string
  /**
   * Called after a navigation-triggering action (Grill redirects to a chat
   * thread). Lets the parent skip its own close animation, since the hash
   * change will unmount it anyway.
   */
  onNavigate?: () => void
}

export const ProposalActionRow = ({ proposalId, onNavigate }: ProposalActionRowProps) => {
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
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done' }
    | { kind: 'error'; message: string }
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
      // Signal the parent that navigation is about to happen, so it can skip
      // its own close animation (the hash change unmounts the drawer anyway).
      onNavigate?.()
      if (typeof window !== 'undefined') {
        window.location.hash = `#/chat?thread=${encodeURIComponent(threadId)}`
      }
    } catch (err) {
      setGrillState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, grillState.kind, onNavigate])

  const handleMockup = useCallback(async () => {
    if (mockupState.kind === 'pending') return
    setMockupState({ kind: 'pending' })
    try {
      const result = await postAction('proposal.mockup', proposalId)
      setMockupState({ kind: 'done', taskId: result.taskId ?? '' })
    } catch (err) {
      setMockupState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, mockupState.kind])

  const handleImplementLive = useCallback(async () => {
    if (implementLiveState.kind === 'pending') return
    setImplementLiveState({ kind: 'pending' })
    try {
      const result = await postAction('proposal.implement-live', proposalId)
      setImplementLiveState({ kind: 'done', taskId: result.taskId ?? '' })
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
    } catch (err) {
      setDismissState({ kind: 'error', message: (err as Error).message })
    }
  }, [proposalId, dismissState.kind])

  return (
    <div
      data-testid="proposal-action-row"
      className="flex items-center gap-2 border-b border-primary/40 px-4 py-2"
    >
      {/* Promote */}
      {promoteState.kind === 'done' ? (
        <span className="font-mono text-micro text-primary">
          {promoteState.taskId ? (
            <>
              Promoted →{' '}
              <a
                href={`#/task/${encodeURIComponent(promoteState.taskId)}`}
                className="underline"
              >
                {promoteState.taskId}
              </a>
            </>
          ) : (
            'Promoted'
          )}
        </span>
      ) : (
        <button
          type="button"
          data-testid="btn-promote"
          onClick={() => {
            void handlePromote()
          }}
          disabled={promoteState.kind === 'pending'}
          className="rounded border border-primary/40 px-2 py-0.5 font-mono text-body text-primary hover:bg-primary/10 disabled:opacity-50"
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
        onClick={() => {
          void handleGrill()
        }}
        disabled={grillState.kind === 'pending'}
        className="rounded border border-primary/40 px-2 py-0.5 font-mono text-body text-primary hover:bg-primary/10 disabled:opacity-50"
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
          <a href={`#/task/${encodeURIComponent(mockupState.taskId)}`} className="underline">
            {mockupState.taskId}
          </a>
        </span>
      ) : (
        <button
          type="button"
          data-testid="btn-mockup"
          onClick={() => {
            void handleMockup()
          }}
          disabled={mockupState.kind === 'pending'}
          className="rounded border border-primary/40 px-2 py-0.5 font-mono text-body text-primary hover:bg-primary/10 disabled:opacity-50"
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
            href={`#/task/${encodeURIComponent(implementLiveState.taskId)}`}
            className="underline"
          >
            {implementLiveState.taskId}
          </a>
        </span>
      ) : (
        <button
          type="button"
          data-testid="btn-implement-live"
          onClick={() => {
            void handleImplementLive()
          }}
          disabled={implementLiveState.kind === 'pending'}
          className="rounded border border-primary/40 px-2 py-0.5 font-mono text-body text-primary hover:bg-primary/10 disabled:opacity-50"
        >
          {implementLiveState.kind === 'pending' ? 'Queuing…' : 'Implement live'}
        </button>
      )}
      {implementLiveState.kind === 'error' && (
        <span className="font-mono text-micro text-destructive">{implementLiveState.message}</span>
      )}

      {/* Dismiss */}
      {dismissState.kind === 'done' ? (
        <span className="font-mono text-micro text-muted-foreground">Dismissed</span>
      ) : (
        <button
          type="button"
          data-testid="btn-dismiss"
          onClick={() => {
            void handleDismiss()
          }}
          disabled={dismissState.kind === 'pending'}
          className="rounded border border-primary/40 px-2 py-0.5 font-mono text-body text-muted-foreground hover:bg-primary/5 disabled:opacity-50"
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
