/**
 * Process-level file-lock primitive.
 *
 * This module is the canonical import path for `acquireLock`. It re-exports
 * from `./git/lock` while the consumer slice "Relocate acquireLock from
 * lib/git/lock to lib/lock" is pending; that slice will replace this barrel
 * with the moved implementation and update `./git/lock` in turn.
 *
 * Callers must import from here, not from `./git/lock`, so that the
 * relocation only touches one file.
 */
export { acquireLock } from './git/lock'
