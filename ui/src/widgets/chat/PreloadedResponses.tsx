import { useState } from 'react'
import { postPreloadedResponse } from '@/shared/api'
import type { PreloadedResponse } from '@/shared/schemas'

export interface PreloadedResponsesProps {
  messageId: string
  responses: PreloadedResponse[]
  resolved: boolean
  projectId?: string
  onComplete?: (threadId?: string) => void
}

/** Ordered, stored Notice responses that never enter the chat composer. */
export const PreloadedResponses = ({
  messageId,
  responses,
  resolved,
  projectId,
  onComplete,
}: PreloadedResponsesProps) => {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (responses.length === 0) return null

  const choose = async (response: PreloadedResponse) => {
    setPendingId(response.id)
    setError(null)
    try {
      const result = await postPreloadedResponse(messageId, response.id, projectId)
      onComplete?.(result.threadId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply that response.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="preloaded-responses">
      {responses.map((response) => {
        const disabled = resolved || pendingId !== null
        return (
          <button
            key={response.id}
            type="button"
            disabled={disabled}
            onClick={() => { void choose(response) }}
            className="rounded border border-primary/30 px-3 py-1 font-mono text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`preloaded-response-${response.id}`}
          >
            {resolved ? 'Resolved' : response.label}
          </button>
        )
      })}
      {error && <span role="alert" className="font-mono text-[11px] text-error">{error}</span>}
    </div>
  )
}
