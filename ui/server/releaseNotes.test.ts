import { describe, expect, it } from 'bun:test'
import {
  buildReleaseNotes,
  RELEASE_NOTES_LIMIT,
  type TaskForReleaseNotes,
} from './releaseNotes.ts'

const makeTask = (
  overrides: Partial<TaskForReleaseNotes> & { id: string },
): TaskForReleaseNotes => ({
  prompt: `prompt for ${overrides.id}`,
  status: 'done',
  updatedAt: '2026-01-01T00:00:00.000Z',
  originId: overrides.id,
  fixForTaskId: null,
  kind: 'task',
  intent: null,
  spec: null,
  ...overrides,
})

describe('buildReleaseNotes', () => {
  it('single-task arc produces one entry', () => {
    const tasks = [
      makeTask({
        id: 'task-1',
        intent: 'Ship the feature',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('task-1')
    expect(entries[0]!.title).toBe('Ship the feature')
    expect(entries[0]!.landedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(entries[0]!.detail.recoveryCount).toBe(0)
    expect(entries[0]!.detail.prompt).toBe('prompt for task-1')
    expect(entries[0]!.detail.spec).toBeNull()
  })

  it('arc with origin + 2 recovery tasks collapses to one entry, recoveryCount=2, landedAt=latest', () => {
    const tasks = [
      makeTask({
        id: 'origin-1',
        originId: 'origin-1',
        intent: 'Big feature',
        updatedAt: '2026-05-01T10:00:00.000Z',
      }),
      makeTask({
        id: 'fix-1',
        originId: 'origin-1',
        fixForTaskId: 'origin-1',
        kind: 'fix',
        updatedAt: '2026-05-01T11:00:00.000Z',
      }),
      makeTask({
        id: 'fix-2',
        originId: 'origin-1',
        fixForTaskId: 'origin-1',
        kind: 'fix',
        updatedAt: '2026-05-01T12:00:00.000Z',
      }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('origin-1')
    expect(entries[0]!.title).toBe('Big feature')
    expect(entries[0]!.detail.recoveryCount).toBe(2)
    expect(entries[0]!.landedAt).toBe('2026-05-01T12:00:00.000Z')
  })

  it('title falls back to first sentence of prompt when intent is null', () => {
    const tasks = [
      makeTask({
        id: 'task-2',
        intent: null,
        prompt: 'Add a button to the UI. This is more detail.',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries[0]!.title).toBe('Add a button to the UI.')
  })

  it('title falls back to first sentence of prompt when intent is empty string', () => {
    const tasks = [
      makeTask({
        id: 'task-3',
        intent: '',
        prompt: 'Fix the bug! More context here.',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries[0]!.title).toBe('Fix the bug!')
  })

  it('entries are sorted reverse-chronological by landedAt', () => {
    const tasks = [
      makeTask({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'new', updatedAt: '2026-06-01T00:00:00.000Z' }),
      makeTask({ id: 'mid', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries.map((e) => e.originId)).toEqual(['new', 'mid', 'old'])
    // Timestamps are monotonically non-increasing.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1]!.landedAt >= entries[i]!.landedAt).toBe(true)
    }
  })

  it('only includes done tasks', () => {
    const tasks = [
      makeTask({ id: 'done-1', status: 'done' }),
      { ...makeTask({ id: 'queued-1' }), status: 'queued' },
      { ...makeTask({ id: 'failed-1' }), status: 'failed' },
      { ...makeTask({ id: 'running-1' }), status: 'running' },
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('done-1')
  })

  it('caps the response at RELEASE_NOTES_LIMIT entries', () => {
    const tasks = Array.from({ length: RELEASE_NOTES_LIMIT + 50 }, (_, i) =>
      makeTask({
        id: `task-${String(i).padStart(4, '0')}`,
        updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.${String(i).padStart(3, '0')}Z`,
      }),
    )
    const entries = buildReleaseNotes(tasks)
    expect(entries.length).toBe(RELEASE_NOTES_LIMIT)
  })

  it('detail includes spec when present', () => {
    const spec = {
      files: ['src/foo.ts'],
      verifyCmd: 'npm test',
      doneCriteria: ['all tests pass'],
      taskType: 'auto',
    }
    const tasks = [makeTask({ id: 'task-spec', spec })]
    const entries = buildReleaseNotes(tasks)
    expect(entries[0]!.detail.spec).toEqual(spec)
  })

  it('returns empty array when no tasks are done', () => {
    const tasks = [
      { ...makeTask({ id: 'q1' }), status: 'queued' },
      { ...makeTask({ id: 'r1' }), status: 'running' },
    ]
    expect(buildReleaseNotes(tasks)).toEqual([])
  })

  it('excludes arc when origin is failed (not done) and only a recovery task has landed', () => {
    // The origin task is NOT in the done-set (it is failed/running).
    // Only the recovery committer task is done. The arc must not appear.
    const tasks = [
      makeTask({
        id: 'fix-93407679',
        originId: 'mars-a18a627c',
        fixForTaskId: 'mars-a18a627c',
        kind: 'fix',
        prompt: '# Main committer You are a focused recovery agent.',
        intent: null,
        updatedAt: '2026-05-01T12:00:00.000Z',
        status: 'done',
      }),
      // origin mars-a18a627c is failed — intentionally absent from done-set
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries).toHaveLength(0)
  })

  it('includes a normal arc with a done origin and reports the correct recoveryCount', () => {
    const tasks = [
      makeTask({
        id: 'arc-abc',
        originId: 'arc-abc',
        intent: 'Add dark mode',
        updatedAt: '2026-05-10T00:00:00.000Z',
      }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('arc-abc')
    expect(entries[0]!.title).toBe('Add dark mode')
    expect(entries[0]!.detail.recoveryCount).toBe(0)
  })

  it('folds a done recovery into the origin entry, titled by the origin', () => {
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
        intent: null,
        updatedAt: '2026-05-10T09:00:00.000Z',
      }),
    ]
    const entries = buildReleaseNotes(tasks)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.originId).toBe('arc-xyz')
    expect(entries[0]!.title).toBe('Refactor auth')
    expect(entries[0]!.detail.recoveryCount).toBe(1)
    expect(entries[0]!.landedAt).toBe('2026-05-10T09:00:00.000Z')
  })
})
