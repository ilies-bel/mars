import { randomBytes } from 'node:crypto'
import type { Author, AuthorKind } from './author'
import { resolveStateClient } from './store/state-client'
import { buildEventInsert } from './lib/outbox'
import { withTransaction, type DbClient } from './lib/db.js'
import { ensureSchema } from './lib/pg-schema.js'
import type { EventName, EventPayload } from '../bus/events.js'

/**
 * Which subsystem produced a proposal. One value per producer — `source` is
 * the only column that answers "who wrote this row", so two subsystems sharing
 * a value makes the field useless for exactly the question it exists to answer.
 *
 * - `reflection`        — the reflector (`mars reflect`, `mars arc reflect`,
 *                         and the reflection-family auto-triggers).
 * - `arc-verifier`      — the arc-outcome verifier (`core/lib/arc-verifier.ts`).
 * - `failure-reflector` — the per-failure reflector.
 * - `skill-forge`       — the skill forge.
 * - `planner`           — the planner.
 * - `human`             — an operator, via the CLI or UI.
 */
export type ProposalSource =
  | 'reflection'
  | 'arc-verifier'
  | 'human'
  | 'planner'
  | 'skill-forge'
  | 'failure-reflector'

export const PROPOSAL_STATUSES = [
  'draft',
  'prd-ready',
  'slicing',
  'sliced',
  'taken',
  'dismissed',
] as const

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export interface Proposal {
  id: string
  title: string
  problem: string
  solution: string
  outOfScope: string
  notes: string
  status: ProposalStatus
  source: ProposalSource
  coordinated: boolean
  autoApprove: boolean
  author: Author | null
  createdAt: number
  updatedAt: number
  userStories: string[]
}

/**
 * The state-domain DB client, resolved through the shared seam-internal
 * resolver (`store/state-client`). Same embedded-PostgreSQL database as the
 * TaskStore (ADR-0034); the three formerly-duplicated private singletons now
 * collapse to this one.
 *
 * Module-internal only — the public seam is the StateStore
 * (`store/state-store.ts`). No raw client crosses the module boundary
 * (ADR-0021); the old `getProposalsClient()` escape hatch is gone, and the
 * slicer's cross-table coordination routes through the StateStore.
 */
const stateClient = (): DbClient => resolveStateClient()

/**
 * Emit a proposal lifecycle event to the events outbox.
 *
 * Proposals and the events outbox live in the same database (ADR-0034). This
 * emits in a separate write transaction (via the TaskStore seam's `atomic`)
 * after the proposal write has committed. Emission failures are non-fatal:
 * the proposal operation succeeds regardless.
 */
async function emitProposalBusEvent<T extends EventName>(
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  try {
    const { getDefaultTaskStore } = await import('./store/task-store')
    const store = await getDefaultTaskStore()
    await store.atomic(async (scope) => {
      await scope.execute(buildEventInsert(type, payload))
    })
  } catch {
    // Non-fatal: proposal state change already committed.
  }
}

let initialised = false

export const initProposals = async (): Promise<void> => {
  if (initialised) return
  // DDL lives in core/lib/pg-schema.ts (migration 0002): one canonical schema
  // covering the proposal AND task domains, so this single call replaces both
  // the old proposal DDL and the chained queue-schema migration. The
  // SQLite-era in-place migration history (ideas→proposals renames,
  // goal/story/technical backfills, the task_suggestions lift) is captured
  // once by the importer (init/import-sqlite.ts), not replayed here.
  await ensureSchema(stateClient())
  initialised = true
}

const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'proposal'
}

export const generateProposalId = (title: string): string => {
  const prefix = randomBytes(4).toString('hex')
  return `${prefix}-${slugify(title)}`
}

export const VALID_SOURCES: readonly ProposalSource[] = [
  'reflection',
  'arc-verifier',
  'human',
  'planner',
  'skill-forge',
  'failure-reflector',
]

/**
 * Type guard over the canonical producer list. Exported so every reader
 * narrows against the SAME set — a reader that hardcodes a subset silently
 * rewrites unknown producers to 'human' and loses the provenance.
 */
export const isProposalSource = (raw: unknown): raw is ProposalSource =>
  typeof raw === 'string' && (VALID_SOURCES as readonly string[]).includes(raw)

const normaliseSource = (raw: unknown): ProposalSource => {
  if (isProposalSource(raw)) return raw
  return 'human'
}

const isProposalStatus = (raw: unknown): raw is ProposalStatus =>
  typeof raw === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(raw)

