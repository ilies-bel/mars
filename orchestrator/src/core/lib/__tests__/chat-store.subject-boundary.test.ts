/**
 * Subject-boundary session isolation tests (slice 6 of PRD 76347e15).
 *
 * Each new chat thread must carry its own session_id so agent context does
 * not bleed across Subjects. No UI knob — the operator sees one continuous
 * scroll while each thread gets a fresh, invisible session boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ChatStoreModule {
  createThread: typeof import('../chat-store').createThread
  getThreadSession: typeof import('../chat-store').getThreadSession
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-subject-boundary-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('../chat-store')) as unknown as ChatStoreModule
}

describe('chat-store subject-boundary session isolation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('createThread stamps a non-empty session_id on the new thread row', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('first subject')
    expect(thread.session_id).toBeTruthy()
    expect(typeof thread.session_id).toBe('string')
  })

  it('two threads created in sequence carry distinct session ids', async () => {
    const m = await loadModule(repo)
    const a = await m.createThread('subject A')
    const b = await m.createThread('subject B')
    expect(a.session_id).toBeTruthy()
    expect(b.session_id).toBeTruthy()
    expect(a.session_id).not.toBe(b.session_id)
  })

  it('getThreadSession returns the same session_id that was stamped at creation', async () => {
    const m = await loadModule(repo)
    const thread = await m.createThread('verify round-trip')
    const persisted = await m.getThreadSession(thread.id)
    expect(persisted).toBe(thread.session_id)
  })
})
