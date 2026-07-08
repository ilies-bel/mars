/**
 * Self-authored workflow provenance (ADR-0068).
 *
 * An agent-authored workflow file lands on disk as an **agent draft**: it is
 * stamped with two header comment lines —
 *
 * ```js
 * // @mars-workflow-author: agent:<name>
 * // @mars-workflow-draft: pending-approval
 * ```
 *
 * The author marker is permanent (it survives approval, for audit). The draft
 * marker is the dispatch gate: while it is present, `loadWorkflowByName`
 * refuses to dispatch the workflow with a pending-approval
 * `WorkflowLoadError` (preserving ADR-0067's hard-fail-no-fallback contract),
 * and `mars workflow list` reports the file as `agent-draft (pending
 * approval)`. `mars workflow approve <name>` removes the draft marker — the
 * single moment agent-written JS becomes operator-privileged. After approval
 * the file classifies as an ordinary user-owned `custom` workflow.
 *
 * Markers are only honoured within the leading {@link MARKER_SCAN_LINES}
 * lines of the file, so a marker-shaped string deeper in the body (e.g.
 * inside a prompt) neither strands a file as a draft nor gets rewritten by
 * approval.
 */

export const WORKFLOW_AUTHOR_MARKER_PREFIX = '// @mars-workflow-author:'
export const WORKFLOW_DRAFT_MARKER = '// @mars-workflow-draft: pending-approval'

/**
 * The action-queue kind raised for a pending agent draft. Level-triggered
 * (ADR-0048): raised when `mars workflow author` lands a draft (idempotent —
 * re-raises on the same workflow name bump `seen_count`), superseded when
 * `mars workflow approve` privileges the file.
 */
export const WORKFLOW_DRAFT_ACTION_QUEUE_KIND = 'workflow-draft-pending' as const

/** Only the leading lines of the file are scanned for provenance markers. */
const MARKER_SCAN_LINES = 10

export interface WorkflowProvenance {
  /** The stamped author id (e.g. `agent:cli`), or null when unstamped. */
  author: string | null
  /** True while the draft marker is present — the file is NOT dispatch-eligible. */
  pendingApproval: boolean
}

/** Read the provenance markers from a workflow file's source text. */
export const readWorkflowProvenance = (source: string): WorkflowProvenance => {
  const head = source.split('\n', MARKER_SCAN_LINES)
  let author: string | null = null
  let pendingApproval = false
  for (const rawLine of head) {
    const line = rawLine.trim()
    if (line.startsWith(WORKFLOW_AUTHOR_MARKER_PREFIX)) {
      const value = line.slice(WORKFLOW_AUTHOR_MARKER_PREFIX.length).trim()
      if (value.length > 0) author = value
    }
    if (line === WORKFLOW_DRAFT_MARKER) pendingApproval = true
  }
  return { author, pendingApproval }
}

/**
 * Prepend the agent-draft provenance header to an authored body. The result
 * is exactly what `mars workflow author` writes to disk (and what the
 * author-time dry-run validates, so validated bytes === landed bytes).
 */
export const stampAgentDraft = (body: string, author: string): string =>
  `${WORKFLOW_AUTHOR_MARKER_PREFIX} ${author}\n${WORKFLOW_DRAFT_MARKER}\n${body}`

/**
 * Produce the approved source: the draft marker line is removed from the
 * leading scan window; the author marker (and everything else) is preserved
 * byte-for-byte. Idempotent on already-approved sources.
 */
export const approveDraftSource = (source: string): string => {
  const lines = source.split('\n')
  const result: string[] = []
  for (const [i, line] of lines.entries()) {
    if (i < MARKER_SCAN_LINES && line.trim() === WORKFLOW_DRAFT_MARKER) continue
    result.push(line)
  }
  return result.join('\n')
}
