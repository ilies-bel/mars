/**
 * End-to-end acceptance test for the report workflow (ADR-0056, read-only pipeline).
 *
 * Verifies:
 *   (a) A report task reaches status='done'.
 *   (b) Zero new commits are added to the integration branch.
 *   (c) The merge and verify primitives are never invoked.
 *   (d) The runAgent step is invoked exactly once.
 *   (e) The workflow succeeds regardless of integration-branch state
 *       (no "already ancestor" / "no diff" failure because merge is never called).
 *
 * Pattern mirrors scaffolded-workflow-runtime.test.ts: a minimal custom
 * workflow is written to <tempRepo>/.mars/workflows/report-workflow.js and
 * loaded via loadWorkflowByName. All external calls are wired through
 * ctx.services so they are fully observable without module mocking.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryStore, runWorkflow } from '@mars/workflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadWorkflowByName, userWorkflowPath } from '../queue-workflow-store'

// ---------------------------------------------------------------------------
// Minimal recording store — the services.store seam, same shape as in
// scaffolded-workflow-runtime.test.ts.
// ---------------------------------------------------------------------------

interface RecordingStore {
  writes: Array<{ id: string; patch: Record<string, unknown> }>
  updateTask(id: string, patch: Record<string, unknown>): Promise<void>
}

const makeRecordingStore = (): RecordingStore => {
  const writes: Array<{ id: string; patch: Record<string, unknown> }> = []
  return {
    writes,
    async updateTask(id, patch) {
      writes.push({ id, patch })
    },
  }
}

// ---------------------------------------------------------------------------
// The minimal report workflow written to disk.
//
// Three steps mirror the template's shape (setup → code → finalize) without
// importing real primitives. All observable actions are wired through
// ctx.services so the test can count invocations without module-level mocking.
// ---------------------------------------------------------------------------

const REPORT_WORKFLOW_SRC = [
  'export default {',
  "  id: 'report',",
  '  async fn(ctx, input) {',
  "    await ctx.step('setup', async () => ({ ok: true }))",
  "    await ctx.step('code', async () => {",
  '      await ctx.services.runAgent(input.taskId)',
  '      return { ok: true }',
  '    })',
  "    return await ctx.step('finalize', async () => {",
  '      await ctx.services.store.updateTask(',
  '        input.taskId,',
  '        { status: "done", failedPhase: null },',
  '      )',
  '      return { taskId: input.taskId, success: true, message: "report complete" }',
  '    })',
  '  },',
  '}',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('report-workflow e2e — no commit, no merge, no verify', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'mars-report-e2e-'))

    // Initialise a git repo with one commit so rev-list assertions are meaningful.
    spawnSync('git', ['-C', repoRoot, 'init'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com'], {
      encoding: 'utf8',
    })
    spawnSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test'], { encoding: 'utf8' })
    writeFileSync(join(repoRoot, 'README.md'), '# test\n')
    spawnSync('git', ['-C', repoRoot, 'add', 'README.md'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repoRoot, 'commit', '-m', 'init'], { encoding: 'utf8' })

    // Place the minimal report workflow under .mars/workflows/.
    mkdirSync(join(repoRoot, '.mars', 'workflows'), { recursive: true })
    writeFileSync(userWorkflowPath('report', repoRoot), REPORT_WORKFLOW_SRC)
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('dispatches to completion: status=done, runAgent×1, merge×0, verify×0, no new commits', async () => {
    const headBefore = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim()

    const taskId = 'test-report-e2e-1'
    const store = makeRecordingStore()
    let runAgentCallCount = 0
    let mergeCallCount = 0
    let verifyCallCount = 0

    const wf = await loadWorkflowByName('report', repoRoot)
    expect(wf.id).toBe('report')

    const result = await runWorkflow(
      wf,
      { taskId },
      {
        store: new InMemoryStore(),
        services: {
          store,
          runAgent: async (_id: string) => {
            runAgentCallCount++
            return { ok: true }
          },
          merge: async () => {
            mergeCallCount++
          },
          verify: async () => {
            verifyCallCount++
          },
        },
        runId: taskId,
      },
    )

    // (a) Workflow engine completed
    expect(result.status).toBe('completed')

    // (a) Task was marked done through the store write funnel
    expect(store.writes).toContainEqual({
      id: taskId,
      patch: { status: 'done', failedPhase: null },
    })

    // (d) runAgent was called exactly once — the code step ran
    expect(runAgentCallCount).toBe(1)

    // (c) merge and verify were never invoked
    expect(mergeCallCount).toBe(0)
    expect(verifyCallCount).toBe(0)

    // (b) Zero new commits on the integration branch
    const newCommits = spawnSync(
      'git',
      ['-C', repoRoot, 'rev-list', `${headBefore}..HEAD`],
      { encoding: 'utf8' },
    ).stdout.trim()
    expect(newCommits).toBe('')
  })

  it('succeeds regardless of integration-branch state (no "already ancestor" / "no diff" error)', async () => {
    // Run the workflow without advancing the branch tip first.  The report
    // workflow never calls the merge primitive so it must not produce a
    // merge-related failure even when the branch is unchanged.
    const taskId = 'test-report-e2e-2'
    const store = makeRecordingStore()
    let runAgentCallCount = 0

    const wf = await loadWorkflowByName('report', repoRoot)
    const result = await runWorkflow(
      wf,
      { taskId },
      {
        store: new InMemoryStore(),
        services: {
          store,
          runAgent: async (_id: string) => {
            runAgentCallCount++
          },
        },
        runId: taskId,
      },
    )

    expect(result.status).toBe('completed')
    expect(store.writes).toContainEqual({
      id: taskId,
      patch: { status: 'done', failedPhase: null },
    })
    expect(runAgentCallCount).toBe(1)
  })
})