const assertValidProposalStatus = (raw: unknown): ProposalStatus => {
  if (isProposalStatus(raw)) return raw
  throw new Error(
    `invalid proposal status '${String(raw)}'; expected one of ${PROPOSAL_STATUSES.join(', ')}`,
  )
}

const assertValidSource = (raw: unknown): ProposalSource => {
  if (isProposalSource(raw)) return raw
  throw new Error(
    `invalid proposal source '${String(raw)}'; expected one of ${VALID_SOURCES.join(', ')}`,
  )
}

const rowToProposal = (
  row: Record<string, unknown>,
  userStories: string[],
): Proposal => {
  const authorKindRaw = (row.author_kind as string | null) ?? null
  const authorName = (row.author_name as string | null) ?? null
  const author: Author | null =
    authorKindRaw === 'human' || authorKindRaw === 'agent'
      ? { kind: authorKindRaw as AuthorKind, name: authorName ?? 'unknown' }
      : null
  return {
    id: row.id as string,
    title: (row.title as string | null) ?? '',
    problem: (row.problem as string | null) ?? '',
    solution: (row.solution as string | null) ?? '',
    outOfScope: (row.out_of_scope as string | null) ?? '',
    notes: (row.notes as string | null) ?? '',
    status: assertValidProposalStatus((row.status as string | null) ?? 'draft'),
    source: normaliseSource(row.source),
    coordinated: row.coordinated === true,
    autoApprove: row.auto_approve === true,
    author,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    userStories,
  }
}

const loadUserStories = async (
  c: DbClient,
  proposalId: string,
): Promise<string[]> => {
  const r = await c.execute({
    sql: `SELECT text FROM proposal_user_stories WHERE proposal_id = ? ORDER BY position ASC`,
    args: [proposalId],
  })
  return r.rows.map((row) => (row as unknown as { text: string }).text)
}

export interface CreateProposalOptions {
  author?: Author
  source?: ProposalSource
  problem?: string
  solution?: string
  outOfScope?: string
  notes?: string
  kpiTag?: string
  /** Stable fingerprint for root-cause dedup across reflection runs. */
  fingerprint?: string
  /**
   * UUID of the originating Claude Code operator session, captured from
   * `CLAUDE_CODE_SESSION_ID` at the CLI boundary.  NULL when the proposal
   * is created outside a Claude Code session.
   */
  originSessionId?: string | null
}

export const createProposal = async (
  title: string,
  opts?: CreateProposalOptions,
): Promise<Proposal> => {
  await initProposals()
  const c = stateClient()
  const id = generateProposalId(title)
  const now = Date.now()
  const source: ProposalSource =
    opts?.source !== undefined
      ? assertValidSource(opts.source)
      : opts?.author?.kind === 'agent'
        ? 'planner'
        : 'human'
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  const problem = opts?.problem ?? ''
  const solution = opts?.solution ?? ''
  const outOfScope = opts?.outOfScope ?? ''
  const notes = opts?.notes ?? ''
  const kpiTag = opts?.kpiTag ?? null
  const fingerprint = opts?.fingerprint ?? null
  const originSessionId = opts?.originSessionId ?? null
  await c.execute({
    sql: `INSERT INTO proposals
            (id, title, problem, solution, out_of_scope, notes,
             status, source, author_kind, author_name,
             kpi_tag, fingerprint, origin_session_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      title,
      problem,
      solution,
      outOfScope,
      notes,
      source,
      authorKind,
      authorName,
      kpiTag,
      fingerprint,
      originSessionId,
      now,
      now,
    ],
  })
  const proposal: Proposal = {
    id,
    title,
    problem,
    solution,
    outOfScope,
    notes,
    status: 'draft',
    source,
    coordinated: false,
    autoApprove: false,
    author: opts?.author ?? null,
    createdAt: now,
    updatedAt: now,
    userStories: [],
  }
  await emitProposalBusEvent('proposal.added', { proposalId: id, source, title })
  return proposal
}

export interface ListProposalsFilter {
  source?: ProposalSource
  status?: string
}

export type ProposalIdResolution =
  | { kind: 'unique'; id: string }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' }

const MIN_PREFIX_LENGTH = 4

export const resolveProposalId = async (
  idOrPrefix: string,
): Promise<ProposalIdResolution> => {
  await initProposals()
  const c = stateClient()
  const exact = await c.execute({
    sql: `SELECT id FROM proposals WHERE id = ?`,
    args: [idOrPrefix],
  })
  if (exact.rows.length === 1) {
    return { kind: 'unique', id: (exact.rows[0] as unknown as { id: string }).id }
  }
  if (idOrPrefix.length < MIN_PREFIX_LENGTH) return { kind: 'none' }
  const prefixMatch = await c.execute({
    sql: `SELECT id FROM proposals WHERE id LIKE ? || '%' LIMIT 2`,
    args: [idOrPrefix],
  })
  if (prefixMatch.rows.length === 0) return { kind: 'none' }
  if (prefixMatch.rows.length === 1) {
    return {
      kind: 'unique',
      id: (prefixMatch.rows[0] as unknown as { id: string }).id,
    }
  }
  const total = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM proposals WHERE id LIKE ? || '%'`,
    args: [idOrPrefix],
  })
  const count = Number(
    (total.rows[0] as unknown as { n: number | bigint }).n ?? 2,
  )
  return { kind: 'ambiguous', count }
}

