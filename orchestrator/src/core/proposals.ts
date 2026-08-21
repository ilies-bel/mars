import { randomBytes } from 'node:crypto'
import type { Author, AuthorKind } from './author'
import { resolveStateClient } from './store/state-client'
import { buildEventInsert } from './lib/outbox'
import { withTransaction, type DbClient } from './lib/db.js'
import { ensureSchema } from './lib/pg-schema.js'
import type { EventName, EventPayload } from '../bus/events.js'
import type { SuggestionOutcome } from './lib/suggestion-outcome.js'
export type { SuggestionOutcome, LeverBinding, LeverGap } from './lib/suggestion-outcome.js'

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
 * - `slicer`            — the slicer, creating successor proposals for
 *                         deferred deliverables declared in a PRD's
 *                         `out_of_scope` field at slice time.
 * - `human`             — an operator, via the CLI or UI.
 * - `growth`            — the growth step-suggestion heuristics
 *                         (orchestrator/src/growth), proposing new workflow
 *                         steps inferred from repeated verify-failure or
 *                         failure-signature patterns in task history.
 */
export type ProposalSource =
  | 'reflection'
  | 'arc-verifier'
  | 'human'
  | 'planner'
  | 'skill-forge'
  | 'failure-reflector'
  | 'slicer'
  | 'growth'

export const PROPOSAL_STATUSES = [
  'draft',
  'prd-ready',
  'slicing',
  'sliced',
  'taken',
  'dismissed',
  'expired',
] as const

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export interface Proposal {
  id: string
  title: string
  problem: string
  solution: string
  outOfScope: string
  notes: string
  /**
   * The proposal's lifecycle status. Normally one of {@link PROPOSAL_STATUSES},
   * but the field is typed as `string` so that rows carrying a legacy or
   * unrecognised status (e.g. 'promoted', 'superseded', 'done' from an older
   * schema era) are returned verbatim rather than crashing the entire listing.
   * The write path (`setProposalField`) still rejects unknown values via
   * `assertValidProposalStatus`.
   */
  status: string
  source: ProposalSource
  coordinated: boolean
  author: Author | null
  createdAt: number
  updatedAt: number
  userStories: string[]
  lastSliceError: string | null
  lastSliceFailedAt: number | null
  /**
   * Structured lever binding from ADR-0092. Non-null only for reflection-
   * sourced proposals created after the binding feature landed. Null means
   * "predates the binding feature" — never confused with a lever gap (which has
   * `{ type: 'leverGap', ... }` explicitly).
   */
  suggestionOutcome: SuggestionOutcome | null
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

/**
 * Max length of a derived proposal title before it gets word-boundary
 * truncated with an ellipsis. Mirrored (as a literal, `120`) by the
 * `pg-schema.ts` backfill migration that applies the same split to
 * pre-existing rows — keep the two in sync if this ever changes.
 */
export const PROPOSAL_TITLE_LIMIT = 120

/**
 * Split a raw prose blob (as typed by a human or an agent via
 * `mars proposal add`) into a short, single-line title and a body.
 *
 * Agent-authored proposals are often multi-paragraph documents passed
 * wholesale as the `title` argument (see `mars proposal add`); without this
 * split the entire document lands in `proposals.title`, which is illegible
 * in any list view and produces a slugified id truncated mid-sentence.
 *
 * Algorithm:
 *   1. Find the first non-empty line (leading blank lines are skipped and do
 *      not appear in the body either).
 *   2. Strip a leading markdown heading marker (`#` through `######`
 *      followed by whitespace) and surrounding whitespace from that line —
 *      that becomes the title.
 *   3. If the title exceeds {@link PROPOSAL_TITLE_LIMIT} characters, cut it
 *      at the last word boundary before the limit and append an ellipsis.
 *      A cut that would leave nothing (the only space is at the very start)
 *      falls back to a hard truncation instead of an empty title.
 *   4. Everything after the title line becomes the body (trimmed).
 *
 * An all-blank input returns `{ title: '', body: '' }` — callers fall back
 * to the raw (trimmed) input in that case so a blank title is never silently
 * substituted for whatever was actually passed in.
 */
export const splitProposalProse = (prose: string): { title: string; body: string } => {
  const lines = prose.split('\n')
  let idx = 0
  while (idx < lines.length && (lines[idx] ?? '').trim().length === 0) idx++
  if (idx >= lines.length) return { title: '', body: '' }

  const headingStripped = (lines[idx] ?? '').trim().replace(/^#{1,6}\s+/, '')
  const head = headingStripped.trim()

  let title = head
  if (title.length > PROPOSAL_TITLE_LIMIT) {
    const truncated = title.slice(0, PROPOSAL_TITLE_LIMIT)
    const lastSpace = truncated.lastIndexOf(' ')
    // The no-word-boundary fallback cuts one char short of the limit so that
    // appending the ellipsis still lands at exactly PROPOSAL_TITLE_LIMIT. A
    // derived title must never exceed the limit: the pg-schema backfill
    // selects rows on `char_length(title) > 120`, so an over-long result
    // would re-match and rewrite itself on every daemon boot.
    const cut =
      lastSpace > 0 ? truncated.slice(0, lastSpace) : title.slice(0, PROPOSAL_TITLE_LIMIT - 1)
    title = `${cut.trimEnd()}…`
  }

  const body = lines.slice(idx + 1).join('\n').trim()
  return { title, body }
}

export const VALID_SOURCES: readonly ProposalSource[] = [
  'reflection',
  'arc-verifier',
  'human',
  'planner',
  'skill-forge',
  'failure-reflector',
  'slicer',
  'growth',
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

/**
 * Default dedup window for near-identical auto-generated draft proposals.
 * A new agent-authored draft whose title shares ≥60% of significant words with
 * an open draft from the same agent within this window is coalesced into the
 * existing draft instead of creating a new row.
 */
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const TITLE_STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'will', 'when', 'does', 'should',
  'would', 'could', 'make', 'made', 'into', 'over', 'after', 'before', 'which',
  'their', 'there', 'then', 'than', 'them', 'they', 'each', 'some', 'been',
  'were', 'also', 'what', 'where', 'code', 'task',
])

const titleWords = (title: string): string[] =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !TITLE_STOP_WORDS.has(w))

