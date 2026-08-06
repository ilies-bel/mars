import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { renderContextLine } from '../context-line.js'
import { MAIN_THREAD_ID } from '../pg-schema.js'

describe('renderContextLine', () => {
  it('names the Subject and what it produced', () => {
    expect(renderContextLine({
      title: 'Rework the merge gate',
      taskIds: ['mars-1', 'mars-2'],
      resolvedAlert: false,
    })).toBe('Closed "Rework the merge gate" — queued 2 tasks.')
  })

  it('counts a single task in the singular', () => {
    expect(renderContextLine({ title: 'Fix verify', taskIds: ['mars-1'], resolvedAlert: false }))
      .toBe('Closed "Fix verify" — queued 1 task.')
  })

  it('says so plainly when a Subject produced nothing', () => {
    expect(renderContextLine({ title: 'Think about caching', taskIds: [], resolvedAlert: false }))
      .toBe('Closed "Think about caching" — queued nothing.')
  })

  it('reports both outcomes when an alert Subject also queued work', () => {
    expect(renderContextLine({ title: 'Triage', taskIds: ['mars-1'], resolvedAlert: true }))
      .toBe('Closed "Triage" — queued 1 task and resolved the alert.')
  })

  it('reports a resolved alert on its own', () => {
    expect(renderContextLine({ title: 'Triage', taskIds: [], resolvedAlert: true }))
      .toBe('Closed "Triage" — resolved the alert.')
  })
})

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-context-line-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadStore = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../chat-store')
  const { resolveStateClient } = await import('../../store/state-client.js')
  const { withTransaction } = await import('../db.js')
  const { closeAndArchive } = await import('../../subject/closeAndArchive.js')
  await chat.initChatStore()
  return { chat, db: resolveStateClient(), withTransaction, closeAndArchive }
}

describe('closing a Subject via closeAndArchive', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('folds the Subject outcome back into the main thread', async () => {
    const { chat, db, withTransaction, closeAndArchive } = await loadStore(repo)
    const subject = await chat.createThread('Rework the merge gate')
    await chat.appendMessage(subject.id, 'assistant', 'Queued it.', [
      { type: 'text', text: 'Queued it.' },
      { type: 'task_ref', taskId: 'mars-1' },
    ])

    await withTransaction(db, (tx) => closeAndArchive(subject.id, tx))

    const feed = await chat.listConversationEntries()
    expect(feed.map((entry) => entry.content)).toContain(
      'Closed "Rework the merge gate" — queued 1 task.',
    )
    const line = feed.find((entry) => entry.content.startsWith('Closed '))
    expect(line).toMatchObject({ subjectId: MAIN_THREAD_ID, kind: 'context_line' })
  })
})
