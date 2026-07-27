import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ForkSeedModule {
  initChatStore: typeof import('./chat-store').initChatStore
  createThread: typeof import('./chat-store').createThread
  appendMessage: typeof import('./chat-store').appendMessage
  forkThread: typeof import('./chat-store').forkThread
  buildForkSeed: typeof import('./chat-store').buildForkSeed
  getThread: typeof import('./chat-store').getThread
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fork-seed-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ForkSeedModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./chat-store')) as unknown as ForkSeedModule
}

describe('chat-store fork seed', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── buildForkSeed ────────────────────────────────────────────────────────────

  it('extracts 2 task ids and 1 ADR ref from source thread segments', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Source goal')
    await m.appendMessage(source.id, 'user', 'do some work')
    await m.appendMessage(source.id, 'assistant', 'I created two tasks and referenced an ADR', [
      { type: 'task_ref', taskId: 'task-001' },
      { type: 'task_ref', taskId: 'task-002' },
      { type: 'adr_ref', ref: 'ADR-0042' },
    ])

    const seed = await m.buildForkSeed(source.id)

    expect(seed.taskIds).toHaveLength(2)
    expect(seed.taskIds).toEqual(expect.arrayContaining(['task-001', 'task-002']))
    expect(seed.adrRefs).toEqual(['ADR-0042'])
    expect(seed.goalSummary).toBe('Source goal')
    expect(seed.transcriptSummary).toContain('do some work')
  })

  it('extracts glossary and artifact refs from segments', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Goal with refs')
    await m.appendMessage(source.id, 'assistant', 'refs here', [
      { type: 'glossary_ref', ref: 'orchestrator' },
      { type: 'artifact_ref', ref: 'artifact-xyz' },
    ])

    const seed = await m.buildForkSeed(source.id)

    expect(seed.glossaryRefs).toEqual(['orchestrator'])
    expect(seed.artifactRefs).toEqual(['artifact-xyz'])
  })

  it('passes through operator-supplied files into the seed', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Goal')
    const seed = await m.buildForkSeed(source.id, [
      { path: '/some/file.ts', note: 'important context' },
    ])

    expect(seed.files).toEqual([{ path: '/some/file.ts', note: 'important context' }])
  })

  it('deduplicates repeated refs across multiple messages', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Goal')
    await m.appendMessage(source.id, 'assistant', 'first', [
      { type: 'task_ref', taskId: 'task-001' },
    ])
    await m.appendMessage(source.id, 'assistant', 'second also mentions same task', [
      { type: 'task_ref', taskId: 'task-001' },
      { type: 'task_ref', taskId: 'task-002' },
    ])

    const seed = await m.buildForkSeed(source.id)

    expect(seed.taskIds).toHaveLength(2)
    expect(seed.taskIds).toEqual(expect.arrayContaining(['task-001', 'task-002']))
  })

  // ── forkThread seed insertion ─────────────────────────────────────────────────

  it('forkThread inserts one fork_seed assistant message on first creation', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Source')
    await m.appendMessage(source.id, 'user', 'start')
    await m.appendMessage(source.id, 'assistant', 'done', [
      { type: 'task_ref', taskId: 'task-001' },
      { type: 'task_ref', taskId: 'task-002' },
      { type: 'adr_ref', ref: 'ADR-0042' },
    ])

    const { thread, deduped } = await m.forkThread({
      sourceThreadId: source.id,
      goal: 'Child goal',
      idempotencyKey: 'idem-key-1',
    })

    expect(deduped).toBe(false)

    const child = await m.getThread(thread.id)
    const assistantMsgs = child!.messages.filter((msg) => msg.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)

    const segs = assistantMsgs[0]!.segments as Array<Record<string, unknown>>
    const forkSeedSeg = segs.find((s) => s['type'] === 'fork_seed')
    expect(forkSeedSeg).toBeDefined()
    expect(forkSeedSeg!['taskIds']).toEqual(expect.arrayContaining(['task-001', 'task-002']))
    expect(forkSeedSeg!['adrRefs']).toEqual(['ADR-0042'])
  })

  it('repeat forkThread with same idempotencyKey does not insert second seed message', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Source')
    await m.appendMessage(source.id, 'user', 'hi')

    const { thread: t1 } = await m.forkThread({
      sourceThreadId: source.id,
      goal: 'Fork goal',
      idempotencyKey: 'key-abc',
    })

    const { thread: t2, deduped } = await m.forkThread({
      sourceThreadId: source.id,
      goal: 'Fork goal',
      idempotencyKey: 'key-abc',
    })

    expect(deduped).toBe(true)
    expect(t2.id).toBe(t1.id)

    const child = await m.getThread(t1.id)
    const assistantMessages = child!.messages.filter((msg) => msg.role === 'assistant')
    // Only one seed message — not two
    expect(assistantMessages).toHaveLength(1)
  })

  it('different idempotencyKeys create separate child threads each with their own seed', async () => {
    const m = await loadModule(repo)
    await m.initChatStore()

    const source = await m.createThread('Source')

    const { thread: c1 } = await m.forkThread({
      sourceThreadId: source.id,
      goal: 'Fork A',
      idempotencyKey: 'key-A',
    })
    const { thread: c2 } = await m.forkThread({
      sourceThreadId: source.id,
      goal: 'Fork B',
      idempotencyKey: 'key-B',
    })

    expect(c1.id).not.toBe(c2.id)

    const child1 = await m.getThread(c1.id)
    const child2 = await m.getThread(c2.id)

    expect(child1!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(child2!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })
})
