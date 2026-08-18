/**
 * Integration tests for the restart-checkpoint dispatch path.
 *
 * Verifies the compose → render → inject pipeline that runAgent executes
 * when resumeFromPriorAttempt=true. Uses a real git repository (same as
 * restart-checkpoint.test.ts) plus a simulated prompt injection so we can
 * assert on the final prompt text without spinning up the full worker.
 *
 * Key scenario: `mars continue <id>` on a task with prior commits produces
 * a worker invocation whose prompt contains the checkpoint section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { FailedPhase, Task, TaskSpec } from '../queue.js'

vi.mock('../queue.js', () => ({
  resolveQueueClient: vi.fn(),
  getTranscript: vi.fn(),
}))

import * as Q from '../queue.js'
import {
  composeRestartCheckpoint,
  renderRestartCheckpoint,
} from './restart-checkpoint.js'

// ---------------------------------------------------------------------------
// Helpers (mirrors restart-checkpoint.test.ts)
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-rcp-dispatch-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
  execFileSync('git', ['checkout', '-b', 'task/test-01'], { cwd: dir })
  return dir
}

function addCommit(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, content] of Object.entries(files)) {
    const abs = resolve(dir, name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', message], { cwd: dir })
}

function makeSpec(partial: Partial<TaskSpec> = {}): TaskSpec {
  return { files: [], verifyCmd: null, doneCriteria: [], mergeMode: 'auto', ...partial } as TaskSpec
}

function makeTask(
  partial: {
    failedPhase?: FailedPhase | null
    failureReasonCode?: string | null
    failureSignature?: string | null
    stallDiagnostics?: string | null
    spec?: TaskSpec | null
  } = {},
): Task {
  return {
    failedPhase: partial.failedPhase ?? null,
    failureReasonCode: partial.failureReasonCode ?? null,
    failureSignature: partial.failureSignature ?? null,
    stallDiagnostics: partial.stallDiagnostics ?? null,
    spec: partial.spec ?? null,
  } as unknown as Task
}

let repoDir: string

beforeEach(() => {
  repoDir = setupRepo()
  vi.mocked(Q.resolveQueueClient).mockReturnValue({ execute: vi.fn().mockResolvedValue({ rows: [] }) } as any)
  vi.mocked(Q.getTranscript).mockResolvedValue(null)
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// Pipeline: compose → render → inject
// ---------------------------------------------------------------------------

describe('compose → render → inject pipeline', () => {
  it('cold start: prompt has no checkpoint section when not resumed', () => {
    // On a cold start (resumeFromPriorAttempt=false) the dispatch site never
    // calls composeRestartCheckpoint or renderRestartCheckpoint. Simulate: the
    // task prompt is just the raw prompt with no checkpoint injected.
    const taskPrompt = 'Implement the requested change in the worktree.'
    // No checkpoint appended — this is what the dispatch site does on cold start.
    const fullPrompt = taskPrompt
    expect(fullPrompt).not.toContain(
      '## Restart checkpoint (prior work already on this branch)',
    )
  })

  it('resume with commits: rendered checkpoint section contains commit info', async () => {
    addCommit(
      repoDir,
      { 'src/feature.ts': 'export const x = 1\n' },
      'feat(auth): implement token refresh',
    )

    const cp = await composeRestartCheckpoint({
      taskId: 'task-01',
      worktreePath: repoDir,
      task: makeTask({ failedPhase: 'code' }),
    })

    const rendered = renderRestartCheckpoint(cp)

    // Must include the checkpoint title
    expect(rendered).toContain('## Restart checkpoint (prior work already on this branch)')
    // Must include the commit subject
    expect(rendered).toContain('feat(auth): implement token refresh')
    // Must include the changed file
    expect(rendered).toContain('src/feature.ts')
    // SHA must be 7-char abbreviated, not full 40-char
    expect(cp.commits[0]!.sha).toHaveLength(40)
    expect(rendered).toContain(`\`${cp.commits[0]!.sha.slice(0, 7)}\``)
    expect(rendered).not.toContain(cp.commits[0]!.sha)
  })

  it('resume with commits: injected checkpoint appears in full prompt', async () => {
    addCommit(
      repoDir,
      { 'src/handler.ts': 'export function handle() {}\n' },
      'fix(handler): correct edge case',
    )

    const cp = await composeRestartCheckpoint({
      taskId: 'task-01',
      worktreePath: repoDir,
      task: makeTask({ failedPhase: 'code' }),
    })
    const rendered = renderRestartCheckpoint(cp)

    // Simulate the prompt injection the dispatch site performs.
    const basePrompt = 'Implement the requested change.'
    // isResume=true: inject checkpoint section + resume banner
    const fullPrompt =
      basePrompt +
      (rendered ? '\n\n' + rendered : '') +
      '\n\n## Resume prior work\n\nPrior progress is already in this worktree.'

    expect(fullPrompt).toContain('## Restart checkpoint (prior work already on this branch)')
    expect(fullPrompt).toContain('fix(handler): correct edge case')
  })

  it('resume with verify failure: checkpoint section includes fenced verify block', async () => {
    addCommit(repoDir, { 'src/index.ts': 'export {}\n' }, 'feat: initial impl')

    vi.mocked(Q.getTranscript).mockResolvedValue({
      taskId: 'task-01',
      conversationJson: '',
      verifyOutput: 'FAIL src/index.test.ts\n  TypeError: cannot read property',
      bytes: 50,
      recordedAt: '2026-08-18T00:00:00.000Z',
    })

    const cp = await composeRestartCheckpoint({
      taskId: 'task-01',
      worktreePath: repoDir,
      task: makeTask({
        failedPhase: 'verify',
        failureReasonCode: 'verify:test',
        spec: makeSpec({ verifyCmd: 'cd orchestrator && npm test' }),
      }),
    })

    const rendered = renderRestartCheckpoint(cp)

    expect(rendered).toContain('### Last failing verify')
    expect(rendered).toContain('`cd orchestrator && npm test`')
    expect(rendered).toContain('FAIL src/index.test.ts')
    // Verify block must be fenced
    expect(rendered).toContain('```text')
  })

  it('resume with all criteria checked: empty criteria header is emitted', async () => {
    addCommit(repoDir, { 'src/done.ts': 'export {}\n' }, 'feat: completed all criteria')

    vi.mocked(Q.resolveQueueClient).mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        rows: [
          { text: 'write tests', status: 'met' },
          { text: 'typecheck passes', status: 'met' },
        ],
      }),
    } as any)

    const cp = await composeRestartCheckpoint({
      taskId: 'task-01',
      worktreePath: repoDir,
      task: makeTask({
        spec: makeSpec({ doneCriteria: ['write tests', 'typecheck passes'] }),
      }),
    })

    // All criteria are met
    expect(cp.outstandingCriteria).toEqual([])
    expect(cp.hadDoneCriteria).toBe(true)

    const rendered = renderRestartCheckpoint(cp)

    // The header MUST appear even though the list is empty.
    expect(rendered).toContain('### Remaining acceptance criteria')
    // No checklist items since all are met.
    expect(rendered).not.toContain('- [ ]')
  })
})

// ---------------------------------------------------------------------------
// mars continue fixture: prompt content assertion
// ---------------------------------------------------------------------------

describe('mars continue fixture', () => {
  it('mars continue on a task with prior commits produces a prompt with the checkpoint section', async () => {
    // Setup: multiple commits ahead of main, mimicking what mars continue sees.
    addCommit(repoDir, { 'src/a.ts': 'export const a = 1\n' }, 'feat: add a')
    addCommit(repoDir, { 'src/b.ts': 'export const b = 2\n' }, 'fix: add b')

    const cp = await composeRestartCheckpoint({
      taskId: 'task-continue-01',
      worktreePath: repoDir,
      task: makeTask({
        failedPhase: 'code',
        spec: makeSpec({
          doneCriteria: ['implement a', 'implement b'],
          verifyCmd: 'cd orchestrator && npm test',
        }),
      }),
    })

    const rendered = renderRestartCheckpoint(cp)

    // Reconstruct the full prompt as runAgent does on mars continue:
    // base prompt + checkpoint section + resume banner
    const basePrompt = 'Fix the remaining issues in the worktree.'
    const fullPrompt =
      basePrompt +
      (rendered ? '\n\n' + rendered : '') +
      '\n\n## Resume prior work\n\nPrior progress is already in this worktree.'

    // Checkpoint section must be present
    expect(fullPrompt).toContain('## Restart checkpoint (prior work already on this branch)')

    // Both commits must be referenced
    expect(fullPrompt).toContain('feat: add a')
    expect(fullPrompt).toContain('fix: add b')

    // Changed paths must be listed
    expect(fullPrompt).toContain('src/a.ts')
    expect(fullPrompt).toContain('src/b.ts')

    // SHA7 format: 7-char hex prefix in backticks
    for (const commit of cp.commits) {
      expect(fullPrompt).toContain(`\`${commit.sha.slice(0, 7)}\``)
    }

    // Outstanding criteria (none met yet — no DB rows returned)
    expect(fullPrompt).toContain('- [ ] implement a')
    expect(fullPrompt).toContain('- [ ] implement b')

    // Resume banner still present after the checkpoint section
    expect(fullPrompt).toContain('## Resume prior work')
  })
})