export const getProposal = async (
  idOrPrefix: string,
): Promise<Proposal | null> => {
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind !== 'unique') return null
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT * FROM proposals WHERE id = ?`,
    args: [resolved.id],
  })
  if (r.rows.length === 0) return null
  const userStories = await loadUserStories(c, resolved.id)
  return rowToProposal(
    r.rows[0] as unknown as Record<string, unknown>,
    userStories,
  )
}

/**
 * ADR-0008 planning-graph edge writer. Adds `proposal_dependencies` rows so
 * `proposalId` waits on each `blockerId`. Mirrors `addBlockers` in queue.ts:
 * the subject and every blocker id must already exist, self-edges are
 * refused (a proposal cannot block itself), duplicates are de-duped, and the
 * insert is `ON CONFLICT DO NOTHING` so re-adding an existing edge is a no-op.
 * Ids are resolved through `resolveProposalId` so prefixes work like every
 * other proposal verb.
 */
export const addProposalDependencies = async (
  proposalIdOrPrefix: string,
  blockerIdsOrPrefixes: readonly string[],
): Promise<void> => {
  if (blockerIdsOrPrefixes.length === 0) return
  await initProposals()
  const c = stateClient()

  const subject = await resolveProposalId(proposalIdOrPrefix)
  if (subject.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${proposalIdOrPrefix}' matches ${subject.count} proposals`,
    )
  }
  if (subject.kind === 'none') {
    throw new Error(`proposal ${proposalIdOrPrefix} not found`)
  }
  const proposalId = subject.id

  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of blockerIdsOrPrefixes) {
    const resolved = await resolveProposalId(raw)
    if (resolved.kind === 'ambiguous') {
      throw new Error(
        `ambiguous prefix '${raw}' matches ${resolved.count} proposals`,
      )
    }
    if (resolved.kind === 'none') {
      throw new Error(`blocker ${raw} not found`)
    }
    const id = resolved.id
    if (id === proposalId) {
      throw new Error(`proposal ${proposalId} cannot block itself`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }

  if (unique.length === 0) return
  const now = new Date().toISOString()
  const stmts = unique.map((blockerId) => ({
    sql: `INSERT INTO proposal_dependencies (proposal_id, blocker_proposal_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [proposalId, blockerId, now],
  }))
  await c.batch(stmts, 'write')
}

/**
 * List the proposal ids that `proposalIdOrPrefix` is blocked by (its
 * `proposal_dependencies` blockers). Returns blocker ids ordered by edge
 * creation time. Unlike `listBlockers` in queue.ts this does not filter on
 * blocker status — the planning graph wants every declared edge; status
 * filtering is the planner's concern, not this reader's.
 */
export const listProposalDependencies = async (
  proposalIdOrPrefix: string,
): Promise<string[]> => {
  await initProposals()
  const resolved = await resolveProposalId(proposalIdOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${proposalIdOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${proposalIdOrPrefix} not found`)
  }
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT blocker_proposal_id AS id
            FROM proposal_dependencies
           WHERE proposal_id = ?
           ORDER BY created_at ASC`,
    args: [resolved.id],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

/**
 * Remove a single `proposal_dependencies` edge. Mirrors `removeBlocker` in
 * queue.ts: reports `removed:false` when the (proposal, blocker) pair did
 * not exist. Both ids are resolved through `resolveProposalId`.
 */
export const removeProposalDependency = async (
  proposalIdOrPrefix: string,
  blockerIdOrPrefix: string,
): Promise<{ removed: boolean }> => {
  await initProposals()
  const subject = await resolveProposalId(proposalIdOrPrefix)
  if (subject.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${proposalIdOrPrefix}' matches ${subject.count} proposals`,
    )
  }
  if (subject.kind === 'none') {
    throw new Error(`proposal ${proposalIdOrPrefix} not found`)
  }
  const blocker = await resolveProposalId(blockerIdOrPrefix)
  if (blocker.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${blockerIdOrPrefix}' matches ${blocker.count} proposals`,
    )
  }
  if (blocker.kind === 'none') {
    throw new Error(`blocker ${blockerIdOrPrefix} not found`)
  }
  const c = stateClient()
  const r = await c.execute({
    sql: `DELETE FROM proposal_dependencies WHERE proposal_id = ? AND blocker_proposal_id = ?`,
    args: [subject.id, blocker.id],
  })
  return { removed: r.rowsAffected > 0 }
}

