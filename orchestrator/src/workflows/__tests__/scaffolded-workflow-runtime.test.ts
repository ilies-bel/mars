import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryStore, defineWorkflow, runWorkflow } from '@mars/workflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadWorkflowForKind,
  userWorkflowPathForKind,
  workflowFileNameForKind,
} from '../queue-workflow-store'

/**
 * S8 (ADR-0056): the daemon dispatch loads a user-owned
 * `.mars/workflows/<kind>-workflow.js` over the bundled in-repo workflow when
 * present, and falls back to the bundled one when absent. The loaded workflow
 * runs on `@mars/workflow` (defineWorkflow/ctx.step) and — critically — the run
 * still routes task-state writes through the injected `services.store`, which in
 * production is the Arc-routed `DomainTaskStore` (S4 / ADR-0052). The loader
 * changes WHICH workflow runs, not the write funnel.
 */

// A bundled fallback that stands in for `implementWorkflow`. Its `id` is the
// discriminator the assertions key on: when the loader returns this object the
// bundled path was taken; when it returns something with id 'user-task' the
// scaffolded file won.
const bundledFallback = defineWorkflow<
  { taskId: string },
  { ranBundled: true; taskId: string },
  { store: { updateTask(id: string, patch: Record<string, unknown>): Promise<void> } }
>({
  id: 'bundled-implement',
  async fn(ctx, input) {
    await ctx.step('bundled-step', async () => {
      await ctx.services.store.updateTask(input.taskId, { status: 'running' })
      return { ok: true }
    })
    return { ranBundled: true, taskId: input.taskId }
  },
})

// A fake task store that records every write at the `services.store` seam. In
// production this seam IS the Arc-routed DomainTaskStore (S4), so a call landing
// here proves the run funnels task-state writes through the aggregate rather
// than issuing its own direct SQL.
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

describe('scaffolded workflow runtime (S8)', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'mars-scaffold-runtime-'))
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  const writeUserWorkflow = (kind: string, source: string): void => {
    const path = userWorkflowPathForKind(kind, repoRoot)
    mkdirSync(join(repoRoot, '.mars', 'workflows'), { recursive: true })
    writeFileSync(path, source)
  }

  it('maps a kind to <kind>-workflow.js under .mars/workflows', () => {
    expect(workflowFileNameForKind('task')).toBe('task-workflow.js')
    expect(workflowFileNameForKind('fix')).toBe('fix-workflow.js')
    expect(workflowFileNameForKind('diagnose')).toBe('diagnose-workflow.js')
    expect(userWorkflowPathForKind('task', repoRoot)).toBe(
      join(repoRoot, '.mars', 'workflows', 'task-workflow.js'),
    )
  })

  it('picks the user-owned .mars/workflows file over the bundled default', async () => {
    writeUserWorkflow(
      'task',
      [
        "export default {",
        "  id: 'user-task',",
        '  async fn(ctx, input) {',
        "    await ctx.step('user-step', async () => {",
        '      await ctx.services.store.updateTask(input.taskId, { status: "running" })',
        '      return { ok: true }',
        '    })',
        "    return { ranBundled: false, taskId: input.taskId }",
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const wf = await loadWorkflowForKind('task', bundledFallback, repoRoot)
    expect(wf.id).toBe('user-task')
    expect(wf).not.toBe(bundledFallback)
  })

  it('falls back to the bundled workflow when no user file is present', async () => {
    const wf = await loadWorkflowForKind('task', bundledFallback, repoRoot)
    expect(wf).toBe(bundledFallback)
    expect(wf.id).toBe('bundled-implement')
  })

  it('falls back to bundled when the user module default export is malformed', async () => {
    // Missing `fn` — not a runnable workflow object.
    writeUserWorkflow('task', "export default { id: 'broken' }\n")
    const wf = await loadWorkflowForKind('task', bundledFallback, repoRoot)
    expect(wf).toBe(bundledFallback)
  })

  it('resolves per-kind: fix file does not satisfy a task lookup', async () => {
    writeUserWorkflow(
      'fix',
      "export default { id: 'user-fix', async fn() { return {} } }\n",
    )
    // task has no file → bundled; fix has a file → user.
    expect((await loadWorkflowForKind('task', bundledFallback, repoRoot)).id).toBe(
      'bundled-implement',
    )
    expect((await loadWorkflowForKind('fix', bundledFallback, repoRoot)).id).toBe(
      'user-fix',
    )
  })

  it('runs the scaffolded workflow on @mars/workflow and routes writes through services.store (Arc seam)', async () => {
    writeUserWorkflow(
      'task',
      [
        "export default {",
        "  id: 'user-task',",
        '  async fn(ctx, input) {',
        "    await ctx.step('code', async () => {",
        '      // The ONLY task-state write goes through services.store — the Arc',
        '      // funnel in production. No direct SQL here.',
        '      await ctx.services.store.updateTask(input.taskId, { status: "done" })',
        '      return { ok: true }',
        '    })',
        "    return { ranBundled: false, taskId: input.taskId }",
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const wf = await loadWorkflowForKind('task', bundledFallback, repoRoot)
    expect(wf.id).toBe('user-task')

    const store = makeRecordingStore()
    const result = await runWorkflow(
      wf,
      { taskId: 'task-123' },
      {
        store: new InMemoryStore(),
        services: { store },
        runId: 'task-123',
      },
    )

    expect(result.status).toBe('completed')
    // The write funnelled through services.store (Arc seam), not direct SQL.
    expect(store.writes).toEqual([
      { id: 'task-123', patch: { status: 'done' } },
    ])
  })

  it('runs the bundled fallback through the same services.store funnel when no user file exists', async () => {
    const wf = await loadWorkflowForKind('task', bundledFallback, repoRoot)
    expect(wf).toBe(bundledFallback)

    const store = makeRecordingStore()
    const result = await runWorkflow(
      wf,
      { taskId: 'task-456' },
      {
        store: new InMemoryStore(),
        services: { store },
        runId: 'task-456',
      },
    )

    expect(result.status).toBe('completed')
    expect(store.writes).toEqual([
      { id: 'task-456', patch: { status: 'running' } },
    ])
  })

  it('persists run + step lifecycle to the @mars/workflow store (resume-capable)', async () => {
    writeUserWorkflow(
      'task',
      [
        "export default {",
        "  id: 'user-task',",
        '  async fn(ctx, input) {',
        "    await ctx.step('only-step', async () => ({ ok: true }))",
        "    return { taskId: input.taskId }",
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const wf = await loadWorkflowForKind('task', bundledFallback, repoRoot)
    const engineStore = new InMemoryStore()
    const store = makeRecordingStore()
    const result = await runWorkflow(
      wf,
      { taskId: 'task-789' },
      { store: engineStore, services: { store }, runId: 'task-789' },
    )

    expect(result.status).toBe('completed')
    const steps = await engineStore.listSteps('task-789')
    expect(steps.map((s) => s.name)).toEqual(['only-step'])
    expect(steps.every((s) => s.status === 'completed')).toBe(true)
  })
})
