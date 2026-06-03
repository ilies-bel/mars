import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-triage-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface ClaudeStub {
  exitCode: number
  stdout: string
  stderr?: string
}

const setClaudeStub = (stub: ClaudeStub): void => {
  vi.doMock('../git/claude', async () => {
    const actual = await vi.importActual<typeof import('../git/claude')>('../git/claude')
    return {
      ...actual,
      runClaudeCode: vi.fn(async () => ({
        exitCode: stub.exitCode,
        stdout: stub.stdout,
        stderr: stub.stderr ?? '',
        sessionId: 'stub-session',
        conversation: [],
      })),
    }
  })
}

const envelope = (jsonResult: unknown): string =>
  JSON.stringify({ result: JSON.stringify(jsonResult), is_error: false })

describe('triage workflow', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../git/claude')
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('promotes a draft to queued when actionable with no blockers', async () => {
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: true,
        reason: 'tight scope',
        blockerTaskIds: [],
      }),
    })
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.initQueue()
    const task = await queue.enqueueTask('implement X')

    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(task.id)

    expect(result.actionable).toBe(true)
    expect(result.blockerCount).toBe(0)
    const reloaded = await queue.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('records blockers and stays draft when not actionable', async () => {
    setClaudeStub({ exitCode: 0, stdout: '' }) // placeholder, replaced below
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.initQueue()
    const a = await queue.enqueueTask('depends on b')
    const b = await queue.enqueueTask('prerequisite')

    vi.resetModules()
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: false,
        reason: 'needs prerequisite',
        blockerTaskIds: [b.id],
      }),
    })
    const queue2 = await import('../../queue')
    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id)

    expect(result.actionable).toBe(false)
    expect(result.blockerCount).toBe(1)
    const blockers = await queue2.listBlockers(a.id)
    expect(blockers).toEqual([b.id])
    const reloaded = await queue2.getTask(a.id)
    expect(reloaded?.status).toBe('draft')
  })

  it('filters out hallucinated blocker ids and self-blocks', async () => {
    vi.resetModules()
    const queue = await import('../../queue')
    await queue.initQueue()
    const a = await queue.enqueueTask('thing')

    vi.resetModules()
    setClaudeStub({
      exitCode: 0,
      stdout: envelope({
        actionable: false,
        reason: 'fake blockers',
        blockerTaskIds: ['nonexistent-id', a.id],
      }),
    })
    const queue2 = await import('../../queue')
    const triage = await import('../../../workflows/triage-workflow')
    const result = await triage.runTriage(a.id)

    expect(result.blockerCount).toBe(0)
    expect(await queue2.listBlockers(a.id)).toEqual([])
  })

})