export const listProposals = async (
  filter?: ListProposalsFilter,
): Promise<Proposal[]> => {
  await initProposals()
  const c = stateClient()
  const where: string[] = []
  const args: unknown[] = []
  if (filter?.source) {
    where.push('source = ?')
    args.push(filter.source)
  }
  if (filter?.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  const sql = `SELECT * FROM proposals${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC`
  const r =
    args.length > 0
      ? await c.execute({ sql, args: args as never })
      : await c.execute(sql)
  const proposals: Proposal[] = []
  for (const row of r.rows) {
    const r2 = row as unknown as Record<string, unknown>
    const userStories = await loadUserStories(c, r2.id as string)
    proposals.push(rowToProposal(r2, userStories))
  }
  return proposals
}

export type ProposalField =
  | 'title'
  | 'problem'
  | 'solution'
  | 'out-of-scope'
  | 'notes'
  | 'status'

const fieldColumn: Record<ProposalField, string> = {
  title: 'title',
  problem: 'problem',
  solution: 'solution',
  'out-of-scope': 'out_of_scope',
  notes: 'notes',
  status: 'status',
}

export const setProposalField = async (
  idOrPrefix: string,
  field: ProposalField,
  value: string,
): Promise<Proposal> => {
  await initProposals()
  if (field === 'status') assertValidProposalStatus(value)
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  const c = stateClient()
  const now = Date.now()
  await c.execute({
    sql: `UPDATE proposals SET ${fieldColumn[field]} = ?, updated_at = ? WHERE id = ?`,
    args: [value, now, id],
  })
  const updated = await getProposal(id)
  if (!updated) {
    throw new Error(`proposal ${id} disappeared after update`)
  }
  return updated
}

export const setProposalCoordinated = async (
  idOrPrefix: string,
  value: boolean,
): Promise<Proposal> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  await stateClient().execute({
    sql: `UPDATE proposals SET coordinated = ?, updated_at = ? WHERE id = ?`,
    args: [value, Date.now(), resolved.id],
  })
  const updated = await getProposal(resolved.id)
  if (!updated) {
    throw new Error(`proposal ${resolved.id} disappeared after update`)
  }
  return updated
}

