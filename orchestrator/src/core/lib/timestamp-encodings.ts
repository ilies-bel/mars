/**
 * Timestamp encodings for the canonical tables that test fixtures seed
 * directly. Keep this small registry beside the database seam so a fixture
 * cannot accidentally choose its own representation.
 */
export const FIXTURE_TIMESTAMP_ENCODINGS = {
  tasks: {
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
  },
  task_blockers: {
    created_at: 'epoch-millis',
  },
  action_queue_items: {
    raised_at: 'epoch-millis',
    resolved_at: 'epoch-millis',
    last_seen_at: 'epoch-millis',
    snoozed_until: 'epoch-millis',
  },
  self_heal_attempts: {
    created_at: 'epoch-millis',
  },
} as const

export type FixtureTimestampEncoding =
  (typeof FIXTURE_TIMESTAMP_ENCODINGS)[keyof typeof FIXTURE_TIMESTAMP_ENCODINGS][keyof (typeof FIXTURE_TIMESTAMP_ENCODINGS)[keyof typeof FIXTURE_TIMESTAMP_ENCODINGS]]