const titleJaccard = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  let intersection = 0
  for (const w of b) if (setA.has(w)) intersection++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : intersection / union
}

/**
 * Return the most recent open (status='draft') agent-authored proposal whose
 * title is near-identical (Jaccard ≥ 0.6 on significant words) to `title`,
 * from the same `authorName`, within `withinMs` milliseconds. Returns null
 * when no near-duplicate is found or when `authorName` is null (cannot
 * determine the specific agent).
 */
const findNearDuplicateAgentDraft = async (
  title: string,
  authorName: string | null,
  withinMs: number,
): Promise<{ id: string; title: string } | null> => {
  if (authorName === null) return null
  const words = titleWords(title)
  if (words.length < 2) return null
  const c = stateClient()
  const cutoff = Date.now() - withinMs
  const r = await c.execute({
    sql: `SELECT id, title FROM proposals
           WHERE status = 'draft'
             AND author_kind = 'agent'
             AND author_name = ?
             AND updated_at >= ?
           ORDER BY updated_at DESC
           LIMIT 50`,
    args: [authorName, cutoff],
  })
  for (const row of r.rows as unknown as Array<{ id: string; title: string }>) {
    if (titleJaccard(words, titleWords(row.title)) >= 0.6) {
      return { id: row.id, title: row.title }
    }
  }
  return null
}

const parseSuggestionOutcome = (raw: unknown): SuggestionOutcome | null => {
  if (raw == null) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.type === 'lever' || o.type === 'leverGap') {
      return o as SuggestionOutcome
    }
    return null
  } catch {
    return null
  }
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
    status: (row.status as string | null) ?? 'draft',
    source: normaliseSource(row.source),
    coordinated: row.coordinated === true,
    author,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    userStories,
    lastSliceError: (row.last_slice_error as string | null) ?? null,
    lastSliceFailedAt:
      row.last_slice_failed_at == null ? null : Number(row.last_slice_failed_at),
    suggestionOutcome: parseSuggestionOutcome(row.suggestion_outcome),
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
  /**
   * Structured lever binding from ADR-0092. Set only for reflection-sourced
   * proposals; null (or omitted) for proposals created by other sources or
   * before the binding feature.
   */
  suggestionOutcome?: SuggestionOutcome | null
}

