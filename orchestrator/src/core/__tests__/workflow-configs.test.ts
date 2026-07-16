import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface WorkflowConfigsMod {
  initWorkflowConfigs: typeof import('../workflow-configs').initWorkflowConfigs
  insertWorkflowConfig: typeof import('../workflow-configs').insertWorkflowConfig
  listWorkflowConfigs: typeof import('../workflow-configs').listWorkflowConfigs
  getActiveWorkflowConfig: typeof import('../workflow-configs').getActiveWorkflowConfig
  getTrialWorkflowConfig: typeof import('../workflow-configs').getTrialWorkflowConfig
  WorkflowConfigSchema: typeof import('../workflow-configs').WorkflowConfigSchema
  WorkflowConfigStatusSchema: typeof import('../workflow-configs').WorkflowConfigStatusSchema
  __resetWorkflowConfigsForTests: typeof import('../workflow-configs').__resetWorkflowConfigsForTests
}

interface StateClientMod {
  resolveStateClient: typeof import('../store/state-client').resolveStateClient
  __resetStateClientForTests: typeof import('../store/state-client').__resetStateClientForTests
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-wfconfigs-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (
  repo: string,
): Promise<{ wc: WorkflowConfigsMod; sc: StateClientMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const wc = (await import('../workflow-configs')) as unknown as WorkflowConfigsMod
  const sc = (await import('../store/state-client')) as unknown as StateClientMod
  await wc.initWorkflowConfigs()
  return { wc, sc }
}

describe('workflow_configs table CRUD', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('insertWorkflowConfig persists a row and round-trips through WorkflowConfigSchema', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    const record = await wc.insertWorkflowConfig(client, {
      id: 'wfc-001',
      workflow: 'task',
      version: 1,
      configHash: 'abc123def456abc123def456abc123def456abc1',
      status: 'baseline',
    })

    expect(record.id).toBe('wfc-001')
    expect(record.workflow).toBe('task')
    expect(record.version).toBe(1)
    expect(record.configHash).toBe('abc123def456abc123def456abc123def456abc1')
    expect(record.status).toBe('baseline')
    expect(record.createdAt).toBeGreaterThan(0)
    expect(record.updatedAt).toBeGreaterThan(0)

    // Re-validate against schema to confirm the shape is complete.
    expect(() => wc.WorkflowConfigSchema.parse(record)).not.toThrow()
  })

  it('WorkflowConfigStatusSchema rejects unknown status values', async () => {
    const { wc } = await loadMods(repo)
    const { WorkflowConfigStatusSchema } = wc
    expect(() => WorkflowConfigStatusSchema.parse('active')).toThrow()
    expect(() => WorkflowConfigStatusSchema.parse('pending')).toThrow()
    expect(() => WorkflowConfigStatusSchema.parse('deleted')).toThrow()
    expect(WorkflowConfigStatusSchema.parse('baseline')).toBe('baseline')
    expect(WorkflowConfigStatusSchema.parse('trial')).toBe('trial')
    expect(WorkflowConfigStatusSchema.parse('promoted')).toBe('promoted')
    expect(WorkflowConfigStatusSchema.parse('retired')).toBe('retired')
  })

  it('listWorkflowConfigs returns all rows for a workflow ordered by version descending', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash-v1',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v2',
      workflow: 'task',
      version: 2,
      configHash: 'hash-v2',
      status: 'trial',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-fix-v1',
      workflow: 'fix',
      version: 1,
      configHash: 'hash-fix-v1',
      status: 'baseline',
    })

    const taskConfigs = await wc.listWorkflowConfigs(client, 'task')
    expect(taskConfigs).toHaveLength(2)
    // Newest version first.
    expect(taskConfigs[0].id).toBe('wfc-v2')
    expect(taskConfigs[1].id).toBe('wfc-v1')

    const fixConfigs = await wc.listWorkflowConfigs(client, 'fix')
    expect(fixConfigs).toHaveLength(1)
    expect(fixConfigs[0].id).toBe('wfc-fix-v1')

    // Empty when no rows for a workflow.
    const noConfigs = await wc.listWorkflowConfigs(client, 'plan')
    expect(noConfigs).toHaveLength(0)
  })

  it('getActiveWorkflowConfig returns the promoted row in preference to baseline', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    // Only a baseline row — that should be returned.
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-base',
      workflow: 'task',
      version: 1,
      configHash: 'hash-base',
      status: 'baseline',
    })
    const active1 = await wc.getActiveWorkflowConfig(client, 'task')
    expect(active1?.id).toBe('wfc-base')
    expect(active1?.status).toBe('baseline')

    // Add a promoted row — it should take precedence.
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-promoted',
      workflow: 'task',
      version: 2,
      configHash: 'hash-promoted',
      status: 'promoted',
    })
    const active2 = await wc.getActiveWorkflowConfig(client, 'task')
    expect(active2?.id).toBe('wfc-promoted')
    expect(active2?.status).toBe('promoted')
  })

  it('getActiveWorkflowConfig returns null when no baseline or promoted row exists', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    // Only a trial and retired row — neither is "active".
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-trial',
      workflow: 'task',
      version: 1,
      configHash: 'hash-trial',
      status: 'trial',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-retired',
      workflow: 'task',
      version: 2,
      configHash: 'hash-retired',
      status: 'retired',
    })

    const active = await wc.getActiveWorkflowConfig(client, 'task')
    expect(active).toBeNull()
  })

  it('getTrialWorkflowConfig returns the trial row for a workflow', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-base',
      workflow: 'task',
      version: 1,
      configHash: 'hash-base',
      status: 'baseline',
    })
    await wc.insertWorkflowConfig(client, {
      id: 'wfc-trial',
      workflow: 'task',
      version: 2,
      configHash: 'hash-trial',
      status: 'trial',
    })

    const trial = await wc.getTrialWorkflowConfig(client, 'task')
    expect(trial?.id).toBe('wfc-trial')
    expect(trial?.status).toBe('trial')
  })

  it('getTrialWorkflowConfig returns null when no trial row exists', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-base',
      workflow: 'task',
      version: 1,
      configHash: 'hash-base',
      status: 'baseline',
    })

    const trial = await wc.getTrialWorkflowConfig(client, 'task')
    expect(trial).toBeNull()
  })

  it('UNIQUE(workflow, version) constraint rejects duplicate version within the same workflow', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-v1-a',
      workflow: 'task',
      version: 1,
      configHash: 'hash-a',
      status: 'baseline',
    })

    // Same workflow + same version → constraint violation.
    await expect(
      wc.insertWorkflowConfig(client, {
        id: 'wfc-v1-b',
        workflow: 'task',
        version: 1,
        configHash: 'hash-b',
        status: 'trial',
      }),
    ).rejects.toThrow()
  })

  it('UNIQUE(workflow, version) allows the same version number across different workflows', async () => {
    const { wc, sc } = await loadMods(repo)
    const client = sc.resolveStateClient()

    await wc.insertWorkflowConfig(client, {
      id: 'wfc-task-v1',
      workflow: 'task',
      version: 1,
      configHash: 'hash-task',
      status: 'baseline',
    })

    // Different workflow + same version → should succeed.
    const fixV1 = await wc.insertWorkflowConfig(client, {
      id: 'wfc-fix-v1',
      workflow: 'fix',
      version: 1,
      configHash: 'hash-fix',
      status: 'baseline',
    })
    expect(fixV1.id).toBe('wfc-fix-v1')
  })
})
