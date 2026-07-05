import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryStore, runWorkflow } from '@mars/workflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isWorkflowLoadError,
  loadWorkflowByName,
  userWorkflowPath,
  workflowFileName,
} from '../queue-workflow-store'

/**
 * The daemon dispatch loads the user-owned `.mars/workflows/<name>-workflow.js`
 * named by `task.workflow ?? task.kind` — and NOTHING else. There is no
 * bundled fallback (supersedes ADR-0056's fallback clause): a missing or
 * malformed file throws a WorkflowLoadError the dispatcher turns into a
 * precise task failure. With per-step Execution modes, silently substituting
 * the fully-auto pipeline would hand a manual step to an agent.
 *
 * The import URL is mtime-cache-busted so an edited workflow goes live on the
 * next dispatch without a daemon restart — the load-bearing iterability
 * guarantee.
 *
 * The loaded workflow runs on `@mars/workflow` (defineWorkflow/ctx.step) and
 * still routes task-state writes through the injected `services.store`, which
 * in production is the Arc-routed `DomainTaskStore` (S4 / ADR-0052). The
 * loader changes WHICH workflow runs, not the write funnel.
 */

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

describe('user-owned workflow loading (no fallback)', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'mars-scaffold-runtime-'))
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  const writeUserWorkflow = (name: string, source: string): void => {
    const path = userWorkflowPath(name, repoRoot)
    mkdirSync(join(repoRoot, '.mars', 'workflows'), { recursive: true })
    writeFileSync(path, source)
  }

  it('maps a workflow name to <name>-workflow.js under .mars/workflows', () => {
    expect(workflowFileName('task')).toBe('task-workflow.js')
    expect(workflowFileName('fix')).toBe('fix-workflow.js')
    expect(workflowFileName('live')).toBe('live-workflow.js')
    expect(userWorkflowPath('task', repoRoot)).toBe(
      join(repoRoot, '.mars', 'workflows', 'task-workflow.js'),
    )
  })

  it('loads the user-owned .mars/workflows file by name', async () => {
    writeUserWorkflow(
      'task',
      [
        'export default {',
        "  id: 'user-task',",
        '  async fn(ctx, input) {',
        "    await ctx.step('user-step', async () => {",
        '      await ctx.services.store.updateTask(input.taskId, { status: "running" })',
        '      return { ok: true }',
        '    })',
        '    return { taskId: input.taskId }',
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const wf = await loadWorkflowByName('task', repoRoot)
    expect(wf.id).toBe('user-task')
  })

  it('throws a WorkflowLoadError naming file and remedy when no file exists', async () => {
    await expect(loadWorkflowByName('task', repoRoot)).rejects.toThrow(
      /no workflow file for 'task'/,
    )
    await expect(loadWorkflowByName('task', repoRoot)).rejects.toThrow(
      /No fallback pipeline is ever substituted/,
    )
    const err = await loadWorkflowByName('task', repoRoot).catch((e: unknown) => e)
    expect(isWorkflowLoadError(err)).toBe(true)
  })

  it('throws (never substitutes) when the default export is malformed', async () => {
    // Missing `fn` — not a runnable workflow object.
    writeUserWorkflow('task', "export default { id: 'broken' }\n")
    await expect(loadWorkflowByName('task', repoRoot)).rejects.toThrow(
      /must default-export a workflow object/,
    )
  })

  it('throws (never substitutes) when the file fails to import', async () => {
    writeUserWorkflow('task', 'export default {{{ not javascript\n')
    await expect(loadWorkflowByName('task', repoRoot)).rejects.toThrow(
      /failed to load/,
    )
  })

  it('resolves per-name: a live file does not satisfy a task lookup', async () => {
    writeUserWorkflow(
      'live',
      "export default { id: 'user-live', async fn() { return {} } }\n",
    )
    await expect(loadWorkflowByName('task', repoRoot)).rejects.toThrow(
      /no workflow file for 'task'/,
    )
    expect((await loadWorkflowByName('live', repoRoot)).id).toBe('user-live')
  })

  it('picks up edits on the next load without a process restart (mtime cache-bust)', () => {
    // vite-node (the vitest module runner) normalizes away import query
    // strings, so the reload guarantee cannot be asserted in-process here — a
    // second in-process load would hand back the cached first version and
    // falsely fail. Pin the platform mechanism the loader relies on by
    // running the exact same import-URL scheme (file URL + ?v=<mtimeMs>)
    // under a real `node` subprocess — the daemon's actual runtime.
    const dir = mkdtempSync(join(tmpdir(), 'mars-reload-'))
    try {
      const wf = join(dir, 'wf.mjs')
      const script = join(dir, 'main.mjs')
      writeFileSync(wf, "export default { id: 'v1' }\n")
      writeFileSync(
        script,
        [
          "import { writeFileSync, statSync, utimesSync } from 'node:fs'",
          "import { pathToFileURL } from 'node:url'",
          `const wf = ${JSON.stringify(wf)}`,
          'const load = async () =>',
          "  (await import(pathToFileURL(wf).href + '?v=' + statSync(wf).mtimeMs)).default.id",
          'utimesSync(wf, new Date(1_000_000), new Date(1_000_000))',
          'const a = await load()',
          'writeFileSync(wf, "export default { id: \'v2\' }\\n")',
          'utimesSync(wf, new Date(2_000_000), new Date(2_000_000))',
          'const b = await load()',
          "console.log(a + ' ' + b)",
          '',
        ].join('\n'),
      )
      const r = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('v1 v2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the scaffolded workflow on @mars/workflow and routes writes through services.store (Arc seam)', async () => {
    writeUserWorkflow(
      'task',
      [
        'export default {',
        "  id: 'user-task',",
        '  async fn(ctx, input) {',
        "    await ctx.step('code', async () => {",
        '      // The ONLY task-state write goes through services.store — the Arc',
        '      // funnel in production. No direct SQL here.',
        '      await ctx.services.store.updateTask(input.taskId, { status: "done" })',
        '      return { ok: true }',
        '    })',
        '    return { taskId: input.taskId }',
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const wf = await loadWorkflowByName('task', repoRoot)
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

  it('persists run + step lifecycle to the @mars/workflow store (resume-capable)', async () => {
    writeUserWorkflow(
      'task',
      [
        'export default {',
        "  id: 'user-task',",
        '  async fn(ctx, input) {',
        "    await ctx.step('only-step', async () => ({ ok: true }))",
        '    return { taskId: input.taskId }',
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const wf = await loadWorkflowByName('task', repoRoot)
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