export const addProposalUserStory = async (
  idOrPrefix: string,
  story: string,
): Promise<Proposal> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  const c = stateClient()
  const positionRow = await c.execute({
    sql: `SELECT COALESCE(MAX(position), -1) AS max_pos FROM proposal_user_stories WHERE proposal_id = ?`,
    args: [id],
  })
  const maxPos = Number(
    (positionRow.rows[0] as unknown as { max_pos: number | string }).max_pos ??
      -1,
  )
  const next = Number.isFinite(maxPos) ? maxPos + 1 : 0
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO proposal_user_stories (proposal_id, position, text) VALUES (?, ?, ?)`,
    args: [id, next, story],
  })
  await c.execute({
    sql: `UPDATE proposals SET updated_at = ? WHERE id = ?`,
    args: [now, id],
  })
  const updated = await getProposal(id)
  if (!updated) {
    throw new Error(`proposal ${id} disappeared after update`)
  }
  return updated
}

export const removeProposalUserStory = async (
  idOrPrefix: string,
  index: number,
): Promise<Proposal> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  const c = stateClient()
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`user-story index must be a non-negative integer`)
  }
  await withTransaction(c, async (tx) => {
    const target = await tx.execute({
      sql: `SELECT position FROM proposal_user_stories WHERE proposal_id = ? AND position = ?`,
      args: [id, index],
    })
    if (target.rows.length === 0) {
      throw new Error(`proposal ${id} has no user story at index ${index}`)
    }
    await tx.execute({
      sql: `DELETE FROM proposal_user_stories WHERE proposal_id = ? AND position = ?`,
      args: [id, index],
    })
    await tx.execute({
      sql: `UPDATE proposal_user_stories
            SET position = position - 1
            WHERE proposal_id = ? AND position > ?`,
      args: [id, index],
    })
    const now = Date.now()
    await tx.execute({
      sql: `UPDATE proposals SET updated_at = ? WHERE id = ?`,
      args: [now, id],
    })
  })
  const updated = await getProposal(id)
  if (!updated) {
    throw new Error(`proposal ${id} disappeared after update`)
  }
  return updated
}

export const validateProposalShaped = (proposal: Proposal): string[] => {
  const missing: string[] = []
  if (proposal.title.trim().length === 0) missing.push('title')
  if (proposal.problem.trim().length === 0) missing.push('problem')
  if (proposal.solution.trim().length === 0) missing.push('solution')
  if (proposal.userStories.length === 0) missing.push('user stories (>=1)')
  return missing
}

/**
 * Mark a draft proposal as PRD-ready. The proposal row stays alive as the
 * PRD; tasks get created separately (one per slice) with
 * parent_proposal_id set. No tasks are inserted here — that's the slicer's
 * job.
 */
export const promoteProposal = async (
  idOrPrefix: string,
  options: { autoApprove?: boolean; coordinated?: boolean } = {},
): Promise<Proposal> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const proposal = await getProposal(resolved.id)
  if (!proposal) {
    throw new Error(`proposal ${resolved.id} not found`)
  }
  if (proposal.status !== 'draft') {
    throw new Error(
      `proposal ${proposal.id} is '${proposal.status}'; only draft proposals can be promoted`,
    )
  }
  const missing = validateProposalShaped(proposal)
  if (missing.length > 0) {
    throw new Error(
      `proposal ${proposal.id} is not fully shaped; missing: ${missing.join(', ')}`,
    )
  }
  const c = stateClient()
  const now = Date.now()
  await c.execute({
    sql: `UPDATE proposals
          SET status = 'prd-ready',
              auto_approve = ?,
              coordinated = CASE WHEN ? THEN true ELSE coordinated END,
              updated_at = ?
          WHERE id = ?`,
    args: [options.autoApprove === true, options.coordinated === true, now, proposal.id],
  })
  await emitProposalBusEvent('proposal.promoted', { proposalId: proposal.id })
  const updated = await getProposal(proposal.id)
  if (!updated) {
    throw new Error(`proposal ${proposal.id} disappeared after promotion`)
  }
  return updated
}

// Direct DB write — deletion has no worktree/merge side effects. Removes
// the row from `proposals`; `proposal_user_stories` rows cascade away via
// the FK declared in initProposals.
export const deleteProposal = async (idOrPrefix: string): Promise<string> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  // ADR-0015 dismiss-refusal also applies to outright deletion: a deleted
  // proposal still referenced by task_proposal_blockers would strand the
  // dependent task on a gate that can never resolve. Same no-auto-cascade
  // rule — surface the dependents so the user redirects/drops them first.
  const { listTasksBlockedByProposal } = await import('./queue')
  const dependents = await listTasksBlockedByProposal(id)
  if (dependents.length > 0) {
    throw new Error(
      `proposal ${id} cannot be deleted: ${dependents.length} task(s) are blocked by it: ${dependents.join(', ')}. ` +
        `Redirect or drop those tasks first (e.g. 'mars unblock <task-id> ${id}' or 'mars drop <task-id>').`,
    )
  }
  const c = stateClient()
  // Older DBs were created before the FK existed, so wipe the children
  // explicitly to keep cleanup deterministic across schema vintages.
  await c.execute({
    sql: `DELETE FROM proposal_user_stories WHERE proposal_id = ?`,
    args: [id],
  })
  // proposal_dependencies (ADR-0008 planning-graph edges) has an
  // ON DELETE CASCADE FK on both endpoints, but older DBs predate the FK,
  // so wipe edges on either side explicitly for deterministic cleanup
  // across schema vintages — mirrors the proposal_user_stories handling.
  await c.execute({
    sql: `DELETE FROM proposal_dependencies WHERE proposal_id = ? OR blocker_proposal_id = ?`,
    args: [id, id],
  })
  const r = await c.execute({
    sql: `DELETE FROM proposals WHERE id = ?`,
    args: [id],
  })
  if (r.rowsAffected === 0) {
    throw new Error(`proposal ${id} not found`)
  }
  // Clear any open plan-approval row for this proposal (raised by the slice
  // workflow when the proposal was sliced). The row is signature-keyed so
  // it is not caught by the origin-keyed eviction path in the repopulator.
  try {
    const { supersedeActionQueueItemsBySignature } = await import('./lib/action-queue')
    await supersedeActionQueueItemsBySignature(
      'plan-approval',
      id,
      'origin-purged',
      'proposal.delete',
    )
  } catch {
    // Best-effort — deletion succeeds regardless of row-cleanup failure.
  }
  await emitProposalBusEvent('proposal.deleted', { proposalId: id })
  return id
}

// Direct DB write — dismissal is a pure status flip with no side effects
// (no worktree, no merge), so it does not need to go through the daemon.
export const dismissProposal = async (
  idOrPrefix: string,
): Promise<Proposal> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  // ADR-0015: refuse the dismiss while ANY task still depends on this proposal
  // via task_proposal_blockers. Do NOT auto-cascade — surface the dependent
  // task ids so the user explicitly redirects or drops them. This check
  // runs BEFORE the status flip so a refused dismiss leaves the proposal
  // untouched (still 'draft'). task_proposal_blockers lives in the separate
  // task domain, hence the cross-module read.
  const { listTasksBlockedByProposal } = await import('./queue')
  const dependents = await listTasksBlockedByProposal(id)
  if (dependents.length > 0) {
    throw new Error(
      `proposal ${id} cannot be dismissed: ${dependents.length} task(s) are blocked by it: ${dependents.join(', ')}. ` +
        `Redirect or drop those tasks first (e.g. 'mars unblock <task-id> ${id}' or 'mars drop <task-id>').`,
    )
  }
  const c = stateClient()
  const now = Date.now()
  const r = await c.execute({
    sql: `UPDATE proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'draft'`,
    args: [now, id],
  })
  if (r.rowsAffected === 0) {
    const current = await getProposal(id)
    if (!current) throw new Error(`proposal ${id} not found`)
    throw new Error(
      `proposal ${id} is '${current.status}'; only draft proposals can be dismissed`,
    )
  }
  await emitProposalBusEvent('proposal.dismissed', { proposalId: id })
  const updated = await getProposal(id)
  if (!updated) {
    throw new Error(`proposal ${id} disappeared after dismissal`)
  }
  return updated
}

/**
 * Return the most recent open (status='draft') reflection-sourced proposal
 * tagged with the given KPI identifier, or null if none exists.
 *
 * Used by the KPI-drift trigger to skip raising a duplicate draft when an
 * operator has not yet acted on a prior reflection for the same KPI.
 */
/**
 * Return the most recent open (status='draft') proposal carrying the given
 * `kpi_tag`, regardless of source. The `kpi_tag` column doubles as a generic
 * dedup fingerprint carrier: the behaviour-verify step stamps its fallback
 * drafts with `behaviour-verify:<originId>` so re-runs of the same task arc
 * find the existing draft instead of fanning out siblings.
 */
export const findOpenDraftByKpiTag = async (
  kpiTag: string,
): Promise<{ id: string; title: string } | null> => {
  await initProposals()
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT id, title FROM proposals
           WHERE status = 'draft'
             AND kpi_tag = ?
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [kpiTag],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { id: string; title: string }
  return { id: row.id, title: row.title }
}

export const findOpenReflectionDraftForKpi = async (
  kpi: string,
): Promise<{ id: string; title: string } | null> => {
  await initProposals()
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT id, title FROM proposals
           WHERE source = 'reflection'
             AND status = 'draft'
             AND kpi_tag = ?
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [kpi],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { id: string; title: string }
  return { id: row.id, title: row.title }
}

/**
 * Return the most recent open (status='draft') reflection-sourced proposal
 * with the given fingerprint, or null if none exists.
 *
 * Used by the reflector's persist path to merge evidence from subsequent runs
 * into the same draft instead of emitting duplicate proposals for the same
 * root cause.
 */
export const findOpenReflectionDraftByFingerprint = async (
  fingerprint: string,
  source: ProposalSource = 'reflection',
): Promise<{ id: string; notes: string } | null> => {
  await initProposals()
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT id, notes FROM proposals
           WHERE source = ?
             AND status = 'draft'
             AND fingerprint = ?
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [source, fingerprint],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { id: string; notes: string }
  return { id: row.id, notes: row.notes ?? '' }
}

/**
 * Append a line of text to a proposal's notes field. Idempotent in the sense
 * that each call adds a newline-separated block; it does not deduplicate the
 * content itself. Used by the reflector to accumulate evidence from multiple
 * runs into a single open draft.
 */
export const appendProposalNotes = async (
  id: string,
  addition: string,
): Promise<void> => {
  await initProposals()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE proposals
             SET notes = CASE WHEN notes = '' OR notes IS NULL
                              THEN ?
                              ELSE notes || chr(10) || ?
                         END,
                 updated_at = ?
           WHERE id = ?`,
    args: [addition, addition, Date.now(), id],
  })
}

