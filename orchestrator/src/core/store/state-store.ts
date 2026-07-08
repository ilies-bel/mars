/**
 * StateStore — the deep seam over `.mars/mars.db` (state side: proposals,
 * proposal-notes, action-queue items). ADR-0021.
 *
 * Mirror of {@link DomainTaskStore}: typed domain methods (delegating to the
 * proposals / proposal-notes / action-queue modules) are the front door, and
 * the generic `query` / `execute` / `atomic` side door is the escape hatch.
 * The libsql Transaction never crosses the seam — `atomic` inverts control
 * and passes a revocable {@link Scope}.
 *
 * Per ADR-0034 `tasks` and `proposals` share one physical file (`mars.db`), so
 * the StateStore and the TaskStore are backed by the same libsql client; the
 * two facades exist to keep the *domain vocabularies* separate, not the files.
 * The two previously-duplicated private `getClient()` singletons
 * (proposals.ts, ideas/idea-store.ts) collapse into {@link resolveStateClient}
 * here.
 *
 * Cross-DB note: proposals and action-queue rows emit lifecycle events into
 * the queue.db events outbox. That ability is preserved — those modules
 * publish through the TaskStore client (same `mars.db`) in a separate write
 * after the state write commits; see `emitProposalBusEvent` /
 * `emitActionQueueBusEvent`.
 */

import type { Client, InStatement, InValue, ResultSet } from '@libsql/client'
import { withTransaction } from '../lib/libsql.js'
import type { Scope } from './task-store'
import {
  resolveStateClient,
  __resetStateClientForTests,
} from './state-client'

import {
  initProposals,
  getProposal,
  listProposals,
  createProposal,
  setProposalField,
  resolveProposalId,
  promoteProposal,
  deleteProposal,
  rejectProposal,
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
  initProposalNotes,
  addProposalNote,
  listProposalNotes,
  getProposalNote,
  type ProposalNote,
} from '../../ideas/idea-store'

export type { Scope } from './task-store'
export { resolveStateClient } from './state-client'

/**
 * Idempotent state.db schema migration. Runs the per-table init for proposals
 * and proposal-notes. ADR-0021: the migration lives behind the store; callers
 * stop hand-sequencing the inits.
 */
export const migrateStateSchema = async (): Promise<void> => {
  await initProposals()
  await initProposalNotes()
}

const toStatement = (
  stmt: InStatement | string,
  params?: InValue[],
): InStatement => {
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
  rejectProposal(idOrPrefix: string): Promise<Proposal>
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
  query(stmt: InStatement | string, params?: InValue[]): Promise<ResultSet>
  execute(stmt: InStatement | string, params?: InValue[]): Promise<ResultSet>
  atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T>
}

/**
 * Create a `DomainStateStore` over the given libsql client.
 *
 * Passing `null` is supported for call sites that only use domain methods.
 * Calling a generic escape hatch on a null-client store throws a clear error.
 */
export const createStateStore = (client: Client | null): DomainStateStore => {
  let inTransaction = false

  const guardClient = (): Client => {
    if (!client)
      throw new Error(
        'StateStore: a libsql Client is required for query/execute/atomic — pass a non-null client to createStateStore',
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
    rejectProposal: (idOrPrefix) => rejectProposal(idOrPrefix),
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

let cachedDefaultStateStore: DomainStateStore | null = null

/**
 * Composition-root accessor: the single process-wide `DomainStateStore` over
 * `.mars/mars.db`. Lazily runs the state-schema migration and constructs the
 * store around the seam-internal libsql client.
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
