/**
 * @mars/claude-session
 *
 * Standalone library for programmatically controlling interactive Claude sessions.
 */

export const VERSION = '0.1.0';

export type { SessionHandle } from './session.js';
export type { StartOptions } from './start.js';
export { start } from './start.js';
export { getSession, removeSession } from './registry.js';
