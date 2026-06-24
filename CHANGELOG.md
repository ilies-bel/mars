# Changelog

All notable changes to Mars are documented here.

## [0.1.1] – 2026-06-24

### Fixed

**Recovery concurrency hardening** (df826e9b) — three interlocking fixes that
prevent `Error: Session ID <uuid> is already in use` crashes when the
orchestrator spawns multiple recovery tasks in parallel:

1. **Per-invocation random session key** (`primitives/index.ts`)
   `sessionKey` is now `${taskId}#${randomUUID().slice(0,8)}` instead of a
   deterministic key.  Every code-phase dispatch gets a fresh, unconditionally
   unique session ID so neither `mars continue` re-entries nor parallel
   recovery runs can collide on the same session ID while Claude's bookkeeping
   still holds the previous one.

2. **Verify-entry branch-contamination guard** (`primitives/index.ts`)
   The verify step now checks that the worktree HEAD is still on the expected
   task branch before running.  A crashed-then-restarted recovery that lands
   on the wrong branch is aborted cleanly instead of verifying (and merging)
   the wrong code.

3. **Restart-race guard** (`primitives/index.ts`)
   A guard prevents a recovery task from starting its code phase if a previous
   invocation of the same task is still alive, eliminating the window where
   two concurrent dispatches race to write the same worktree.

**Impact:** On 2026-06-24 a burst of five-plus parallel recoveries in the
gustave repo all exited with `coder exited 1` due to session-ID collisions,
leaving five parent tasks stranded in `blocked`/`failed`.  This release
closes that failure mode.

---

## [0.1.0] – initial release
