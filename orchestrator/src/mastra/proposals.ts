import { createClient, type Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'
import { resolveContext } from './context'
import type { Author, AuthorKind } from './author'

export type ProposalSource = 'reflection' | 'human' | 'planner'

export interface Proposal {
  id: string
  title: string
  problem: string
  solution: string
  outOfScope: string
  notes: string
  status: string
  source: ProposalSource
  author: Author | null
  createdAt: number
  updatedAt: number
  userStories: string[]
}

let clientSingleton: Client | null = null

const getClient = (): Client => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  clientSingleton = createClient({ url: `file:${stateDbPath}` })
  return clientSingleton
}

/**
 * Direct access to the proposals DB client. Most callers should use the
 * typed helpers (`getProposal`, `setProposalField`, etc.); this is a
 * low-level escape hatch for workflows that need to coordinate cross-table
 * writes (e.g. the slicer flipping a proposal's status alongside per-slice
 * task inserts in queue.db).
 */
export const getProposalsClient = (): Client => {
  return getClient()
}

let initialised = false

export const initProposals = async (): Promise<void> => {
  if (initialised) return
  const c = getClient()
  // One-shot rename: a pre-existing state.db has an `ideas` table (and
  // possibly `idea_user_stories`). Flip them to the proposal vocabulary
  // before any CREATE/ALTER runs. This is a pure DDL rename with no
  // compatibility view; per ADR-0010, in-flight worktrees at migration
  // time may be orphaned.
  const tables = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  )
  const tableSet = new Set(
    (tables.rows as unknown as Array<{ name: string }>).map((r) => r.name),
  )
  if (tableSet.has('ideas') && !tableSet.has('proposals')) {
    await c.execute(`ALTER TABLE ideas RENAME TO proposals`)
  }
  if (
    tableSet.has('idea_user_stories') &&
    !tableSet.has('proposal_user_stories')
  ) {
    await c.execute(
      `ALTER TABLE idea_user_stories RENAME TO proposal_user_stories`,
    )
    const usCols = await c.execute(`PRAGMA table_info(proposal_user_stories)`)
    const usColNames = new Set(
      (usCols.rows as unknown as Array<{ name: string }>).map((r) => r.name),
    )
    if (usColNames.has('idea_id') && !usColNames.has('proposal_id')) {
      await c.execute(
        `ALTER TABLE proposal_user_stories RENAME COLUMN idea_id TO proposal_id`,
      )
    }
  }
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      problem TEXT NOT NULL DEFAULT '',
      solution TEXT NOT NULL DEFAULT '',
      out_of_scope TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // The PRD-shaped user-stories list. New name; pre-existing databases keep
  // their `idea_acceptance` rows and get migrated below.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposal_user_stories (
      proposal_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY(proposal_id, position),
      FOREIGN KEY(proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
    )
  `)
  // ADR-0008: the planning graph (Ideas blocking Ideas, traversed by the
  // recursive planner to decide what to grill next) is stored in its own
  // junction, separate from the dispatch graph's `task_blockers`. No
  // polymorphic (kind,id) table. Both endpoints are proposals so the table
  // lives here in state.db alongside `proposals`. Shape mirrors
  // `task_blockers` in queue.ts: (subject) waits on (blocker), composite PK,
  // FK on both endpoints, an index per endpoint. The ADR text names this
  // `idea_dependencies`; the codebase renamed the `idea_*` vocabulary to
  // `proposal_*`, so we follow the current convention.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposal_dependencies (
      proposal_id TEXT NOT NULL,
      blocker_proposal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (proposal_id, blocker_proposal_id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
      FOREIGN KEY (blocker_proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_proposal_dependencies_proposal ON proposal_dependencies(proposal_id)
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_proposal_dependencies_blocker ON proposal_dependencies(blocker_proposal_id)
  `)
  const cols = await c.execute(`PRAGMA table_info(proposals)`)
  const colNames = new Set(
    cols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!colNames.has('author_kind')) {
    await c.execute(`ALTER TABLE proposals ADD COLUMN author_kind TEXT`)
  }
  if (!colNames.has('author_name')) {
    await c.execute(`ALTER TABLE proposals ADD COLUMN author_name TEXT`)
  }
  // PRD-shape columns. Add idempotently for repos with the old shape.
  if (!colNames.has('title')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
    )
  }
  if (!colNames.has('problem')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN problem TEXT NOT NULL DEFAULT ''`,
    )
  }
  if (!colNames.has('solution')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN solution TEXT NOT NULL DEFAULT ''`,
    )
  }
  if (!colNames.has('out_of_scope')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN out_of_scope TEXT NOT NULL DEFAULT ''`,
    )
  }
  if (!colNames.has('notes')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN notes TEXT NOT NULL DEFAULT ''`,
    )
  }
  // One-shot backfill from the legacy goal/story/technical columns. Runs
  // only when the new columns are still empty for the row, so re-running
  // initProposals after manual edits never clobbers user data.
  if (colNames.has('goal')) {
    await c.execute(
      `UPDATE proposals SET title = goal WHERE (title IS NULL OR title = '')`,
    )
  }
  if (colNames.has('story')) {
    await c.execute(
      `UPDATE proposals SET solution = story WHERE (solution IS NULL OR solution = '')`,
    )
  }
  if (colNames.has('technical')) {
    await c.execute(
      `UPDATE proposals SET notes = technical WHERE (notes IS NULL OR notes = '')`,
    )
  }
  // Migrate legacy `origin` column (values 'user' | 'agent') into `source`
  // (values 'human' | 'planner' | 'reflection'). The legacy column is
  // dropped after the values are copied across.
  if (colNames.has('origin') && !colNames.has('source')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'human'`,
    )
    await c.execute(
      `UPDATE proposals
          SET source = CASE
            WHEN author_kind = 'agent' THEN 'planner'
            WHEN origin = 'agent'      THEN 'planner'
            ELSE 'human'
          END`,
    )
    await c.execute(`ALTER TABLE proposals DROP COLUMN origin`)
  } else if (!colNames.has('source')) {
    await c.execute(
      `ALTER TABLE proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'human'`,
    )
    // Backfill from author_kind: rows authored by an agent (i.e. whose
    // rendered author starts with 'agent:') become 'planner'; everything
    // else stays at the 'human' default. Runs only at column-add time —
    // a subsequent initProposals() won't re-enter this branch, so the
    // backfill is naturally idempotent.
    if (colNames.has('author_kind')) {
      await c.execute(
        `UPDATE proposals SET source = 'planner' WHERE author_kind = 'agent'`,
      )
    }
  }
  // Migrate idea_acceptance rows into proposal_user_stories. Idempotent —
  // runs only if the legacy table still exists. Rows are copied; the
  // legacy table is dropped after.
  const accCheck = await c.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='idea_acceptance'`,
    args: [],
  })
  if (accCheck.rows.length > 0) {
    await c.execute(
      `INSERT OR IGNORE INTO proposal_user_stories (proposal_id, position, text)
         SELECT idea_id, position, text FROM idea_acceptance`,
    )
    await c.execute(`DROP TABLE idea_acceptance`)
  }
  // Run after `initQueue` has had a chance to migrate `tasks.blocker_id`
  // out into `task_blockers` rows, since that migration reads
  // `task_suggestions` and we are about to drop it.
  const { initQueue } = await import('./queue')
  await initQueue()
  await migrateTaskSuggestions(c)
  initialised = true
}

