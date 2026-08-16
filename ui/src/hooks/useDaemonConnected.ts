import { useSseConnected } from '@/shared/sseStatus'

/**
 * Returns true when the UI has an active SSE connection to the Mars daemon,
 * false when the connection is absent or broken.
 *
 * Backed by the global SSE store maintained by SseInvalidator: the store
 * flips to true on the 'hello' event and to false on error/close.
 */
export const useDaemonConnected = (): boolean => useSseConnected()
