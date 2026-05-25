import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface ScnModule {
  tryShortCircuitOnSiblingContextNote: typeof import('../sibling-context-note').tryShortCircuitOnSiblingContextNote
  siblingContextNoteName: typeof import('../sibling-context-note').siblingContextNoteName
  findSiblingContextNote: typeof import('../sibling-context-note').findSiblingContextNote
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sibling-ctx-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let templateRepo: string
const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; scn: ScnModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const scn = (await import(
    '../sibling-context-note'
  )) as unknown as ScnModule
  return { q, scn }
}

describe('tryShortCircuitOnSiblingContextNote', () => {
  let repo: string
  let worktrees: string[] = []

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.initQueue()
    delete process.env.MARS_REPO
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
    worktrees = []
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    for (const w of worktrees) {
      rmSync(w, { recursive: true, force: true })
    }
    rmSync(repo, { recursive: true, force: true })
  })

  const mkWorktree = (): string => {
    const w = mkdtempSync(resolve(tmpdir(), 'mars-wt-'))
    worktrees.push(w)
    return w
  }

  it('short-circuits when the sibling CONTEXT note already exists in the parent worktree', async () => {
    const { q, scn } = await loadModules(repo)
    const parent = await q.enqueueTask('do thing', undefined, {
      skipTriage: true,
    })
    const worktree = mkWorktree()
    // Drop the sibling note named after the parent task id.
    const notePath = resolve(worktree, `CONTEXT-${parent.id}.md`)
    writeFileSync(notePath, '# pre-existing context note for parent\n')
    await q.updateTask(parent.id, {
      worktreePath: worktree,
      status: 'running',
    })

    const taskCountBefore = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM tasks`,
      args: [],
    })
    const before = Number(
      (taskCountBefore.rows[0] as unknown as { n: number }).n,
    )

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '))
    }
    try {
      const result = await scn.tryShortCircuitOnSiblingContextNote(parent.id)

      expect(result.shortCircuited).toBe(true)
      expect(result.notePath).toBe(notePath)

      // Parent reached the terminal status that represents context-already-
      // gathered, and the existing note is recorded as its artifact.
      const after = await q.getTask(parent.id)
      expect(after?.status).toBe('done')
      expect(after?.error ?? '').toContain(`CONTEXT-${parent.id}.md`)
      expect(after?.error ?? '').toMatch(/context-already-gathered/i)

      // Exactly one short-circuit log line, naming the parent.
      const shortCircuitLogs = logs.filter((l) =>
        l.includes('[short-circuit]'),
      )
      expect(shortCircuitLogs).toHaveLength(1)
      expect(shortCircuitLogs[0]).toContain(parent.id)

      // No new child task was queued.
      const taskCountAfter = await q.getClient().execute({
        sql: `SELECT COUNT(*) AS n FROM tasks`,
        args: [],
      })
      expect(
        Number((taskCountAfter.rows[0] as unknown as { n: number }).n),
      ).toBe(before)
    } finally {
      console.log = origLog
    }
  })

  it('does not short-circuit when no sibling CONTEXT note is present', async () => {
    const { q, scn } = await loadModules(repo)
    const parent = await q.enqueueTask('do thing', undefined, {
      skipTriage: true,
    })
    const worktree = mkWorktree()
    await q.updateTask(parent.id, {
      worktreePath: worktree,
      status: 'running',
    })

    const result = await scn.tryShortCircuitOnSiblingContextNote(parent.id)

    expect(result.shortCircuited).toBe(false)
    expect(result.notePath).toBeNull()

    // Parent status untouched — the caller is free to proceed with its
    // normal recovery (queueing a context-gathering child).
    const after = await q.getTask(parent.id)
    expect(after?.status).toBe('running')
  })

  it('performs only filesystem inspection (no network/LLM side effects observable)', async () => {
    // The function imports only `node:fs` and the local queue module; it
    // never touches `fetch`, an LLM SDK, or a network socket. Guard against
    // a future caller wiring in an LLM-backed check by asserting that
    // `fetch` is not invoked during the presence-check path.
    const { q, scn } = await loadModules(repo)
    const parent = await q.enqueueTask('do thing', undefined, {
      skipTriage: true,
    })
    const worktree = mkWorktree()
    writeFileSync(
      resolve(worktree, `CONTEXT-${parent.id}.md`),
      'note\n',
    )
    await q.updateTask(parent.id, {
      worktreePath: worktree,
      status: 'running',
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => {
        throw new Error('short-circuit must not perform network calls')
      })
    try {
      const result = await scn.tryShortCircuitOnSiblingContextNote(parent.id)
      expect(result.shortCircuited).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
