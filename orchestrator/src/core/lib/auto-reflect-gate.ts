import { loadDaemonConfig } from '../daemon/config'

/** Whether automatic reflection follow-ons are disabled by the operator. */
export const isAutoReflectDisabled = (): boolean =>
  loadDaemonConfig().controlLevers.autoReflect === 'off'
