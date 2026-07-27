import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface PatchModule {
  stewardProposeWorkflowPatch: typeof import('./steward-workflow-patch').stewardProposeWorkflowPatch
  applyWorkflowPatch: typeof import('./steward-workflow-patch').applyWorkflowPatch
  rejectWorkflowPatch: typeof import('./steward-workflow-patch').rejectWorkflowPatch
  getWorkflowPatchProposal: typeof import('./steward-workflow-patch').getWorkflowPatchProposal
}

interface ChatModule {
  getThread: typeof import('./chat-store').getThread
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-patch-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<PatchModule & ChatModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const patch = await import('./steward-workflow-patch')
  const chat = await import('./chat-store')
  return { ...patch, ...chat }
}

describe('steward-workflow-patch', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('rejects paths outside .mars/workflows/', async () => {
    const m = await loadModules(repo)
    await expect(
      m.stewardProposeWorkflowPatch({
        workflowPath: 'orchestrator/src/bad.ts',
        unifiedDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
        rationale: 'test',
      }),
    ).rejects.toThrow('.mars/workflows/')
  })

  it('creates a proposal and a validation chat message', async () => {
    const m = await loadModules(repo)
    const { proposalId, threadId } = await m.stewardProposeWorkflowPatch({
      workflowPath: '.mars/workflows/test-flow.js',
      unifiedDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
      rationale: 'The orchestrator noticed a performance bottleneck',
    })

    expect(proposalId).toBeTruthy()
    expect(threadId).toBeTruthy()

    const proposal = await m.getWorkflowPatchProposal(proposalId)
    expect(proposal).not.toBeNull()
    expect(proposal!.status).toBe('awaiting-human')
    expect(proposal!.workflow_path).toBe('.mars/workflows/test-flow.js')

    const threadDetail = await m.getThread(threadId)
    expect(threadDetail).not.toBeNull()
    expect(threadDetail!.messages.length).toBe(1)
    expect(threadDetail!.messages[0]!.kind).toBe('validation')
    expect(threadDetail!.messages[0]!.backing_entity_id).toBe(proposalId)
    expect(threadDetail!.messages[0]!.content).toContain('```diff')
  })

  it('rejectWorkflowPatch sets status to rejected', async () => {
    const m = await loadModules(repo)
    const { proposalId } = await m.stewardProposeWorkflowPatch({
      workflowPath: '.mars/workflows/reject-test.js',
      unifiedDiff: 'diff',
      rationale: 'Mars suggests a change',
    })

    await m.rejectWorkflowPatch(proposalId)

    const proposal = await m.getWorkflowPatchProposal(proposalId)
    expect(proposal!.status).toBe('rejected')
  })

  it('rejects double-reject', async () => {
    const m = await loadModules(repo)
    const { proposalId } = await m.stewardProposeWorkflowPatch({
      workflowPath: '.mars/workflows/double-reject.js',
      unifiedDiff: 'diff',
      rationale: 'test',
    })
    await m.rejectWorkflowPatch(proposalId)
    await expect(m.rejectWorkflowPatch(proposalId)).rejects.toThrow('rejected')
  })

  it('rejects apply on non-awaiting-human proposal', async () => {
    const m = await loadModules(repo)
    const { proposalId } = await m.stewardProposeWorkflowPatch({
      workflowPath: '.mars/workflows/apply-after-reject.js',
      unifiedDiff: 'diff',
      rationale: 'test',
    })
    await m.rejectWorkflowPatch(proposalId)
    await expect(m.applyWorkflowPatch(proposalId, repo)).rejects.toThrow(
      'rejected',
    )
  })

  it('rejects apply for unknown proposal', async () => {
    const m = await loadModules(repo)
    await expect(
      m.applyWorkflowPatch('nonexistent-id', repo),
    ).rejects.toThrow('not found')
  })
})
