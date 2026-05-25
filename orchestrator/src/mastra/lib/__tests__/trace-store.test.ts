import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { describe, expect, it } from 'vitest'

import { openTraceEventStore } from '../trace-store'

const tmpStorePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-trace-store-'))
  return join(dir, 'mars-trace.duckdb')
}

describe('openTraceEventStore', () => {
  it('creates the store file on first open', async () => {
    const path = tmpStorePath()
    const store = await openTraceEventStore(path)
    try {
      expect(existsSync(path)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('accepts a lifecycle event tagged with timestamp, origin id, owner id and event name', async () => {
    const path = tmpStorePath()
    const store = await openTraceEventStore(path)
    try {
      await store.record({
        timestamp: new Date('2026-05-25T12:00:00.000Z'),
        originId: 'idea-abc',
        ownerKind: 'task',
        ownerId: 'task-42',
        eventName: 'task_dispatched',
      })
    } finally {
      store.close()
    }

    // Re-open read-only to confirm the event persisted with every field.
    const instance = await DuckDBInstance.create(path, {
      access_mode: 'read_only',
    })
    try {
      const connection = await instance.connect()
      try {
        const reader = await connection.runAndReadAll(
          'SELECT origin_id, owner_kind, owner_id, event_name FROM mars_trace_events',
        )
        expect(reader.getRowObjectsJS()).toEqual([
          {
            origin_id: 'idea-abc',
            owner_kind: 'task',
            owner_id: 'task-42',
            event_name: 'task_dispatched',
          },
        ])
      } finally {
        connection.closeSync()
      }
    } finally {
      instance.closeSync()
    }
  })
})
