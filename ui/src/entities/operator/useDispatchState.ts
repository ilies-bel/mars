import { useQuery } from '@tanstack/react-query'
import { fetchOperatorState, type DispatchPauseState, type OperatorState } from '@/shared/api'

/**
 * Human-readable label for why dispatch is paused.
 *
 * Kept short enough to sit in a status chip. The full `detail` string (a storm
 * signature, a quota message) stays on Control Room, which has room for it.
 */
export const pauseReasonLabel = (state: DispatchPauseState): string => {
  switch (state.reason) {
    case 'storm':
      return 'signature storm'
    case 'quota':
      return 'provider quota'
    case 'baseline':
      return 'broken baseline'
    case 'operator':
      return 'paused by you'
    default:
      return 'paused'
  }
}

const NOT_PAUSED: DispatchPauseState = {
  paused: false,
  reason: null,
  since: null,
  detail: null,
}

/**
 * Dispatch pause state, shared by every surface that shows system health.
 *
 * A paused queue invalidates the rest of the screen — every "0 in progress" and
 * every idle-looking counter is explained by it — so this must be readable from
 * anywhere, not just Control Room.
 *
 * Failure degrades to "not paused" rather than propagating: the health dot is
 * ambient chrome, and blanking it on a transient fetch error would be a worse
 * lie than briefly omitting the pause.
 */
export const useDispatchState = (): DispatchPauseState => {
  const { data } = useQuery<OperatorState>({
    queryKey: ['operator-state'],
    queryFn: fetchOperatorState,
    refetchInterval: 5_000,
  })
  return data?.dispatch ?? NOT_PAUSED
}
