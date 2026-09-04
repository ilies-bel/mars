/**
 * Re-export shim. The canonical implementation lives in ../lock.ts.
 * This file exists so that lib/git/worktree-lease.ts (which imports
 * isPidAlive from './lock') and any tests that mock this path continue
 * to resolve correctly without modification.
 */
export { isPidAlive, acquireLock } from '../lock'