/**
 * One-shot migration: copy any reflection-origin rows out of the legacy
 * `task_suggestions` table (in queue.db) into `proposals` with
 * `source='reflection'`. Runs idempotently — rows whose id already exists
 * in proposals are skipped. The actual DROP of task_suggestions happens
 * during queue init, after this migration has copied the rows out.
 */
const migrateTaskSuggestions = async (c: Client): Promise<void> => {
  const { queueDbPath } = resolveContext()
  let queueClient: Client
  try {
    queueClient = createClient({ url: `file:${queueDbPath}` })
  } catch {
    return
  }
  try {
    const tableCheck = await queueClient.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
      args: [],
    })
    if (tableCheck.rows.length === 0) return

    const cols = await queueClient.execute(`PRAGMA table_info(task_suggestions)`)
    const colNames = new Set(
      cols.rows.map((r) => (r as unknown as { name: string }).name),
    )
    const hasKind = colNames.has('kind')
    const sql = hasKind
      ? `SELECT id, title, prompt, rationale, status, kind, created_task_id, created_at
           FROM task_suggestions
          WHERE kind = 'reflection' OR kind IS NULL`
      : `SELECT id, title, prompt, rationale, status, created_task_id, created_at,
                NULL AS kind FROM task_suggestions`
    const rows = await queueClient.execute(sql)

    const tx = await c.transaction('write')
    try {
      for (const row of rows.rows) {
        const r = row as unknown as {
          id: string
          title: string | null
          prompt: string | null
          rationale: string | null
          status: string | null
          kind: string | null
          created_task_id: string | null
          created_at: string | null
        }
        const title = (r.title ?? '').trim() || '(reflection)'
        const solution = (r.prompt ?? '').trim()
        const notes = (r.rationale ?? '').trim()
        const status =
          r.status === 'promoted' || r.status === 'accepted'
            ? 'sliced'
            : r.status === 'rejected'
              ? 'dismissed'
              : 'draft'
        const createdMs = Date.parse(r.created_at ?? '')
        const now = Date.now()
        const createdAt = Number.isFinite(createdMs) ? createdMs : now
        // Detect whether the legacy `goal` column is still present (and
        // therefore NOT NULL) on this DB. New repos have only `title`.
        const proposalCols = await tx.execute(`PRAGMA table_info(proposals)`)
        const hasLegacyGoal = (
          proposalCols.rows as unknown as Array<{ name: string }>
        ).some((rr) => rr.name === 'goal')
        if (hasLegacyGoal) {
          await tx.execute({
            sql: `INSERT OR IGNORE INTO proposals
                    (id, goal, story, technical, title, solution, notes,
                     status, source, author_kind, author_name,
                     created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?,
                          ?, 'reflection', 'agent', 'reflector',
                          ?, ?)`,
            args: [
              r.id,
              title,
              solution,
              notes,
              title,
              solution,
              notes,
              status,
              createdAt,
              createdAt,
            ],
          })
        } else {
          await tx.execute({
            sql: `INSERT OR IGNORE INTO proposals
                    (id, title, solution, notes, status, source,
                     author_kind, author_name,
                     created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'reflection',
                          'agent', 'reflector',
                          ?, ?)`,
            args: [
              r.id,
              title,
              solution,
              notes,
              status,
              createdAt,
              createdAt,
            ],
          })
        }
      }
      await tx.commit()
    } catch (error: unknown) {
      tx.close()
      throw error
    }
    // After copying reflection rows out, drop the legacy table from queue.db.
    // Any remaining rows (kind='fix') are vestigial — fix tasks are now
    // first-class entries in `tasks` linked via `task_blockers`.
    await queueClient.execute(
      `DROP INDEX IF EXISTS idx_task_suggestions_source_task_id`,
    )
    await queueClient.execute(
      `DROP INDEX IF EXISTS idx_task_suggestions_failure_signature`,
    )
    await queueClient.execute(`DROP TABLE IF EXISTS task_suggestions`)
  } finally {
    queueClient.close()
  }
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

