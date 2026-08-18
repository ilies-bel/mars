/**
 * DispatchPausedChip — global pause indicator for the Shell top bar.
 *
 * A paused queue invalidates every other number on screen: "0 in progress",
 * "0 running", an empty board and an idle-looking chat card all have one cause,
 * and without this chip the only page that says so is Control Room — the page
 * you open *after* you already suspect something is wrong.
 *
 * Renders nothing when dispatch is running, so the bar costs no vertical space
 * in the normal case. That is the trade that justifies putting it in the shell
 * rather than repeating a banner per page.
 */

import { useDispatchState, pauseReasonLabel } from '@/entities/operator/useDispatchState'

export const DispatchPausedChip = () => {
  const dispatch = useDispatchState()

  if (!dispatch.paused) return null

  const reason = pauseReasonLabel(dispatch)

  return (
    <a
      href="#/control"
      data-testid="dispatch-paused-chip"
      aria-label={`Dispatch is paused (${reason}) — no new work is being dispatched. Open Control Room to resume.`}
      title={dispatch.detail ?? undefined}
      className="shrink-0 rounded-full px-2 py-0.5 font-mono text-micro leading-none transition-colors hover:opacity-80"
      style={{
        background: 'rgba(239, 68, 68, 0.15)',
        color: 'var(--color-red, #ef4444)',
      }}
    >
      ⏸&nbsp;paused · {reason}
    </a>
  )
}
