/**
 * openSubject — behaviour tests.
 *
 * Tests verify observable outcomes through the public interface only:
 * - A Subject cannot open without a non-empty objective.
 * - A Subject cannot open without a non-empty terminal_condition.
 * - A successful call inserts exactly one row with the supplied objective.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  ensureQueueSchema: typeof import('../queue').ensureQueueSchema
}

interface OpenSubjectModule {
  openSubject: typeof import('./openSubject').openSubject
  SubjectInputError: typeof import('./openSubject').SubjectInputError
}

interface ChatStoreModule {
  listThreads: typeof import('../lib/chat-store').listThreads
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-open-subject-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ subject: OpenSubjectModule; chat: ChatStoreModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  // Apply the canonical schema before any createThread / listThreads call.
  // withTransaction bypasses the lazy ensureClientSchema guard in client.execute,
  // so explicit schema initialisation is required (same pattern as
  // subthread-closer.test.ts and gate-fix-steward.test.ts).
  const queue = (await import('../queue')) as unknown as QueueModule
  await queue.ensureQueueSchema()
  const [subject, chat] = await Promise.all([
    import('./openSubject') as Promise<unknown>,
    import('../lib/chat-store') as Promise<unknown>,
  ])
  return {
    subject: subject as OpenSubjectModule,
    chat: chat as ChatStoreModule,
  }
}

describe('openSubject', () => {
  let repo: string

  afterEach(() => {
    delete process.env.MARS_REPO
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('throws SubjectInputError and inserts no row when objective is empty', async () => {
    repo = setupRepo()
    const { subject, chat } = await loadModules(repo)

    await expect(
      subject.openSubject({ objective: '', terminal_condition: 'All tests pass' }),
    ).rejects.toBeInstanceOf(subject.SubjectInputError)

    // No Subject row was written to the database (the schema seeds 'main' which is not a Subject).
    const threads = await chat.listThreads()
    const subjects = threads.filter((t) => t.id !== 'main')
    expect(subjects).toHaveLength(0)
  })

  it('throws SubjectInputError when objective is only whitespace', async () => {
    repo = setupRepo()
    const { subject } = await loadModules(repo)

    await expect(
      subject.openSubject({ objective: '   ', terminal_condition: 'Done when green' }),
    ).rejects.toBeInstanceOf(subject.SubjectInputError)
  })

  it('throws SubjectInputError and inserts no row when terminal_condition is empty', async () => {
    repo = setupRepo()
    const { subject, chat } = await loadModules(repo)

    await expect(
      subject.openSubject({ objective: 'Fix the failing tests', terminal_condition: '' }),
    ).rejects.toBeInstanceOf(subject.SubjectInputError)

    const threads = await chat.listThreads()
    const subjects = threads.filter((t) => t.id !== 'main')
    expect(subjects).toHaveLength(0)
  })

  it('throws SubjectInputError when terminal_condition is only whitespace', async () => {
    repo = setupRepo()
    const { subject } = await loadModules(repo)

    await expect(
      subject.openSubject({ objective: 'Fix the failing tests', terminal_condition: '   ' }),
    ).rejects.toBeInstanceOf(subject.SubjectInputError)
  })

  it('creates a Subject row with the objective when both fields are non-empty', async () => {
    repo = setupRepo()
    const { subject, chat } = await loadModules(repo)

    const thread = await subject.openSubject({
      objective: 'Fix the failing tests',
      terminal_condition: 'All tests pass in CI',
    })

    expect(thread.id).toBeTruthy()
    expect(thread.objective).toBe('Fix the failing tests')

    // Exactly one Subject row (excluding the 'main' sentinel seeded by the schema).
    const threads = await chat.listThreads()
    const subjects = threads.filter((t) => t.id !== 'main')
    expect(subjects).toHaveLength(1)
    expect(subjects[0].objective).toBe('Fix the failing tests')
  })

  it('the thrown error identifies the failing field', async () => {
    repo = setupRepo()
    const { subject } = await loadModules(repo)

    let error: unknown
    try {
      await subject.openSubject({ objective: '', terminal_condition: 'Done' })
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(subject.SubjectInputError)
    expect((error as InstanceType<typeof subject.SubjectInputError>).field).toBe('objective')
  })
})
