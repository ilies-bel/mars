/**
 * Unit tests for listReleaseNotes covering the arc-exclusion rule:
 *
 *   - An arc whose origin task has NOT landed (not in the done-set) must be
 *     excluded from the feed even when a recovery task for that arc is done.
 *   - A normal arc with a done origin appears with the correct title and
 *     recoveryCount.
 *   - When both origin and recovery are done, the entry is titled by the
 *     origin and the recovery is folded in (recoveryCount incremented).
 *
 * Tests exercise observable behaviour through the public interface only:
 * the ReleaseNoteEntry[] returned by listReleaseNotes.
 */

import { describe, expect, it } from 'vitest'
import {
  listReleaseNotes,
  type TaskStoreForReleaseNotes,
} from '../release-notes.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

type RawTask = Awaited<ReturnType<TaskStoreForReleaseNotes['listTasks']>>[number]

const makeTask = (overrides: Partial<RawTask> & { id: string }): RawTask => ({
  prompt: `prompt for ${overrides.id}`,
  status: 'done',
  updatedAt: '2026-01-01T00:00:00.000Z',
  originId: overrides.id,
  fixForTaskId: null,
  kind: 'task',
  intent: '',
  spec: null,
  ...overrides,
})

const makeStore = (tasks: RawTask[]): TaskStoreForReleaseNotes => ({
  listTasks: async () => tasks,
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('listReleaseNotes', () => {
  it('excludes arc when origin is not done and only a recovery task has landed', async () => {
    // Mirrors the real failure case: origin mars-a18a627c is failed (absent
    // from done-set); only the committer/recovery fix-93407679 is done.
    const tasks = [
      makeTask({
        id: 'fix-93407679',
        originId: 'mars-a18a627c',
        fixForTaskId: 'mars-a18a627c',
        kind: 'fix',
        prompt: '# Main committer You are a focused recovery agent.',
        intent: '',
        updatedAt: '2026-05-01T12:00:00.000Z',
        status: 'done',
      }),
      // origin mars-a18a627c has status 'failed' — intentionally absent from done-set
    ]
    const entries = await listReleaseNotes(makeStore(tasks))
    expect(entries).toHaveLength(0)
  })

  it('includes a normal arc with a done origin and correct recoveryCount', async () => {
    const tasks = [
      makeTask({
        id: 'arc-abc',
        originId: 'arc-abc',
        intent: 'Add dark mode',
        updatedAt: '2026-05-10T00:00:00.000Z',
      }),
    ]
    const entries = await listReleaseNotes(makeStore(tasks))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('arc-abc')
    expect(entries[0]!.title).toBe('Add dark mode')
    expect(entries[0]!.detail.recoveryCount).toBe(0)
    expect(entries[0]!.landedAt).toBe('2026-05-10T00:00:00.000Z')
  })

  it('folds a done recovery into the origin entry, titled by the origin', async () => {
    const tasks = [
      makeTask({
        id: 'arc-xyz',
        originId: 'arc-xyz',
        intent: 'Refactor auth',
        updatedAt: '2026-05-10T08:00:00.000Z',
      }),
      makeTask({
        id: 'fix-xyz',
        originId: 'arc-xyz',
        fixForTaskId: 'arc-xyz',
        kind: 'fix',
        prompt: '# Main committer You are a focused recovery agent.',
        intent: '',
        updatedAt: '2026-05-10T09:00:00.000Z',
      }),
    ]
    const entries = await listReleaseNotes(makeStore(tasks))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('arc-xyz')
    expect(entries[0]!.title).toBe('Refactor auth')
    expect(entries[0]!.detail.recoveryCount).toBe(1)
    expect(entries[0]!.landedAt).toBe('2026-05-10T09:00:00.000Z')
    expect(entries[0]!.detail.prompt).toBe('prompt for arc-xyz')
  })

  it('entries are sorted reverse-chronological by landedAt', async () => {
    const tasks = [
      makeTask({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'new', updatedAt: '2026-06-01T00:00:00.000Z' }),
      makeTask({ id: 'mid', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]
    const entries = await listReleaseNotes(makeStore(tasks))
    expect(entries.map((e) => e.originId)).toEqual(['new', 'mid', 'old'])
  })

  it('only includes done tasks', async () => {
    const tasks = [
      makeTask({ id: 'done-1', status: 'done' }),
      makeTask({ id: 'queued-1', status: 'queued' }),
      makeTask({ id: 'failed-1', status: 'failed' }),
    ]
    const entries = await listReleaseNotes(makeStore(tasks))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('done-1')
  })

  it('returns empty array when no tasks are done', async () => {
    const tasks = [
      makeTask({ id: 'q1', status: 'queued' }),
      makeTask({ id: 'r1', status: 'running' }),
    ]
    const entries = await listReleaseNotes(makeStore(tasks))
    expect(entries).toEqual([])
  })
})