export const createProposal = async (
  title: string,
  opts?: CreateProposalOptions,
): Promise<Proposal> => {
  await initProposals()
  const c = stateClient()

  // Split the incoming prose blob into a short title and a leftover body.
  // Agent-authored (and human-pasted) proposals routinely arrive as
  // multi-paragraph documents in `title` — see `mars proposal add`. An
  // all-blank `title` derives nothing usable, so fall back to the raw
  // (trimmed) input rather than silently substituting an empty title.
  const { title: derivedTitle, body: derivedBody } = splitProposalProse(title)
  const effectiveTitle = derivedTitle.length > 0 ? derivedTitle : title.trim()

  const id = generateProposalId(effectiveTitle)
  const now = Date.now()
  const source: ProposalSource =
    opts?.source !== undefined
      ? assertValidSource(opts.source)
      : opts?.author?.kind === 'agent'
        ? 'planner'
        : 'human'
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  // Only fall back to the derived body when the caller did not supply an
  // explicit `problem` — structured callers (reflector, failure-reflector,
  // slicer, scorer-trend-trigger, self-evolve-trigger, promote-from-thread,
  // chat-runner's non-draft paths, ...) keep their current behaviour
  // untouched. When a caller DOES pass a `problem` and the title was also
  // multi-line, prepend the leftover body rather than dropping it.
  const problem =
    opts?.problem === undefined
      ? derivedBody
      : derivedBody.length > 0
        ? `${derivedBody}\n\n${opts.problem}`
        : opts.problem
  const solution = opts?.solution ?? ''
  const outOfScope = opts?.outOfScope ?? ''
  const notes = opts?.notes ?? ''
  const kpiTag = opts?.kpiTag ?? null
  const fingerprint = opts?.fingerprint ?? null
  const originSessionId = opts?.originSessionId ?? null
  const suggestionOutcomeJson =
    opts?.suggestionOutcome != null ? JSON.stringify(opts.suggestionOutcome) : null

  // Rate-limit at source: coalesce a new agent-authored draft into an existing
  // near-identical open draft from the same author within the dedup window.
  // Human-authored proposals always go through regardless of title similarity.
  // Compares on the derived (short) title, not the raw blob.
  if (authorKind === 'agent' && effectiveTitle.trim().length > 0) {
    const dup = await findNearDuplicateAgentDraft(effectiveTitle, authorName, DEDUP_WINDOW_MS)
    if (dup !== null) {
      if (notes && notes.trim().length > 0) {
        await appendProposalNotes(dup.id, notes)
      }
      const existing = await getProposal(dup.id)
      if (existing) return existing
    }
  }

  const result = await c.execute({
    sql: `INSERT INTO proposals
            (id, title, problem, solution, out_of_scope, notes,
             status, source, author_kind, author_name,
             kpi_tag, fingerprint, origin_session_id, suggestion_outcome,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source, fingerprint) WHERE fingerprint IS NOT NULL
          DO UPDATE SET
            notes = CASE
              WHEN EXCLUDED.notes = '' THEN proposals.notes
              WHEN proposals.notes = '' THEN EXCLUDED.notes
              ELSE proposals.notes || chr(10) || EXCLUDED.notes
            END,
            suggestion_outcome = COALESCE(EXCLUDED.suggestion_outcome, proposals.suggestion_outcome),
            updated_at = EXCLUDED.updated_at
          RETURNING id, title, problem, solution, out_of_scope, notes, status,
                    source, author_kind, author_name, coordinated, created_at,
                    updated_at, last_slice_error, last_slice_failed_at,
                    suggestion_outcome`,
    args: [
      id,
      effectiveTitle,
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
      suggestionOutcomeJson,
      now,
      now,
    ],
  })
  const row = result.rows[0] as unknown as Record<string, unknown>
  const proposal = rowToProposal(row, [])
  if (proposal.id === id) {
    await emitProposalBusEvent('proposal.added', { proposalId: id, source, title: effectiveTitle })
  }
  return proposal
}

