/**
 * StateStore — the deep seam over the Mars database (state side: proposals,
 * proposal-notes, action-queue items). ADR-0021.
 *
 * Mirror of {@link DomainTaskStore}: typed domain methods (delegating to the
 * proposals / proposal-notes / action-queue modules) are the front door, and
 * the generic `query` / `execute` / `atomic` side door is the escape hatch.
 * The transaction handle never crosses the seam — `atomic` inverts control
 * and passes a revocable {@link Scope}.
 *
 * Per ADR-0034 `tasks` and `proposals` share one physical database, so the
 * StateStore and the TaskStore are backed by the same client (openDb dedupes
 * per target); the two facades exist to keep the *domain vocabularies*
 * separate, not the connections. The two previously-duplicated private
 * `getClient()` singletons (proposals.ts, ideas/idea-store.ts) collapse into
 * {@link resolveStateClient} here.
 *
 * Cross-domain note: proposals and action-queue rows emit lifecycle events
 * into the events outbox. That ability is preserved — those modules publish
 * through the TaskStore client (same database) in a separate write after the
 * state write commits; see `emitProposalBusEvent` /
 * `emitActionQueueBusEvent`.
 */

import type { DbClient, DbStatement, DbInValue, DbResultSet } from '../lib/db.js'
import { withTransaction } from '../lib/db.js'
import { ensureSchema } from '../lib/pg-schema.js'
import { z } from 'zod'
import type { Scope } from './task-store'
import {
  resolveStateClient,
  __resetStateClientForTests,
} from './state-client'

import {
  getProposal,
  listProposals,
  createProposal,
  setProposalField,
  resolveProposalId,
  promoteProposal,
  deleteProposal,
  dismissProposal,
  addProposalDependencies,
  listProposalDependencies,
  removeProposalDependency,
  addProposalUserStory,
  removeProposalUserStory,
  findOpenReflectionDraftForKpi,
  markProposalSliced,
  type Proposal,
  type CreateProposalOptions,
  type ListProposalsFilter,
  type ProposalIdResolution,
  type ProposalField,
} from '../proposals'
import {
  addProposalNote,
  listProposalNotes,
  getProposalNote,
  type ProposalNote,
} from '../../ideas/idea-store'

export type { Scope } from './task-store'
export { resolveStateClient } from './state-client'

/**
 * Idempotent state-domain schema entry point. Applies the canonical schema
 * via `ensureSchema` (pg-schema.ts owns every table — the per-module init
 * DDL is gone, migration 0002). ADR-0021: the migration lives behind the
 * store; callers stop hand-sequencing the inits.
 */
export const migrateStateSchema = async (): Promise<void> => {
  await ensureSchema(resolveStateClient())
}

const toStatement = (
  stmt: DbStatement | string,
  params?: DbInValue[],
): DbStatement => {
  if (typeof stmt === 'string') {
    return params === undefined ? stmt : { sql: stmt, args: params }
  }
  return stmt
}

/**
 * Typed domain interface over mars.db (state side). Every method mirrors the
 * corresponding proposals / proposal-notes export. The generic SQL escape
 * hatches (`query`, `execute`, `atomic`) are available on every store created
 * with a non-null client.
 */
export interface DomainStateStore {
  // ── Proposals ────────────────────────────────────────────────────────────
  getProposal(idOrPrefix: string): Promise<Proposal | null>
  listProposals(filter?: ListProposalsFilter): Promise<Proposal[]>
  createProposal(
    title: string,
    opts?: CreateProposalOptions,
  ): Promise<Proposal>
  setProposalField(
    idOrPrefix: string,
    field: ProposalField,
    value: string,
  ): Promise<Proposal>
  resolveProposalId(idOrPrefix: string): Promise<ProposalIdResolution>
  promoteProposal(idOrPrefix: string): Promise<Proposal>
  deleteProposal(idOrPrefix: string): Promise<string>
  dismissProposal(idOrPrefix: string): Promise<Proposal>
  addProposalDependencies(
    idOrPrefix: string,
    dependsOn: readonly string[],
  ): Promise<void>
  listProposalDependencies(idOrPrefix: string): Promise<string[]>
  removeProposalDependency(
    idOrPrefix: string,
    dependencyId: string,
  ): Promise<{ removed: boolean }>
  addProposalUserStory(idOrPrefix: string, story: string): Promise<Proposal>
  removeProposalUserStory(
    idOrPrefix: string,
    position: number,
  ): Promise<Proposal>
  findOpenReflectionDraftForKpi(
    kpi: string,
  ): Promise<{ id: string; title: string } | null>
  markProposalSliced(idOrPrefix: string, taskCount: number): Promise<void>

