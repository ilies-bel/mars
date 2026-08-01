import { useState } from 'react'
import { ackNotice, type Notice } from '@/entities/notices'
import { dispatchAlertVerb } from './alertVerbs'

export const NoticeMessage = ({ notice }: { notice: Notice }) => {
  const [pendingOp, setPendingOp] = useState<string | null>(null)

  const selectResponse = async (response: Notice['preloadedResponses'][number]) => {
    if (pendingOp !== null) return
    setPendingOp(response.op)
    try {
      await dispatchAlertVerb(notice.id, response.entityId, response.op)
      await ackNotice(notice.id)
    } finally {
      setPendingOp(null)
    }
  }

  return (
    <div className="notice">
      <div>{notice.body}</div>
      <div className="flex flex-wrap gap-2">
        {notice.preloadedResponses.map((response) => (
          <button
            key={response.op}
            type="button"
            disabled={pendingOp !== null}
            onClick={() => void selectResponse(response)}
          >
            {response.label}
          </button>
        ))}
      </div>
    </div>
  )
}
