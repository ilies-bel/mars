# Probe — mars-2f13d8de

**Task type:** `implement`
**Branch:** `task/mars-2f13d8de`
**Date:** 2026-05-17

## Purpose

Synthetic probe of the orchestrator's `implement` pipeline. This task
carries no feature spec; it exists to exercise the full path:

`setup` (worktree on `task/mars-2f13d8de` off `main`)
→ `code` (this agent run)
→ `verify` (must see a real, committed diff)
→ `merge` (fast-forward into `main` under the merge lock).

## Outcome

- Worktree created and clean on entry.
- A committed diff is present (this file), so `verify` will not reject
  with `verify:has-diff/no-commits-ahead`.
- No production code, glossary, or ADRs were touched.

This marker is the entire footprint of the probe and is safe to purge.