/**
 * Record a failure-reflector occurrence and atomically claim the first
 * analysis for its fingerprint. The ledger is intentionally independent from
 * proposal rows so proposal cleanup cannot re-arm the reflector.
 *
 * Returns true only to the caller that should run the provider analysis.
 */
export const recordFailureReflectionOccurrence = async (
  fingerprint: string,
): Promise<boolean> => {
  await initProposals()
  const c = stateClient()
  const now = Date.now()
  const inserted = await c.execute({
    sql: `INSERT INTO failure_reflection_signatures
            (source, fingerprint, first_seen_at, last_seen_at, occurrence_count)
          VALUES ('failure-reflector', ?, ?, ?, 1)
          ON CONFLICT (source, fingerprint) DO NOTHING
          RETURNING fingerprint`,
    args: [fingerprint, now, now],
  })
  if (inserted.rows.length > 0) return true

  await c.execute({
    sql: `UPDATE failure_reflection_signatures
             SET last_seen_at = ?, occurrence_count = occurrence_count + 1
           WHERE source = 'failure-reflector' AND fingerprint = ?`,
    args: [now, fingerprint],
  })
  return false
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
  options: { coordinated?: boolean } = {},
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
      `proposal ${proposal.id} is not fully shaped; missing: ${missing.join(', ')}. ` +
        `Shape it with 'mars proposal set ${proposal.id} <field> <value>' and ` +
        `'mars proposal add-user-story ${proposal.id} <story>'.`,
    )
  }
  const c = stateClient()
  const now = Date.now()
  await c.execute({
    sql: `UPDATE proposals
          SET status = 'prd-ready',
              coordinated = CASE WHEN ? THEN true ELSE coordinated END,
              updated_at = ?
          WHERE id = ?`,
    args: [options.coordinated === true, now, proposal.id],
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

/** What became of a past reflection-sourced proposal. */
export type ProposalFate = 'promoted' | 'dismissed' | 'open'

export interface PriorProposalOutcome {
  fingerprint: string
  title: string
  fate: ProposalFate
}

const fateForProposalStatus = (status: string): ProposalFate => {
  if (status === 'dismissed' || status === 'expired') return 'dismissed'
  if (status === 'draft') return 'open'
  // 'prd-ready' | 'slicing' | 'sliced' | 'taken' — moved past the operator's
  // draft gate, i.e. accepted and acted on.
  return 'promoted'
}

/**
 * Recent reflection-sourced proposals (fingerprinted ones only) with their
 * lifecycle fate, newest-updated first. Feeds the reflector's
 * prior-suggestion-outcome prompt section (PRD 1e904a61 slice 16) so each
 * reflect run can see what happened to its predecessor's suggestions —
 * promoted, dismissed, or still open — instead of re-proposing an idea the
 * operator already rejected.
 */
export const listRecentReflectionOutcomes = async (
  limit = 20,
): Promise<PriorProposalOutcome[]> => {
  await initProposals()
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT fingerprint, title, status FROM proposals
           WHERE source = 'reflection' AND fingerprint IS NOT NULL
           ORDER BY updated_at DESC
           LIMIT ?`,
    args: [limit],
  })
  return r.rows.map((row) => {
    const r2 = row as unknown as Record<string, unknown>
    return {
      fingerprint: (r2.fingerprint as string | null) ?? '',
      title: (r2.title as string | null) ?? '',
      fate: fateForProposalStatus((r2.status as string | null) ?? 'draft'),
    }
  })
}

/**
 * Return ids of open (non-done, non-dropped) tasks whose prompt shares at
 * least 2 distinctive keywords with the given suggestion title. Used by the
 * reflector to flag potential overlapping work on new reflection drafts so the
 * operator can see a possible duplicate before acting on it.
 *
 * "Distinctive" means longer than 3 characters and not on a common stop-word
 * list. Returns at most 5 ids. Returns [] when fewer than 2 distinctive
 * keywords can be extracted from the title, or when no tasks match.
 */
export const findOpenTasksMatchingTitle = async (title: string): Promise<string[]> => {
  const STOP = new Set([
    'that', 'this', 'with', 'from', 'have', 'will', 'when', 'does', 'should',
    'would', 'could', 'make', 'made', 'into', 'over', 'after', 'before', 'which',
    'their', 'there', 'then', 'than', 'them', 'they', 'each', 'some', 'been',
    'were', 'also', 'what', 'where', 'code', 'task',
  ])
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
  if (words.length < 2) return []
  await initProposals()
  const c = stateClient()
  const matchSum = words
    .map(() => `CASE WHEN LOWER(t.prompt) LIKE ? THEN 1 ELSE 0 END`)
    .join(' + ')
  const r = await c.execute({
    sql: `SELECT t.id FROM tasks t
          WHERE t.status NOT IN ('done', 'dropped')
            AND (${matchSum}) >= 2
          ORDER BY t.created_at DESC
          LIMIT 5`,
    args: words.map((w) => `%${w}%`),
  })
  return (r.rows as unknown as Array<{ id: string }>).map((row) => row.id)
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
 * Returns true iff the proposal's notes field contains an unresolved
 * open-questions block.
 *
 * Detection is deliberately simple and conservative: any line whose trimmed
 * content starts with "OPEN QUESTION" (singular or plural, case-insensitive,
 * optionally followed by punctuation, whitespace, or an em-dash clause) is
 * treated as the start of an unresolved block.  The predicate does NOT attempt
 * to parse individual questions or judge whether they were answered — the
 * presence of the header is the only signal.
 *
 * False positives are cheap (operator adds --accept-defaults); false negatives
 * are the failure mode we are trying to prevent.
 */
export function hasUnresolvedOpenQuestions(notes: string | null | undefined): boolean {
  if (!notes) return false
  return notes.split('\n').some((line) => /^OPEN QUESTIONS?(\s|[:\-—]|$)/i.test(line.trim()))
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
    sql: `UPDATE proposals
          SET status = 'slicing', last_slice_error = NULL, last_slice_failed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'prd-ready'`,
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
    sql: `UPDATE proposals
          SET status = 'sliced', last_slice_error = NULL, last_slice_failed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'slicing'`,
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

/**
 * Bulk-expire auto-generated (agent-authored) draft proposals that have not
 * been touched in `olderThanMs` milliseconds. Returns the count and ids of
 * the rows flipped to 'expired'. Only proposals with `author_kind = 'agent'`
 * are eligible — operator-created proposals (author_kind = 'human') are never
 * auto-expired.
 *
 * Callers are responsible for superseding any open action-queue rows keyed
 * on the returned ids.
 */
export const expireProposals = async (
  olderThanMs: number,
): Promise<{ count: number; ids: string[] }> => {
  await initProposals()
  const c = stateClient()
  const cutoff = Date.now() - olderThanMs
  const r = await c.execute({
    sql: `UPDATE proposals
             SET status = 'expired', updated_at = ?
           WHERE status = 'draft'
             AND author_kind = 'agent'
             AND updated_at < ?
           RETURNING id`,
    args: [Date.now(), cutoff],
  })
  const ids = (r.rows as unknown as Array<{ id: string }>).map((row) => row.id)
  return { count: ids.length, ids }
}

/**
 * Revive an expired proposal back to draft status so it can be triaged again.
 * Throws if the proposal is not currently 'expired'. Emits `proposal.added` so
 * the action-queue-repopulator subscriber raises a new draft-proposal row.
 */
export const reviveProposal = async (idOrPrefix: string): Promise<Proposal> => {
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
  const current = await getProposal(id)
  if (!current) throw new Error(`proposal ${id} not found`)
  if (current.status !== 'expired') {
    throw new Error(
      `proposal ${id} is '${current.status}'; only expired proposals can be revived`,
    )
  }
  const c = stateClient()
  await c.execute({
    sql: `UPDATE proposals SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'expired'`,
    args: [Date.now(), id],
  })
  // Emit proposal.added so the action-queue-repopulator raises a new
  // draft-proposal row. The old row was superseded when the proposal expired.
  await emitProposalBusEvent('proposal.added', {
    proposalId: id,
    source: current.source,
    title: current.title,
  })
  const updated = await getProposal(id)
  if (!updated) throw new Error(`proposal ${id} disappeared after revival`)
  return updated
}