/**
 * Atomically claim a 'prd-ready' proposal for slicing by flipping its status
 * to the intermediate 'slicing' marker. The conditional UPDATE is the only
 * defence against the prd-ready→sliced TOCTOU race: two concurrent slice
 * triggers (e.g. promote auto-slice + a manual `mars proposal slice` RPC, or
 * a slice that overlaps with a daemon restart) both used to read 'prd-ready'
 * and BOTH generated a full slice-set because the status flip only fired
 * after the slow Slicer LLM call completed. With the claim, the second
 * caller's UPDATE matches zero rows and the call must abort before doing any
 * slicer work or task inserts.
 *
 * Returns true iff exactly one row was updated — i.e. this caller won the
 * claim. A false return means the proposal is not 'prd-ready' (already
 * 'slicing', already 'sliced', or in some other lifecycle state). The
 * complementary `markProposalSliced` completes the flip from 'slicing' to
 * 'sliced'; the slice workflow's compensating revert path returns it to
 * 'prd-ready' on failure so a crashed/failed slice is re-claimable.
 */
export const claimProposalForSlicing = async (
  idOrPrefix: string,
): Promise<boolean> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  const c = stateClient()
  const r = await c.execute({
    sql: `UPDATE proposals SET status = 'slicing', updated_at = ? WHERE id = ? AND status = 'prd-ready'`,
    args: [Date.now(), id],
  })
  return r.rowsAffected === 1
}

