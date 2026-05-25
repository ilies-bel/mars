import type { SessionHandle } from './session.js';

const sessions = new Map<string, SessionHandle>();

/**
 * Store a newly created session handle in the in-memory registry.
 */
export function registerSession(session: SessionHandle): void {
  sessions.set(session.id, session);
}

/**
 * Retrieve a live session handle by id, or undefined if not found.
 */
export function getSession(id: string): SessionHandle | undefined {
  return sessions.get(id);
}

/**
 * Remove a session from the registry (call when the session is torn down).
 */
export function removeSession(id: string): void {
  sessions.delete(id);
}