const VALID_SOURCES: readonly ProposalSource[] = [
  'reflection',
  'human',
  'planner',
]

const isValidSource = (raw: unknown): raw is ProposalSource =>
  raw === 'reflection' || raw === 'planner' || raw === 'human'

const normaliseSource = (raw: unknown): ProposalSource => {
  if (isValidSource(raw)) return raw
  return 'human'
}

const assertValidSource = (raw: unknown): ProposalSource => {
  if (isValidSource(raw)) return raw
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
    status: (row.status as string | null) ?? 'draft',
    source: normaliseSource(row.source),
    author,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    userStories,
  }
}

const loadUserStories = async (
  c: Client,
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
}

export const createProposal = async (
  title: string,
  opts?: CreateProposalOptions,
): Promise<Proposal> => {
  await initProposals()
  const c = getClient()
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
  // Detect whether the legacy goal/story/technical columns still exist as
  // NOT NULL — pre-existing repos do, fresh repos don't. Write to both
  // sets when present so the legacy NOT NULL constraint is satisfied.
  const proposalCols = await c.execute(`PRAGMA table_info(proposals)`)
  const hasLegacyGoal = (
    proposalCols.rows as unknown as Array<{ name: string }>
  ).some((rr) => rr.name === 'goal')
  if (hasLegacyGoal) {
    await c.execute({
      sql: `INSERT INTO proposals
              (id, goal, story, technical,
               title, problem, solution, out_of_scope, notes,
               status, source, author_kind, author_name,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      args: [
        id,
        title,
        solution,
        notes,
        title,
        problem,
        solution,
        outOfScope,
        notes,
        source,
        authorKind,
        authorName,
        now,
        now,
      ],
    })
  } else {
    await c.execute({
      sql: `INSERT INTO proposals
              (id, title, problem, solution, out_of_scope, notes,
               status, source, author_kind, author_name,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
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
        now,
        now,
      ],
    })
  }
  return {
    id,
    title,
    problem,
    solution,
    outOfScope,
    notes,
    status: 'draft',
    source,
    author: opts?.author ?? null,
    createdAt: now,
    updatedAt: now,
    userStories: [],
  }
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
  const c = getClient()
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
  const c = getClient()
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
 * rejected (an idea cannot block itself), duplicates are de-duped, and the
 * insert is `INSERT OR IGNORE` so re-adding an existing edge is a no-op.
 * Ids are resolved through `resolveProposalId` so prefixes work like every
 * other proposal verb.
 */
export const addProposalDependencies = async (
  proposalIdOrPrefix: string,
  blockerIdsOrPrefixes: readonly string[],
): Promise<void> => {
  if (blockerIdsOrPrefixes.length === 0) return
  await initProposals()
  const c = getClient()

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
    sql: `INSERT OR IGNORE INTO proposal_dependencies (proposal_id, blocker_proposal_id, created_at) VALUES (?, ?, ?)`,
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
  const c = getClient()
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
  const c = getClient()
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
  const c = getClient()
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
  const c = getClient()
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
  const c = getClient()
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
  const c = getClient()
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`user-story index must be a non-negative integer`)
  }
  const tx = await c.transaction('write')
  try {
    const target = await tx.execute({
      sql: `SELECT position FROM proposal_user_stories WHERE proposal_id = ? AND position = ?`,
      args: [id, index],
    })
    if (target.rows.length === 0) {
      tx.close()
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
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }
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
  const c = getClient()
  const now = Date.now()
  await c.execute({
    sql: `UPDATE proposals SET status = 'prd-ready', updated_at = ? WHERE id = ?`,
    args: [now, proposal.id],
  })
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
  const c = getClient()
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
  return id
}

