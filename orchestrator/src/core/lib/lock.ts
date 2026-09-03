/**
 * lib/lock.ts — file-lock primitives at the lib/ level.
 *
 * The implementation lives in `./git/lock`; this module re-exports it so
 * callers can import from `lib/lock` without a `git/` path dependency.
 * The "Relocate acquireLock from lib/git/lock to lib/lock" slice will move
 * the implementation here and update `lib/git/lock` to re-export from `../lock`.
 */
export { acquireLock } from './git/lock'
