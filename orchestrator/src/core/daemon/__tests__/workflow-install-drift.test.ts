/**
 * Startup reconciliation for installed Workflow files.
 *
 * Workflow templates are known to the framework but dispatch only executes
 * files in `.mars/workflows`. These tests exercise that startup boundary and
 * inspect the public action-queue view an operator receives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { scaffoldWorkflows } from '../../../init/scaffold-workflows'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface ReconcileModule {
  runStartupReconcile: typeof import('../startup-reconcile').runStartupReconcile
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-workflow-install-drift-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ actionQueue: ActionQueueModule; reconcile: ReconcileModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const reconcile = (await import('../startup-reconcile')) as unknown as ReconcileModule
  return { actionQueue, reconcile }
}

const startupDeps = () => ({
  log: (_line: string): void => {},
  bus: new EventEmitter(),
  traceStore: null,
  handleProposalSlice: null,
})

describe('startup workflow installation reconciliation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises one operator alert naming a Workflow file that dispatch cannot load', async () => {
    scaffoldWorkflows({ repoRoot: repo })
    unlinkSync(resolve(repo, '.mars', 'workflows', 'report-workflow.js'))
    const { actionQueue, reconcile } = await loadModules(repo)

    await reconcile.runStartupReconcile(startupDeps())

    const rows = (await actionQueue.listActionQueueItems('open')).filter(
      (row) => row.kind === 'workflow-install-drift',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toContain('report')
    expect(rows[0]?.body).toContain('mars update')
  })

  it('keeps a persistent installation gap to one alert across restarts', async () => {
    scaffoldWorkflows({ repoRoot: repo })
    unlinkSync(resolve(repo, '.mars', 'workflows', 'report-workflow.js'))
    const { actionQueue, reconcile } = await loadModules(repo)

    await reconcile.runStartupReconcile(startupDeps())
    const first = (await actionQueue.listActionQueueItems('open')).find(
      (row) => row.kind === 'workflow-install-drift',
    )
    await reconcile.runStartupReconcile(startupDeps())
    const rows = (await actionQueue.listActionQueueItems('open')).filter(
      (row) => row.kind === 'workflow-install-drift',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(first?.id)
  })

  it('resolves the alert once the missing Workflow is scaffolded', async () => {
    scaffoldWorkflows({ repoRoot: repo })
    unlinkSync(resolve(repo, '.mars', 'workflows', 'report-workflow.js'))
    const { actionQueue, reconcile } = await loadModules(repo)

    await reconcile.runStartupReconcile(startupDeps())
    const alert = (await actionQueue.listActionQueueItems('open')).find(
      (row) => row.kind === 'workflow-install-drift',
    )
    expect(alert).toBeDefined()

    scaffoldWorkflows({ repoRoot: repo })
    await reconcile.runStartupReconcile(startupDeps())

    expect((await actionQueue.getActionQueueItem(alert!.id))?.state).toBe('resolved')
  })

  it('raises no installation alert when every known Workflow is installed', async () => {
    scaffoldWorkflows({ repoRoot: repo })
    const { actionQueue, reconcile } = await loadModules(repo)

    await reconcile.runStartupReconcile(startupDeps())

    expect(
      (await actionQueue.listActionQueueItems('open')).filter(
        (row) => row.kind === 'workflow-install-drift',
      ),
    ).toEqual([])
  })
})