/**
 * Flip a proposal's status from 'slicing' to 'sliced' and emit
 * proposal.sliced on the event bus. Called by the slice workflow's
 * generate-slices step (Phase 4) after tasks have been successfully
 * inserted into the task table. The conditional UPDATE (status='slicing')
 * pairs with `claimProposalForSlicing` so only the caller that holds the
 * claim can finalise the transition — a stale caller whose claim was
 * already reverted by a compensating path will see zero rows updated.
 * Emitting the event here — in proposals.ts, alongside the other
 * lifecycle transitions — keeps proposal state management centralised.
 */
/**
 * Approve a 'sliced' proposal's plan: transition all draft slice tasks and
 * sub-tasks to their dispatch-ready statuses (queued or blocked), then emit
 * proposal.approved on the event bus.
 *
 * Tasks are classified by their DB state:
 *   - HITL slice tasks (slice_kind='hitl') → 'blocked' (never dispatched directly)
 *   - Coder tasks with task_blocker edges (inter-slice deps) → 'blocked'
 *   - All other draft tasks (coder slices with no blockers, sub-tasks) → 'queued'
 *
 * Returns the ids split by the status they were transitioned to so callers can
 * emit bus events and/or report progress.
 */
export const approveProposalPlan = async (
  proposalId: string,
): Promise<{ queuedTaskIds: string[]; blockedTaskIds: string[] }> => {
  await initProposals()
  const c = stateClient()

  // Validate proposal is in 'sliced' state.
  const proposalResult = await c.execute({
    sql: `SELECT status FROM proposals WHERE id = ?`,
    args: [proposalId],
  })
  if (proposalResult.rows.length === 0) {
    throw new Error(`proposal ${proposalId} not found`)
  }
  const currentStatus = (proposalResult.rows[0] as unknown as { status: string }).status
  if (currentStatus !== 'sliced') {
    throw new Error(
      `proposal ${proposalId} is '${currentStatus}'; only 'sliced' proposals can be approved`,
    )
  }

  // Load all tasks for this proposal still in 'draft' status.
  const { getDefaultTaskStore } = await import('./store/task-store')
  const { updateTask } = await import('./queue')
  const taskStore = await getDefaultTaskStore()

  const tasksResult = await taskStore.query({
    sql: `SELECT id, slice_kind FROM tasks WHERE parent_proposal_id = ? AND status = 'draft'`,
    args: [proposalId],
  })

  const queuedTaskIds: string[] = []
  const blockedTaskIds: string[] = []

  for (const row of tasksResult.rows) {
    const task = row as unknown as { id: string; slice_kind: string | null }
    const isHitl = task.slice_kind === 'hitl'

    const blockersResult = await taskStore.query({
      sql: `SELECT 1 FROM task_blockers WHERE task_id = ? LIMIT 1`,
      args: [task.id],
    })
    const hasBlockers = blockersResult.rows.length > 0

    const newStatus = (isHitl || hasBlockers) ? 'blocked' : 'queued'
    await updateTask(task.id, { status: newStatus })

    if (newStatus === 'queued') {
      queuedTaskIds.push(task.id)
    } else {
      blockedTaskIds.push(task.id)
    }
  }

  // Clear the plan-approval action-queue row for this proposal.
  try {
    const { supersedeActionQueueItemsBySignature } = await import('./lib/action-queue')
    await supersedeActionQueueItemsBySignature(
      'plan-approval',
      proposalId,
      'origin-done',
      'proposal.approve',
    )
  } catch {
    // Best-effort — approval succeeds regardless of row-cleanup failure.
  }

  await emitProposalBusEvent('proposal.approved', {
    proposalId,
    queuedCount: queuedTaskIds.length,
  })

  return { queuedTaskIds, blockedTaskIds }
}

