import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'mars-test',
  GIT_AUTHOR_EMAIL: 'mars-test@example.com',
  GIT_COMMITTER_NAME: 'mars-test',
  GIT_COMMITTER_EMAIL: 'mars-test@example.com',
}

const runCli = (
  args: readonly string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'mars-ship-summary-test-'))
  mkdirSync(join(repo, '.mars'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: repo,
    env: { ...process.env, ...GIT_ENV },
  })
  return repo
}

// ---------------------------------------------------------------------------
// Test: help text discovery
// ---------------------------------------------------------------------------

describe('mars proposal --help', () => {
  it('lists ship-summary as a subcommand', () => {
    const result = runCli(['proposal', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ship-summary')
  })
})

// ---------------------------------------------------------------------------
// Test: unknown proposal id
// ---------------------------------------------------------------------------

describe('mars proposal ship-summary — unknown id', () => {
  it('exits non-zero with an error message referencing the id', () => {
    const repo = makeRepo()
    try {
      const result = runCli(['proposal', 'ship-summary', 'no-such-id-abc'], {
        MARS_REPO: repo,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('no-such-id-abc')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Tests that need a proposal + tasks in the DB
// ---------------------------------------------------------------------------

describe('mars proposal ship-summary — with proposal and tasks', () => {
  let repo: string
  let proposalId: string
  let taskIds: string[]

  beforeEach(async () => {
    repo = makeRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo

    const { createProposal, initProposals } = await import('../../mastra/proposals')
    const { enqueueTask, updateTask, initQueue } = await import('../../mastra/queue')
    await initProposals()
    await initQueue()

    const proposal = await createProposal(
      'Ship summary test proposal\nThis is the problem statement.',
      { source: 'human' },
    )
    proposalId = proposal.id

    const t1 = await enqueueTask('Slice 1: add the feature\nWith full details here', undefined, {
      skipTriage: true,
      originId: proposalId,
    })
    const t2 = await enqueueTask('Slice 2: add tests\nCovering all edge cases', undefined, {
      skipTriage: true,
      originId: proposalId,
    })
    const t3 = await enqueueTask('Slice 3: update docs\nFinishing touches', undefined, {
      skipTriage: true,
      originId: proposalId,
    })
    taskIds = [t1.id, t2.id, t3.id]

    // Make t1 done, t2 queued, t3 dropped for the default fixture.
    // Individual tests override per-task status as needed.
    await updateTask(t1.id, { status: 'done' })
    // t2 stays queued
    await updateTask(t3.id, { status: 'dropped' })
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('prints the proposal title and arc state on the first lines', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Ship summary test proposal')
    expect(result.stdout).toMatch(/arc[:\s]+in-progress/i)
  })

  it('labels the arc as in-progress when some tasks are still queued', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('in-progress')
  })

  it('shows each task id in the output', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    for (const id of taskIds) {
      expect(result.stdout).toContain(id)
    }
  })

  it('shows "dismissed" for dropped tasks', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    // t3 is dropped — must show as dismissed
    expect(result.stdout).toContain('dismissed')
  })

  it('shows current status for in-flight tasks', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    // t2 is queued
    expect(result.stdout).toContain('queued')
  })

  it('--json emits a structured object with proposal title, arc state, tasks array, and landed commits', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId, '--json'], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    // stdout must be valid JSON (no human-formatted lines mixed in)
    const parsed = JSON.parse(result.stdout) as {
      title: string
      arcState: string
      tasks: Array<{ id: string; status: string; sha: string | null; commitSubject: string | null }>
      landedCommits: string[]
    }
    expect(parsed.title).toContain('Ship summary test proposal')
    expect(parsed.arcState).toBe('in-progress')
    expect(Array.isArray(parsed.tasks)).toBe(true)
    expect(parsed.tasks).toHaveLength(3)
    expect(Array.isArray(parsed.landedCommits)).toBe(true)

    const byId = new Map(parsed.tasks.map((t) => [t.id, t]))
    expect(byId.get(taskIds[0])?.status).toBe('done')
    expect(byId.get(taskIds[1])?.status).toBe('queued')
    expect(byId.get(taskIds[2])?.status).toBe('dropped')
  })

  it('--json emits no human-formatted lines (output is parseable JSON in its entirety)', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId, '--json'], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test: all tasks done → arc-done + sha+subject per row
// ---------------------------------------------------------------------------

describe('mars proposal ship-summary — all tasks done with commits', () => {
  let repo: string
  let proposalId: string
  let taskIds: string[]

  beforeEach(async () => {
    repo = makeRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo

    const { createProposal, initProposals } = await import('../../mastra/proposals')
    const { enqueueTask, updateTask, initQueue } = await import('../../mastra/queue')
    await initProposals()
    await initQueue()

    const proposal = await createProposal('All-done proposal\nEvery slice landed.', {
      source: 'human',
    })
    proposalId = proposal.id

    const t1 = await enqueueTask('Slice 1: first feature', undefined, {
      skipTriage: true,
      originId: proposalId,
    })
    const t2 = await enqueueTask('Slice 2: second feature', undefined, {
      skipTriage: true,
      originId: proposalId,
    })
    taskIds = [t1.id, t2.id]

    await updateTask(t1.id, { status: 'done' })
    await updateTask(t2.id, { status: 'done' })

    // Create commits in the git repo that reference each task id so
    // the per-task commit lookup can find them.
    for (const taskId of taskIds) {
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-q', '-m', `merge(${taskId}): implement slice`],
        { cwd: repo, env: { ...process.env, ...GIT_ENV } },
      )
    }
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('labels the arc as arc-done when all tasks are done', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('arc-done')
  })

  it('shows a sha and commit subject for every done task', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    // Each task row must include the commit subject
    expect(result.stdout).toContain('implement slice')
  })

  it('--json shows a sha for each done task', () => {
    const result = runCli(['proposal', 'ship-summary', proposalId, '--json'], {
      MARS_REPO: repo,
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      arcState: string
      tasks: Array<{ id: string; status: string; sha: string | null; commitSubject: string | null }>
    }
    expect(parsed.arcState).toBe('arc-done')
    for (const t of parsed.tasks) {
      expect(t.status).toBe('done')
      expect(t.sha).not.toBeNull()
      expect(t.commitSubject).not.toBeNull()
    }
  })
})