// Direct DB write — rejection is a pure status flip with no side effects
// (no worktree, no merge), so it does not need to go through the daemon.
export const rejectProposal = async (
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
  // ADR-0015: refuse the dismiss while ANY task still depends on this idea
  // via task_proposal_blockers. Do NOT auto-cascade — surface the dependent
  // task ids so the user explicitly redirects or drops them. This check
  // runs BEFORE the status flip so a refused dismiss leaves the proposal
  // untouched (still 'draft'). task_proposal_blockers lives in the separate
  // queue.db, hence the cross-module read.
  const { listTasksBlockedByProposal } = await import('./queue')
  const dependents = await listTasksBlockedByProposal(id)
  if (dependents.length > 0) {
    throw new Error(
      `proposal ${id} cannot be dismissed: ${dependents.length} task(s) are blocked by it: ${dependents.join(', ')}. ` +
        `Redirect or drop those tasks first (e.g. 'mars unblock <task-id> ${id}' or 'mars drop <task-id>').`,
    )
  }
  const c = getClient()
  const now = Date.now()
  const r = await c.execute({
    sql: `UPDATE proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'draft'`,
    args: [now, id],
  })
  if (r.rowsAffected === 0) {
    const current = await getProposal(id)
    if (!current) throw new Error(`proposal ${id} not found`)
    throw new Error(
      `proposal ${id} is '${current.status}'; only draft proposals can be rejected`,
    )
  }
  const updated = await getProposal(id)
  if (!updated) {
    throw new Error(`proposal ${id} disappeared after rejection`)
  }
  return updated
}
