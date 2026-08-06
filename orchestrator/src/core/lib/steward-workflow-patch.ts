import { randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client.js'
import { createThread, appendMessage } from './chat-store.js'
import { renderMarsVoice } from './chat-mars-verbs.js'
import { exec } from './git/internal.js'

const stateClient = resolveStateClient

export type PatchStatus = 'awaiting-human' | 'applied' | 'rejected'

export interface WorkflowPatchProposal {
  id: string
  workflow_path: string
  unified_diff: string
  rationale: string
  status: PatchStatus
  created_at: string
}

export interface ProposeResult {
  proposalId: string
  threadId: string
}

/**
 * Propose a workflow patch. Creates a proposal row, a chat thread with a
 * validation message, and returns the ids. The validation message clears
 * from the projection when the proposal leaves 'awaiting-human'.
 */
export const stewardProposeWorkflowPatch = async (input: {
  workflowPath: string
  unifiedDiff: string
  rationale: string
  repoRoot?: string
}): Promise<ProposeResult> => {
  const { workflowPath, unifiedDiff, rationale } = input
  if (!workflowPath.startsWith('.mars/workflows/')) {
    throw new Error(
      `Steward may only propose patches to .mars/workflows/; got: ${workflowPath}`,
    )
  }

  const c = stateClient()
  const id = randomUUID()
  const ts = new Date().toISOString()

  await c.execute({
    sql: `INSERT INTO workflow_patch_proposals (id, workflow_path, unified_diff, rationale, status, created_at)
          VALUES (?, ?, ?, ?, 'awaiting-human', ?)`,
    args: [id, workflowPath, unifiedDiff, rationale, ts],
  })

  const thread = await createThread(`Workflow patch: ${workflowPath}`)
  const voicedRationale = renderMarsVoice(rationale)
  const body = `${voicedRationale}\n\n\`\`\`diff\n${unifiedDiff}\n\`\`\``
  await appendMessage(thread.id, 'assistant', body, undefined, {
    kind: 'validation',
    backingEntityId: id,
  })

  return { proposalId: id, threadId: thread.id }
}

/**
 * Apply an approved workflow patch. Reads the diff from the proposal,
 * applies it to the workflow file, and sets status='applied'.
 */
export const applyWorkflowPatch = async (
  proposalId: string,
  repoRoot: string,
): Promise<void> => {
  const c = stateClient()
  const { rows } = await c.execute({
    sql: `SELECT workflow_path, unified_diff, status FROM workflow_patch_proposals WHERE id = ?`,
    args: [proposalId],
  })
  if (rows.length === 0) throw new Error(`Proposal ${proposalId} not found`)
  const row = rows[0]!
  if (row.status !== 'awaiting-human') {
    throw new Error(`Proposal ${proposalId} is ${row.status}, not awaiting-human`)
  }

  const diff = row.unified_diff as string
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const tmpDir = await mkdtemp(join(tmpdir(), 'mars-patch-'))
  const patchFile = join(tmpDir, 'patch.diff')
  try {
    await writeFile(patchFile, diff, 'utf-8')
    await exec('git', ['apply', '--check', patchFile], { cwd: repoRoot })
    await exec('git', ['apply', patchFile], { cwd: repoRoot })
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  await c.execute({
    sql: `UPDATE workflow_patch_proposals SET status = 'applied' WHERE id = ?`,
    args: [proposalId],
  })
}

/**
 * Reject a workflow patch. Sets status='rejected' — nothing is applied.
 */
export const rejectWorkflowPatch = async (
  proposalId: string,
): Promise<void> => {
  const c = stateClient()
  const { rows } = await c.execute({
    sql: `SELECT status FROM workflow_patch_proposals WHERE id = ?`,
    args: [proposalId],
  })
  if (rows.length === 0) throw new Error(`Proposal ${proposalId} not found`)
  if (rows[0]!.status !== 'awaiting-human') {
    throw new Error(`Proposal ${proposalId} is ${rows[0]!.status}, not awaiting-human`)
  }

  await c.execute({
    sql: `UPDATE workflow_patch_proposals SET status = 'rejected' WHERE id = ?`,
    args: [proposalId],
  })
}

/**
 * Return the id of any open (awaiting-human) proposal for the given workflow
 * path, or null when none exists. Used by the arc-verifier to avoid creating
 * duplicate proposals while an operator decision is pending.
 */
export const findAwaitingProposalForPath = async (
  workflowPath: string,
): Promise<string | null> => {
  const c = stateClient()
  const { rows } = await c.execute({
    sql: `SELECT id FROM workflow_patch_proposals
          WHERE workflow_path = ? AND status = 'awaiting-human'
          LIMIT 1`,
    args: [workflowPath],
  })
  return rows.length > 0 ? (rows[0]!.id as string) : null
}

/**
 * Get a proposal by id.
 */
export const getWorkflowPatchProposal = async (
  proposalId: string,
): Promise<WorkflowPatchProposal | null> => {
  const c = stateClient()
  const { rows } = await c.execute({
    sql: `SELECT id, workflow_path, unified_diff, rationale, status, created_at
          FROM workflow_patch_proposals WHERE id = ?`,
    args: [proposalId],
  })
  if (rows.length === 0) return null
  const r = rows[0]!
  return {
    id: r.id as string,
    workflow_path: r.workflow_path as string,
    unified_diff: r.unified_diff as string,
    rationale: r.rationale as string,
    status: r.status as PatchStatus,
    created_at: r.created_at as string,
  }
}
