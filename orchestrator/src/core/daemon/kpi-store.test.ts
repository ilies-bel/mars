/**
 * Tests for the rescue-operator KPI counters in kpi-store.ts.
 *
 * Verifies that rescue_attempts_total and rescue_success_total advance under
 * the expected transitions:
 *   - incrementRescueAttempts → rescue_attempts_total goes up.
 *   - incrementRescueSuccess  → rescue_success_total goes up independently.
 *
 * Both counters are queryable via getRescueCounters.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../lib/libsql.js'
import { createTaskStore, type DomainTaskStore as TaskStore } from '../store/task-store.js'
import { getRescueCounters, incrementRescueAttempts, incrementRescueSuccess } from './kpi-store.js'

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

const makeStore = async (): Promise<TaskStore> => {
  // Each call gets a unique tmp dir → a fresh isolated in-memory PGlite instance
  // with the full schema auto-applied (including kpi_counters).
  const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-rescue-'))
  const client = openLibsql({ url: `file:${join(dir, 'queue.db')}` })
  return createTaskStore(client)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rescue KPI counters', () => {
  it('getRescueCounters returns zeros when no counter rows exist', async () => {
    const store = await makeStore()
    const counters = await getRescueCounters(store)
    expect(counters.rescue_attempts_total).toBe(0)
    expect(counters.rescue_success_total).toBe(0)
  })

  it('incrementRescueAttempts advances rescue_attempts_total, leaving rescue_success_total unchanged', async () => {
    const store = await makeStore()
    await incrementRescueAttempts(store)
    await incrementRescueAttempts(store)
    const counters = await getRescueCounters(store)
    expect(counters.rescue_attempts_total).toBe(2)
    expect(counters.rescue_success_total).toBe(0)
  })

  it('incrementRescueSuccess advances rescue_success_total independently of rescue_attempts_total', async () => {
    const store = await makeStore()
    await incrementRescueAttempts(store)
    await incrementRescueAttempts(store)
    await incrementRescueSuccess(store)
    const counters = await getRescueCounters(store)
    expect(counters.rescue_attempts_total).toBe(2)
    expect(counters.rescue_success_total).toBe(1)
  })
})