  // ── Proposal notes (scratchpad) ──────────────────────────────────────────
  addProposalNote(text: string): Promise<ProposalNote>
  listProposalNotes(): Promise<ProposalNote[]>
  getProposalNote(input: string): Promise<ProposalNote | null>

  // ── Generic SQL escape hatches ───────────────────────────────────────────
  query(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  execute(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T>
}

/**
 * Create a `DomainStateStore` over the given DB client.
 *
 * Passing `null` is supported for call sites that only use domain methods.
 * Calling a generic escape hatch on a null-client store throws a clear error.
 */
export const createStateStore = (client: DbClient | null): DomainStateStore => {
  let inTransaction = false

  const guardClient = (): DbClient => {
    if (!client)
      throw new Error(
        'StateStore: a DbClient is required for query/execute/atomic — pass a non-null client to createStateStore',
      )
    return client
  }

  return {
    // ── Proposals ──────────────────────────────────────────────────────────
    getProposal: (idOrPrefix) => getProposal(idOrPrefix),
    listProposals: (filter) => listProposals(filter),
    createProposal: (title, opts) => createProposal(title, opts),
    setProposalField: (idOrPrefix, field, value) =>
      setProposalField(idOrPrefix, field, value),
    resolveProposalId: (idOrPrefix) => resolveProposalId(idOrPrefix),
    promoteProposal: (idOrPrefix) => promoteProposal(idOrPrefix),
    deleteProposal: (idOrPrefix) => deleteProposal(idOrPrefix),
    dismissProposal: (idOrPrefix) => dismissProposal(idOrPrefix),
    addProposalDependencies: (idOrPrefix, dependsOn) =>
      addProposalDependencies(idOrPrefix, dependsOn),
    listProposalDependencies: (idOrPrefix) =>
      listProposalDependencies(idOrPrefix),
    removeProposalDependency: (idOrPrefix, dependencyId) =>
      removeProposalDependency(idOrPrefix, dependencyId),
    addProposalUserStory: (idOrPrefix, story) =>
      addProposalUserStory(idOrPrefix, story),
    removeProposalUserStory: (idOrPrefix, position) =>
      removeProposalUserStory(idOrPrefix, position),
    findOpenReflectionDraftForKpi: (kpi) => findOpenReflectionDraftForKpi(kpi),
    markProposalSliced: (idOrPrefix, taskCount) =>
      markProposalSliced(idOrPrefix, taskCount),

    // ── Proposal notes ───────────────────────────────────────────────────────
    addProposalNote: (text) => addProposalNote(text),
    listProposalNotes: () => listProposalNotes(),
    getProposalNote: (input) => getProposalNote(input),

    // ── Generic SQL escape hatches ───────────────────────────────────────────

    query: async (stmt, params) => {
      const c = guardClient()
      const [result] = await c.batch([toStatement(stmt, params)], 'read')
      return result
    },

    execute: async (stmt, params) => {
      const c = guardClient()
      return c.execute(toStatement(stmt, params))
    },

    atomic: async <T>(fn: (scope: Scope) => Promise<T>): Promise<T> => {
      const c = guardClient()
      if (inTransaction) {
        throw new Error(
          'StateStore: atomic() cannot be nested inside another atomic() call',
        )
      }
      inTransaction = true
      let revoked = false
      try {
        return await withTransaction(c, async (tx) => {
          const scope: Scope = {
            query: async (stmt, params) => {
              if (revoked)
                throw new Error(
                  'StateStore: Scope has been revoked — cannot use scope after atomic() has settled',
                )
              return tx.execute(toStatement(stmt, params))
            },
            execute: async (stmt, params) => {
              if (revoked)
                throw new Error(
                  'StateStore: Scope has been revoked — cannot use scope after atomic() has settled',
                )
              return tx.execute(toStatement(stmt, params))
            },
          }
          return fn(scope)
        })
      } finally {
        revoked = true
        inTransaction = false
      }
    },
  }
}

// ── Preferences helpers ───────────────────────────────────────────────────────

/** The two presentations of the same persisted chat conversation. */
export const ChatLayoutSchema = z.enum(['focus', 'threads'])
export type ChatLayout = z.infer<typeof ChatLayoutSchema>

/** Return the persisted chat presentation, defaulting to the continuous Focus view. */
export const getChatLayoutPreference = async (db: DbClient): Promise<ChatLayout> => {
  const result = await db.execute(
    "SELECT value FROM preferences WHERE name='chat_layout'",
  )
  if (result.rows.length === 0) return 'focus'
  return ChatLayoutSchema.catch('focus').parse(result.rows[0].value)
}

/** Persist the presentation choice without touching chat rows or delivery state. */
export const setChatLayoutPreference = async (
  db: DbClient,
  layout: ChatLayout,
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO preferences (name, value) VALUES ('chat_layout', ?)
          ON CONFLICT(name) DO UPDATE SET value=excluded.value`,
    args: [layout],
  })
}

/**
 * Return whether desktop notifications are enabled.
 * Defaults to `true` when the row is absent (opt-in by default).
 */
export const getNotificationsEnabled = async (db: DbClient): Promise<boolean> => {
  const result = await db.execute(
    "SELECT value FROM preferences WHERE name='notifications_enabled'",
  )
  if (result.rows.length === 0) return true
  return result.rows[0].value === 'true'
}

/**
 * Persist whether desktop notifications are enabled.
 * Safe to call repeatedly — upserts the single `notifications_enabled` row.
 */
export const setNotificationsEnabled = async (
  db: DbClient,
  enabled: boolean,
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO preferences (name, value) VALUES ('notifications_enabled', ?)
          ON CONFLICT(name) DO UPDATE SET value=excluded.value`,
    args: [String(enabled)],
  })
}

