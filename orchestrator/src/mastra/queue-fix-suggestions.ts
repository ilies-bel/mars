import { randomUUID } from 'node:crypto'
import { computeFailureSignature } from './lib/failure-signature'
import { getClient, getTask, initQueue } from './queue'

const MAX_OCCURRENCES = 5
const TRUNCATION_MARKER = '\n[...]'

export const DEFAULT_RETRY_BUDGET = 1

export const getRetryBudget = (): number => {
  const raw = process.env.MARS_FIX_RETRY_BUDGET
  if (!raw) return DEFAULT_RETRY_BUDGET
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_BUDGET
  return Math.floor(n)
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const buildFixPromptBody = ({
  sourceTaskId,
  failingStep,
  failureSignature,
  truncatedError,
  branch,
  occurrence,
}: {
  sourceTaskId: string
  failingStep: string
  failureSignature: string
  truncatedError: string
  branch: string | null
  occurrence: string
}): string => {
  return [
    `Fix the failure that blocked task ${sourceTaskId}.`,
    '',
    `Failing step: ${failingStep}`,
    `Failure signature: ${failureSignature}`,
    branch ? `Branch: ${branch}` : null,
    '',
    `Occurrences:`,
    `- ${occurrence}`,
    '',
    `First error output (truncated):`,
    '```',
    truncatedError,
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const appendOccurrence = (existingPrompt: string, occurrence: string): string => {
  const occHeader = 'Occurrences:'
  const idx = existingPrompt.indexOf(occHeader)
  if (idx === -1) {
    // Fall back to appending at the end with a marker.
    return `${existingPrompt}\n\nOccurrences:\n- ${occurrence}`
  }
  // Identify lines after the header until a blank line.
  const lines = existingPrompt.split('\n')
  let headerLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === occHeader) {
      headerLine = i
      break
    }
  }
  if (headerLine === -1) {
    return `${existingPrompt}\n\nOccurrences:\n- ${occurrence}`
  }
  let endLine = headerLine + 1
  const occurrences: string[] = []
  while (endLine < lines.length && lines[endLine].startsWith('- ')) {
    occurrences.push(lines[endLine])
    endLine++
  }
  // Skip if already at cap.
  let truncated = false
  if (occurrences.length >= MAX_OCCURRENCES) {
    truncated = true
  } else {
    occurrences.push(`- ${occurrence}`)
  }
  const next = [
    ...lines.slice(0, headerLine + 1),
    ...occurrences,
    ...(truncated ? [TRUNCATION_MARKER.trimStart()] : []),
    ...lines.slice(endLine),
  ]
  return next.join('\n')
}

export interface UpsertFixSuggestionInput {
  sourceTaskId: string
  failureSignature: string
  failingStep: string
  truncatedError: string
  branch: string | null
}

export interface UpsertFixSuggestionResult {
  id: string
  created: boolean
}

export const upsertFixSuggestion = async (
  input: UpsertFixSuggestionInput,
): Promise<UpsertFixSuggestionResult> => {
  await initQueue()
  const c = getClient()
  const now = new Date().toISOString()
  const occurrence = `${now} step=${input.failingStep}`

  const existing = await c.execute({
    sql: `SELECT id, prompt FROM task_suggestions
           WHERE source_task_id = ?
             AND kind = 'fix'
             AND failure_signature = ?
             AND status IN ('proposed','accepted')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [input.sourceTaskId, input.failureSignature],
  })

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as unknown as { id: string; prompt: string }
    const nextPrompt = appendOccurrence(row.prompt, occurrence)
    await c.execute({
      sql: `UPDATE task_suggestions SET prompt = ? WHERE id = ?`,
      args: [nextPrompt, row.id],
    })
    return { id: row.id, created: false }
  }

  const id = randomUUID().slice(0, 8)
  const truncatedError = truncate(input.truncatedError, 2000)
  const title = `Fix: ${truncate(input.failingStep, 40)} (${input.failureSignature})`
  const prompt = buildFixPromptBody({
    sourceTaskId: input.sourceTaskId,
    failingStep: input.failingStep,
    failureSignature: input.failureSignature,
    truncatedError,
    branch: input.branch,
    occurrence,
  })
  const rationale = `Auto-created by failure-handler for task ${input.sourceTaskId}.`
  await c.execute({
    sql: `INSERT INTO task_suggestions (id, source_task_id, title, prompt, rationale, status, kind, failure_signature, created_at)
           VALUES (?, ?, ?, ?, ?, 'proposed', 'fix', ?, ?)`,
    args: [id, input.sourceTaskId, title, prompt, rationale, input.failureSignature, now],
  })
  return { id, created: true }
}

export const markTaskDropped = async (
  taskId: string,
  reason: string,
): Promise<void> => {
  await initQueue()
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `UPDATE tasks SET status = 'dropped', drop_reason = ?, updated_at = ? WHERE id = ?`,
    args: [reason, now, taskId],
  })
}

const blockTaskWithSuggestion = async (
  taskId: string,
  suggestionId: string,
  nextRetryCount: number,
  errorSummary: string,
): Promise<void> => {
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `UPDATE tasks
             SET status = 'blocked',
                 blocker_id = ?,
                 retry_count = ?,
                 error = ?,
                 updated_at = ?
           WHERE id = ?`,
    args: [suggestionId, nextRetryCount, errorSummary, now, taskId],
  })
}

export interface HandleTaskFailureInput {
  taskId: string
  failingStep: string
  errorOutput: string
  branch?: string | null
}

export interface HandleTaskFailureResult {
  outcome: 'blocked' | 'dropped' | 'noop'
  suggestionId?: string
  failureSignature?: string
  retryCount?: number
}

export const handleTaskFailure = async (
  input: HandleTaskFailureInput,
): Promise<HandleTaskFailureResult> => {
  await initQueue()
  const task = await getTask(input.taskId)
  if (!task) return { outcome: 'noop' }

  const failureSignature = computeFailureSignature(
    input.failingStep,
    input.errorOutput,
  )
  const budget = getRetryBudget()

  if (task.retryCount >= budget) {
    await markTaskDropped(
      input.taskId,
      `retry_budget_exhausted:${failureSignature}`,
    )
    return {
      outcome: 'dropped',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  const truncatedError = input.errorOutput.slice(0, 2000)
  const branch = input.branch ?? task.branch
  const { id: suggestionId } = await upsertFixSuggestion({
    sourceTaskId: input.taskId,
    failureSignature,
    failingStep: input.failingStep,
    truncatedError,
    branch,
  })

  const nextRetryCount = task.retryCount + 1
  const errorSummary = truncate(
    `${input.failingStep}: ${input.errorOutput}`,
    1000,
  )
  await blockTaskWithSuggestion(
    input.taskId,
    suggestionId,
    nextRetryCount,
    errorSummary,
  )
  return {
    outcome: 'blocked',
    suggestionId,
    failureSignature,
    retryCount: nextRetryCount,
  }
}
