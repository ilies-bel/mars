import { describe, expect, it } from 'vitest'
import { buildSessionKey } from '../index'

/**
 * Regression tests for the per-invocation random session-key introduced in
 * df826e9b (2026-06-24) to prevent "Session ID <uuid> is already in use"
 * collisions under parallel or retried Mars recovery dispatches.
 *
 * These tests pin the two observable invariants that must hold for the fix to
 * be effective:
 *   1. The key carries the taskId so traces remain attributable.
 *   2. Repeated calls produce distinct keys so no two concurrent dispatches
 *      share a session identifier.
 */

describe('buildSessionKey', () => {
  it('prefixes the key with the taskId', () => {
    const taskId = 'mars-abc12345'
    const key = buildSessionKey(taskId)
    expect(key.startsWith(`${taskId}#`)).toBe(true)
  })

  it('appends an 8-character hex suffix after the separator', () => {
    const key = buildSessionKey('task-1')
    const suffix = key.split('#')[1]
    expect(suffix).toMatch(/^[0-9a-f]{8}$/)
  })

  it('generates a unique key on every call (no session-ID reuse)', () => {
    const taskId = 'task-collision-test'
    const keys = Array.from({ length: 20 }, () => buildSessionKey(taskId))
    const unique = new Set(keys)
    expect(unique.size).toBe(keys.length)
  })

  it('generates distinct keys for concurrent dispatches of different tasks', () => {
    const key1 = buildSessionKey('task-a')
    const key2 = buildSessionKey('task-b')
    expect(key1).not.toBe(key2)
  })
})
