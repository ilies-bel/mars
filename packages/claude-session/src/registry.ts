import type { SessionHandle } from './session.js';

const sessions = new Map<string, SessionHandle>();

/**
 * Store a newly created session handle in the in-memory registry.
 * Throws if a live session with the same id is already registered.
 *
 * Module-private — callers outside this file should use the pre-checked
 * path in `start()` which calls `addSession()` after its own guard.
 */
function registerSession(session: SessionHandle): void {
  if (sessions.has(session.id)) {
    throw new Error(`registerSession: duplicate id "${session.id}" (caller should check getSession first)`);
  }
  sessions.set(session.id, session);
}

/**
 * Insert a session handle into the registry without a duplicate check.
 * The caller is responsible for ensuring no collision (see `start()`).
 */
export function addSession(session: SessionHandle): void {
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

/**
 * Return all currently live session handles as an array.
 * Sessions that have exited are not included (they are removed on exit).
 */
export function listSessions(): SessionHandle[] {
  return Array.from(sessions.values());
}
