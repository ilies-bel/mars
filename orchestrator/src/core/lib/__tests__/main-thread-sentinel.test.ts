/**
 * The main thread sentinel: one well-known `chat_threads` row, seeded by the
 * DDL, that exists so a Notice always has somewhere to land. It is not a
 * Subject, so every Subject-shaped reader must skip it — while the one
 * conversation feed must not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { MAIN_THREAD_ID } from '../pg-schema.js'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-main-thread-sentinel-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadStore = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../chat-store')
  const { resolveStateClient } = await import('../../store/state-client')
  await chat.initChatStore()
  return { chat, db: resolveStateClient() }
}

describe('main thread sentinel', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('is seeded by the schema with the well-known shape', async () => {
    const { chat, db } = await loadStore(repo)

    const rows = await db.execute(
      `SELECT id, title, origin, status, closed_at, archived_at FROM chat_threads WHERE id = 'main'`,
    )
    expect(rows.rows).toEqual([{
      id: MAIN_THREAD_ID,
      title: 'Main thread',
      origin: 'main',
      status: 'idle',
      closed_at: null,
      archived_at: null,
    }])
  })

  it('survives the DDL replaying on every boot, keeping its history', async () => {
    const { chat, db } = await loadStore(repo)
    await chat.appendMessage(MAIN_THREAD_ID, 'assistant', 'Nothing on my side.', undefined, {
      kind: 'notice',
    })

    await chat.initChatStore()
    await chat.initChatStore()

    expect((await db.execute(`SELECT count(*) AS n FROM chat_threads WHERE id = 'main'`)).rows)
      .toEqual([{ n: 1 }])
    expect((await chat.getThread(MAIN_THREAD_ID))?.messages).toHaveLength(1)
  })

  it('reopens if something closed it: it is the delivery target of last resort', async () => {
    const { chat, db } = await loadStore(repo)
    await db.execute(`UPDATE chat_threads SET closed_at = 42 WHERE id = 'main'`)

    await chat.initChatStore()

    expect((await chat.getThread(MAIN_THREAD_ID))?.thread.closed_at).toBeNull()
    expect(await chat.listClosedSubjects()).toEqual([])
  })

  it('is not a Subject: listThreads never returns it', async () => {
    const { chat } = await loadStore(repo)
    expect(await chat.listThreads()).toEqual([])

    const subthread = await chat.createThread('A real Subject')
    expect((await chat.listThreads()).map((thread) => thread.id)).toEqual([subthread.id])
  })

  it('draws no Subthread boundary in the conversation', async () => {
    const { chat } = await loadStore(repo)
    await chat.appendMessage(MAIN_THREAD_ID, 'assistant', 'Nothing on my side.', undefined, {
      kind: 'notice',
    })
    expect(await chat.listSubjectBoundaries()).toEqual([])

    const subthread = await chat.createThread('A real Subject')
    expect((await chat.listSubjectBoundaries()).map((boundary: import('../chat-store').SubjectBoundaryApiView) => boundary.subjectId))
      .toEqual([subthread.id])
  })

  it('but its messages DO appear in the conversation feed', async () => {
    const { chat } = await loadStore(repo)
    await chat.appendMessage(MAIN_THREAD_ID, 'assistant', 'Nothing on my side.', undefined, {
      kind: 'notice',
    })

    expect(await chat.listConversationEntries()).toEqual([
      expect.objectContaining({
        subjectId: MAIN_THREAD_ID,
        subjectTitle: 'Main thread',
        subjectClosed: false,
        content: 'Nothing on my side.',
        kind: 'notice',
      }),
    ])
  })
})