/**
 * Revert a 'sliced' proposal back to 'prd-ready' so it can be re-sliced.
 * The caller is responsible for dropping the existing slice tasks before
 * calling this, and for running the slicer again afterwards.
 *
 * Throws if the proposal is not currently 'sliced'.
 */
export const revertSlicedProposalToReady = async (
  proposalId: string,
): Promise<void> => {
  await initProposals()
  const c = stateClient()
  const r = await c.execute({
    sql: `UPDATE proposals SET status = 'prd-ready', updated_at = ? WHERE id = ? AND status = 'sliced'`,
    args: [Date.now(), proposalId],
  })
  if (r.rowsAffected !== 1) {
    const current = await getProposal(proposalId)
    throw new Error(
      `cannot revert proposal ${proposalId} to prd-ready: expected status='sliced', found '${current?.status ?? 'missing'}'`,
    )
  }
}

export const markProposalSliced = async (
  idOrPrefix: string,
  taskCount: number,
): Promise<void> => {
  await initProposals()
  const resolved = await resolveProposalId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} proposals`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`proposal ${idOrPrefix} not found`)
  }
  const id = resolved.id
  const c = stateClient()
  const r = await c.execute({
    sql: `UPDATE proposals SET status = 'sliced', updated_at = ? WHERE id = ? AND status = 'slicing'`,
    args: [Date.now(), id],
  })
  if (r.rowsAffected !== 1) {
    const current = await getProposal(id)
    throw new Error(
      `cannot mark proposal ${id} sliced: expected status='slicing', found '${current?.status ?? 'missing'}'`,
    )
  }
  await emitProposalBusEvent('proposal.sliced', { proposalId: id, taskCount })
}

/**
 * Revert a 'slicing' proposal back to 'prd-ready'. Used as a compensating
 * action when task creation fails after `claimProposalForSlicing` was called
 * (e.g. in `handleProposalTake`). Best-effort: throws on unexpected status.
 */
export const revertSlicingProposalToReady = async (id: string): Promise<void> => {
  await initProposals()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE proposals SET status = 'prd-ready', updated_at = ? WHERE id = ? AND status = 'slicing'`,
    args: [Date.now(), id],
  })
}

/**
 * Flip a proposal's status from 'slicing' to 'taken'. Called by
 * `handleProposalTake` after the live task has been successfully enqueued.
 * Pairs with `claimProposalForSlicing` (the 'prd-ready' → 'slicing' gate):
 * only the caller that holds the claim can finalise the transition.
 *
 * Distinct from `markProposalSliced` so that `take` and `slice` produce
 * distinguishable proposal states ('taken' vs 'sliced').
 */
export const markProposalTaken = async (id: string): Promise<void> => {
  await initProposals()
  const c = stateClient()
  const r = await c.execute({
    sql: `UPDATE proposals SET status = 'taken', updated_at = ? WHERE id = ? AND status = 'slicing'`,
    args: [Date.now(), id],
  })
  if (r.rowsAffected !== 1) {
    const current = await getProposal(id)
    throw new Error(
      `cannot mark proposal ${id} taken: expected status='slicing', found '${current?.status ?? 'missing'}'`,
    )
  }
}