/**
 * Read the single `daemon_heartbeat` row (id = 1). Returns null when no
 * heartbeat row exists yet — e.g. the daemon has not started its heartbeat
 * writer.
 *
 * Timestamps are returned as milliseconds since epoch so callers can compute
 * derived fields (uptimeMs, staleMs) with a plain `Date.now() - x`.
 */
export const readDaemonHeartbeat = async (
  db: DbClient,
): Promise<{
  pid: number
  bootTs: number
  lastBeatTs: number
  /** Milliseconds the daemon was offline before the most recent boot (0 when unavailable). */
  prevGapMs: number
  /** Cumulative milliseconds that a live daemon had dispatch enabled. */
  dispatchUptimeMs: number
} | null> => {
  const result = await db.execute(
    'SELECT pid, boot_ts, last_beat_ts, prev_gap_ms, dispatch_uptime_ms FROM daemon_heartbeat WHERE id = 1',
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]
  return {
    pid: Number(row.pid),
    bootTs: new Date(row.boot_ts as string).getTime(),
    lastBeatTs: new Date(row.last_beat_ts as string).getTime(),
    prevGapMs:
      row.prev_gap_ms !== null && row.prev_gap_ms !== undefined
        ? Number(row.prev_gap_ms)
        : 0,
    dispatchUptimeMs:
      row.dispatch_uptime_ms !== null && row.dispatch_uptime_ms !== undefined
        ? Number(row.dispatch_uptime_ms)
        : 0,
  }
}

let cachedDefaultStateStore: DomainStateStore | null = null

/**
 * Composition-root accessor: the single process-wide `DomainStateStore` over
 * the Mars database. Lazily ensures the canonical schema and constructs the
 * store around the seam-internal client.
 */
export const getDefaultStateStore = async (): Promise<DomainStateStore> => {
  if (cachedDefaultStateStore) return cachedDefaultStateStore
  await migrateStateSchema()
  cachedDefaultStateStore = createStateStore(resolveStateClient())
  return cachedDefaultStateStore
}

/**
 * Test-only: drop the cached default state store so a subsequent
 * `getDefaultStateStore()` rebuilds against whatever client is current.
 */
export const __resetDefaultStateStoreForTests = (): void => {
  cachedDefaultStateStore = null
  __resetStateClientForTests()
}
