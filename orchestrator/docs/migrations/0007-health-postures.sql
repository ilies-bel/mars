-- Migration 0007: health_postures
--
-- Stores the operator's posture setting per health check id.
-- A row is only present when the operator has explicitly changed the default.
-- Checks with no row default to 'automatic'.
--
-- posture values:
--   'automatic' — Mars acts on a finding immediately (enqueue fix, raise alert).
--   'manual'    — Finding surfaces as an offer; operator enacts it explicitly.
--   'off'       — Check runs but no route fires; other checks are unaffected.

CREATE TABLE IF NOT EXISTS health_postures (
  check_id  text PRIMARY KEY,
  posture   text NOT NULL CHECK (posture IN ('automatic', 'manual', 'off'))
);
