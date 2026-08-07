import { loadDaemonConfig } from '../daemon/config'

/**
 * Whether the memory-capture lever is disabled by the operator.
 *
 * When true, reflection suggestions are still saved as proposals but NOT
 * inserted into the memory store (insertMemoryPacket is skipped). Has no
 * bearing on whether reflection runs at all — only on post-reflection
 * memory-packet insertion.
 *
 * Reads `controlLevers.memoryCapture` from daemon.json on every call.
 */
export const isMemoryCaptureDisabled = (): boolean =>
  loadDaemonConfig().controlLevers.memoryCapture === 'off'
