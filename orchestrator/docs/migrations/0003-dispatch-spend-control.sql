-- Migration 0003: dispatch spend controller levers
--
-- Adds a single-row operator-control table for the dispatch spend controller.
-- The row is seeded on first read by the store's loadSpendControl() function,
-- which inserts defaults when no row exists.
--
-- This DDL is executed idempotently by ensureSchema() in core/lib/pg-schema.ts.

CREATE TABLE IF NOT EXISTS dispatch_spend_control (
  id                   bigint      PRIMARY KEY CHECK (id = 1),
  per_kind_ceilings    jsonb,
  pause_threshold_pct  integer     NOT NULL DEFAULT 90,
  resume_threshold_pct integer     NOT NULL DEFAULT 70,
  suppress_recovery    boolean     NOT NULL DEFAULT false,
  ramp_back_step_pct   integer     NOT NULL DEFAULT 10,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Column semantics:
--   id                   Fixed to 1; enforces the single-row invariant.
--   per_kind_ceilings    JSONB object keyed by worker kind (e.g. {"coder": 4}).
--                        NULL means "ambient" (no per-kind override).
--   pause_threshold_pct  Stop dispatching new tasks when spend-rate % >= this.
--   resume_threshold_pct Resume dispatching when spend-rate % falls to this.
--   suppress_recovery    When true, no recovery / fix-tasks are spawned.
--   ramp_back_step_pct   Step size (%) for incrementally restoring concurrency
--                        after a pause clears.
--   updated_at           Stamped by upsertSpendControl().
