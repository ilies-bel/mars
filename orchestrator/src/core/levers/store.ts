/**
 * Lever store: typed wrappers around the file-backed lever config, plus the
 * Card record type and its guarded factory.
 *
 * A Card carries the autonomy level of the lever that produced it together
 * with a `producer_key` that identifies that lever. The operator can silence
 * a lever from the Card itself; once muted, subsequent calls to `createCard`
 * with the same `producer_key` return `null` — no Card is raised.
 */

import { randomUUID } from 'node:crypto'
import {
  readLeverAutonomyLevel,
  persistLeverAutonomyLevel,
  AUTONOMY_LEVELS,
  type AutonomyLevel,
} from '../daemon/config.js'

export type { AutonomyLevel }
export { AUTONOMY_LEVELS }

// ── Producer key registry ─────────────────────────────────────────────────────

/**
 * Specification for a card-producer lever.
 *
 * Only keys listed here can be set via `mars daemon set-lever`. The default
 * autonomy level is `'ask'` unless an entry overrides it.
 */
export interface ProducerLeverSpec {
  /** The producer key used as `producer_key` on Card rows and in daemon.json. */
  key: string
  /**
   * The autonomy level applied when no explicit value has been persisted.
   * Matches the value returned by `getLever(key)` on a fresh installation.
   */
  defaultAutonomyLevel: AutonomyLevel
}

/**
 * Registry of every known card-producer key.
 *
 * Extend this array when a new subscriber is capable of raising Cards.
 * `mars daemon set-lever` validates against this list and rejects unknown keys.
 */
export const PRODUCER_LEVER_SPECS: readonly ProducerLeverSpec[] = [
  { key: 'terminal-matcher', defaultAutonomyLevel: 'ask' },
] as const

/** Ordered list of known producer keys, derived from PRODUCER_LEVER_SPECS. */
export const KNOWN_PRODUCER_KEYS: readonly string[] = PRODUCER_LEVER_SPECS.map((s) => s.key)

// ── Card type ────────────────────────────────────────────────────────────────

/**
 * A Card is the only surface through which a Subject opens or closes.
 * It travels with the autonomy level of the lever that produced it and the key
 * of that lever so the operator can silence the source from the message itself.
 */
export interface Card {
  id: string
  /** Autonomy level of the lever that produced this Card. */
  autonomy_level: AutonomyLevel
  /** Key of the lever that produced this Card; used to silence the source. */
  producer_key: string
  body: string
  created_at: number
}

// ── Lever operations ─────────────────────────────────────────────────────────

/**
 * Return the current autonomy level for `key`.
 * Defaults to `'ask'` when no value has been persisted (see `readLeverAutonomyLevel`).
 */
export const getLever = (key: string): AutonomyLevel => readLeverAutonomyLevel(key)

/**
 * Persist `level` for `key` in daemon.json.
 * Setting `'off'` mutes the lever: subsequent `createCard` calls for the same
 * key return `null`.
 */
export const setLever = (key: string, level: AutonomyLevel): void =>
  persistLeverAutonomyLevel(key, level)

// ── Card factory ─────────────────────────────────────────────────────────────

/**
 * Create a Card if the `producer_key` lever is not muted.
 *
 * Returns the Card when `getLever(producer_key) !== 'off'`, or `null` when
 * the lever has been set to `'off'` (silenced). Callers that receive a
 * non-null Card are responsible for persisting it to the database.
 */
export const createCard = (params: {
  producer_key: string
  autonomy_level: AutonomyLevel
  body: string
}): Card | null => {
  if (getLever(params.producer_key) === 'off') return null
  return {
    id: randomUUID(),
    autonomy_level: params.autonomy_level,
    producer_key: params.producer_key,
    body: params.body,
    created_at: Date.now(),
  }
}
