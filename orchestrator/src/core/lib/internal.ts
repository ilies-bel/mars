/**
 * Non-git exec utilities and PATH helpers.
 *
 * This module is the canonical import path for `exec`, `execProbe`, and the
 * PATH-resolution utilities. It re-exports from `./git/internal` while the
 * consumer slice "Relocate exec, execProbe, and PATH utilities from
 * lib/git/internal" is pending; that slice will replace this barrel with the
 * moved implementations and update `./git/internal` in turn.
 *
 * Callers must import from here, not from `./git/internal`, so that the
 * relocation only touches one file.
 */
export { execProbe } from './git/internal'
