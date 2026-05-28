/**
 * @mars/claude-session
 *
 * Standalone library for programmatically controlling interactive Claude sessions.
 */

export const VERSION = '0.1.0';

export type { SessionHandle } from './session.js';
export type { StartOptions } from './start.js';
export { start } from './start.js';
export { getSession, removeSession, listSessions } from './registry.js';
export { READINESS_MARKER } from './readiness.js';
