/**
 * Tests for the candidate-lesson store (record / list).
 *
 * Uses an in-memory PGlite backend (MARS_DB_BACKEND=pglite) and resets the
 * module singletons between tests so each test gets a fresh DB, mirroring
 * the pattern in learned-recipes.test.ts.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { __resetDbRegistryForTests } from '../db.js'

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

// The module under test resolves its DB target via `resolveStateClient()` →
// `resolveContext()`, which does `resolve(process.env.MARS_REPO)` and then
// `mkdirSync`s a `.mars` dir under it. A bare (non-absolute) key resolves
// relative to `process.cwd()` — inside a worktree, that cwd is itself nested
// under the real repo's `.mars/`, so a relative key trips the hermetic-repo
// guard in test/setup-env.ts. Use a real isolated tmpdir instead, matching
// the convention in learned-recipes.test.ts.
let currentRepoDir: string | undefined
const freshKey = (): string => {
  currentRepoDir = mkdtempSync(resolve(tmpdir(), `candidate-lessons-test-${process.pid}-`))
  return currentRepoDir
}

beforeEach(async () => {
  vi.resetModules()
  process.env.MARS_REPO = freshKey()
  const { openDb } = await import('../db.js')
  const { ensureSchema: applySchema } = await import('../pg-schema.js')
  const client = openDb(process.env.MARS_REPO)
  await applySchema(client)
})

afterEach(async () => {
  await __resetDbRegistryForTests()
  if (currentRepoDir) {
    rmSync(currentRepoDir, { recursive: true, force: true })
    currentRepoDir = undefined
  }
})

const loadModule = async () =>
  (await import('../candidate-lessons.js')) as typeof import('../candidate-lessons.js')

describe('candidate-lessons — record / list', () => {
  it('first insert creates a candidate lesson with observationCount 1', async () => {
    const m = await loadModule()
    const lesson = await m.recordCandidateLesson({
      fingerprint: 'root-cause:flaky-verify',
      title: 'Retry flaky verify step',
      body: 'Verify occasionally fails on a transient network blip.',
      arcId: 'arc-1',
    })
    expect(lesson.fingerprint).toBe('root-cause:flaky-verify')
    expect(lesson.observationCount).toBe(1)
    expect(lesson.arcIds).toEqual(['arc-1'])
    expect(lesson.firstSeenAt).toBe(lesson.lastSeenAt)

    const listed = await m.listCandidateLessons()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.fingerprint).toBe('root-cause:flaky-verify')
    expect(listed[0]!.observationCount).toBe(1)
  })

  it('a repeat observation from a new arc grows observationCount to 2', async () => {
    const m = await loadModule()
    await m.recordCandidateLesson({
      fingerprint: 'root-cause:flaky-verify',
      title: 'Retry flaky verify step',
      body: 'Verify occasionally fails on a transient network blip.',
      arcId: 'arc-1',
    })
    const lesson = await m.recordCandidateLesson({
      fingerprint: 'root-cause:flaky-verify',
      title: 'Retry flaky verify step',
      body: 'Verify occasionally fails on a transient network blip.',
      arcId: 'arc-2',
    })
    expect(lesson.observationCount).toBe(2)
    expect(lesson.arcIds).toEqual(['arc-1', 'arc-2'])

    const listed = await m.listCandidateLessons()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.observationCount).toBe(2)
  })

  it('a repeat observation from the same arc leaves observationCount unchanged', async () => {
    const m = await loadModule()
    await m.recordCandidateLesson({
      fingerprint: 'root-cause:flaky-verify',
      title: 'Retry flaky verify step',
      body: 'Verify occasionally fails on a transient network blip.',
      arcId: 'arc-1',
    })
    const lesson = await m.recordCandidateLesson({
      fingerprint: 'root-cause:flaky-verify',
      title: 'Retry flaky verify step',
      body: 'Verify occasionally fails on a transient network blip.',
      arcId: 'arc-1',
    })
    expect(lesson.observationCount).toBe(1)
    expect(lesson.arcIds).toEqual(['arc-1'])
  })

  it('listCandidateLessons orders rows by observationCount desc', async () => {
    const m = await loadModule()
    await m.recordCandidateLesson({
      fingerprint: 'root-cause:a',
      title: 'Lesson A',
      body: 'Body A',
      arcId: 'arc-1',
    })
    await m.recordCandidateLesson({
      fingerprint: 'root-cause:b',
      title: 'Lesson B',
      body: 'Body B',
      arcId: 'arc-1',
    })
    await m.recordCandidateLesson({
      fingerprint: 'root-cause:b',
      title: 'Lesson B',
      body: 'Body B',
      arcId: 'arc-2',
    })

    const listed = await m.listCandidateLessons()
    expect(listed.map((l) => l.fingerprint)).toEqual(['root-cause:b', 'root-cause:a'])
    expect(listed[0]!.observationCount).toBe(2)
    expect(listed[1]!.observationCount).toBe(1)
  })
})
