import type { TaskDb } from './db.ts'
import {
  listTerminalEvents as _listTerminalEvents,
  type TerminalEvent,
} from '../../orchestrator/src/core/lib/shared-terminal-events.ts'

export type { TerminalEvent } from '../../orchestrator/src/core/lib/shared-terminal-events.ts'

/**
 * Build the reverse-chronological feed of terminal-state task moments.
 * Delegates to the shared implementation; guards against a missing tasks
 * table (possible when the UI server starts before the daemon creates the DB).
 */
export const listTerminalEvents = async (db: TaskDb): Promise<TerminalEvent[]> => {
  const exists = await db.tableExists()
  if (!exists) return []
  return _listTerminalEvents(db)
}
