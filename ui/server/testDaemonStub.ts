/**
 * Test-only daemon stub for {@link startServer}.
 *
 * The UI server proxies daemon view endpoints (`/view/action-queue`,
 * `/view/tasks`, `/view/progress`, `/view/sessions`, …) rather than re-deriving
 * them, so the daemon's view builders stay the single source of truth for each
 * projection. In tests there is no daemon, so we inject this `proxyGet` stub: it
 * reads the same seeded SQLite fixture the test wrote and serves each view via
 * the SAME builders the daemon's AppServices use (`buildActionQueueView`,
 * `buildProgressView`, `buildSessionsView`, `listTerminalEvents`,
 * `listReleaseNotes`, and the step-span pairing logic). That keeps the tests
 * asserting the canonical projection instead of a hand-authored fixture that
 * could drift from production (the drift that commit b89c57ce introduced and
 * this stub exists to prevent).
 *
 * ### Why Option B (per-endpoint adapters), not Option A (real AppServices)
 *
 * `createAppServices` delegates to composition-root singletons
 * (`getDefaultDomainTaskStore`, `getCompositionRootClient`) that bind to a DB
 * via `resolveContext()` — a process-wide *memoised* read of `MARS_REPO`/CWD
 * (see orchestrator `core/context.ts` + `core/queue.ts:resolveQueueClient`).
 * Pointing that singleton at a seeded test DB would (a) leak across the UI
 * server's per-project requests and across test cases, and (b) require the FULL
 * modern `tasks` schema — but the integration tests deliberately seed *partial /
 * legacy* schemas (no `parent_proposal_id` / `origin_id` / `task_spec_files` /
 * …) to pin backwards-tolerant behaviour. So we mirror the existing
 * action-queue pattern: a tolerant adapter per endpoint over a
 * `file:${dbPath}` client, feeding the SAME pure view builders. Each adapter
 * degrades to empty/defaults on a missing table or column rather than throwing.
 */
import { createClient, type Client } from '@libsql/client'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  buildActionQueueView,
  buildActionQueueHistoryView,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
  type PersistedActionQueueRow,
  type TaskForActionQueue,
} from '../../orchestrator/src/core/daemon/view/action-queue.ts'
import {
  buildProgressView,
  type AggregateReader,
  type ProgressAggregates,
  type ProposalNode,
  type ProposalReader,
  type ProgressTaskRow,
  type ProgressTaskStore,
} from '../../orchestrator/src/core/daemon/view/progress.ts'
import { buildSessionsView } from '../../orchestrator/src/core/daemon/view/sessions.ts'
import { listTerminalEvents } from '../../orchestrator/src/core/daemon/view/terminal-events.ts'
import {
  listReleaseNotes,
  type ReleaseNoteSpec,
  type TaskStoreForReleaseNotes,
} from '../../orchestrator/src/core/daemon/view/release-notes.ts'
import { openTraceEventStore } from '../../orchestrator/src/core/lib/trace-events-store.ts'
import { MARS_VERSION } from '../../orchestrator/src/version.ts'
import {
  isProposalSource,
  type ProposalSource,
} from '../../orchestrator/src/core/proposals.ts'
import type {
  DraftFeature,
  StaleWorktreeAlert,
  StepSpan,
} from '../../orchestrator/src/core/daemon/http-server.ts'
import type { DaemonActionResult } from './daemonHttp.ts'

const parseJsonObj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Normalise modern epoch timestamps and legacy ISO fixture values. */
const toEpochMillis = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * Discover which columns a seeded table actually has, so a single SELECT can
 * be built that references only present columns (the integration tests seed
 * partial / legacy schemas — querying an absent column throws). Returns an
 * empty set when the table itself is absent.
 */
const tableColumns = async (
  client: Client,
  table: string,
): Promise<Set<string>> => {
  try {
    const r = await client.execute(`PRAGMA table_info(${table})`)
    return new Set(
      r.rows.map((row) => (row as unknown as { name: string }).name),
    )
  } catch {
    return new Set()
  }
}

/** State-store adapter over the seeded `action_queue_items` table. */
const makeStateStore = (dbPath: string): ActionQueueStateStore => {
  const client = createClient({ url: `file:${dbPath}` })
  const mapRow = (row: Record<string, unknown>): PersistedActionQueueRow => {
    const raisedAt = toEpochMillis(row.raised_at)
    return {
      id: row.id as string,
      kind: row.kind as string,
      priority: row.priority as string,
      title: (row.title as string) ?? '',
      body: (row.body as string) ?? '',
      payload: parseJsonObj(row.payload),
      context: parseJsonObj(row.context),
      raisedAt,
      lastSeenAt: toEpochMillis(row.last_seen_at, raisedAt),
      signature: (row.signature as string | null) ?? null,
    }
  }
  return {
    listOpenActionQueueItems: async () => {
      try {
        const r = await client.execute(
          `SELECT id, kind, priority, title, body, payload, context, raised_at, last_seen_at, signature
             FROM action_queue_items WHERE state = 'open' ORDER BY raised_at DESC`,
        )
        return r.rows.map((row) => mapRow(row as unknown as Record<string, unknown>))
      } catch {
        // action_queue_items may not exist on a fresh repo.
        return []
      }
    },
    listResolvedActionQueueItems: async ({ limit, cursor }) => {
      try {
        const r = await client.execute({
          sql: `SELECT id, kind, priority, title, body, payload, context, raised_at, last_seen_at, signature,
                       resolved_at, resolution, resolution_note, root_cause, resolved_by
                  FROM action_queue_items
                 WHERE state = 'resolved'${cursor ? ' AND resolved_at < ?' : ''}
                 ORDER BY resolved_at DESC LIMIT ?`,
          args: cursor ? [cursor, (limit ?? 50) + 1] : [(limit ?? 50) + 1],
        })
        const rows = r.rows.map((row) => {
          const r0 = row as unknown as Record<string, unknown>
          return {
            ...mapRow(r0),
            // Nullish (not strict-null) guard: a column absent from the seeded
            // fixture arrives as `undefined`, which must stay `null` rather
            // than normalising to epoch 0.
            resolvedAt: r0.resolved_at == null ? null : toEpochMillis(r0.resolved_at),
            resolution: (r0.resolution as string | null) ?? null,
            resolutionNote: (r0.resolution_note as string | null) ?? null,
            rootCause: (r0.root_cause as string | null) ?? null,
            resolvedBy: (r0.resolved_by as string | null) ?? null,
          }
        })
        const lim = limit ?? 50
        const page = rows.slice(0, lim)
        const lastResolvedAt = page[page.length - 1]?.resolvedAt
        const nextCursor =
          rows.length > lim && lastResolvedAt != null ? String(lastResolvedAt) : null
        return { items: page, nextCursor }
      } catch {
        return { items: [], nextCursor: null }
      }
    },
  }
}

/**
 * Task-store adapter over the seeded `tasks` + `task_blockers` tables.
 *
 * Unlike the production loader (`listActionQueueTaskGraph` in app-services),
 * this one ignores the supplied rows and returns every task in the fixture.
 * The view only reads the returned tasks through id-keyed maps, so a superset
 * is behaviourally identical; the row-scoping in production is a query-cost
 * optimisation over a real queue, and replicating its recursive CTE here would
 * add a second copy of that logic to keep in sync for no test-visible gain.
 */
const makeTaskStore = (dbPath: string): ActionQueueTaskStore => {
  const client = createClient({ url: `file:${dbPath}` })
  return {
    listTasksForActionQueueItems: async (): Promise<TaskForActionQueue[]> => {
      let tasks: Record<string, unknown>[] = []
      try {
        const r = await client.execute(
          `SELECT id, status, prompt, branch, updated_at, parent_proposal_id FROM tasks`,
        )
        tasks = r.rows as unknown as Record<string, unknown>[]
      } catch {
        return []
      }
      const blockedByMap = new Map<string, string[]>()
      try {
        const b = await client.execute(
          `SELECT task_id, blocker_task_id FROM task_blockers`,
        )
        for (const row of b.rows) {
          const r = row as unknown as { task_id: string; blocker_task_id: string }
          const arr = blockedByMap.get(r.task_id) ?? []
          arr.push(r.blocker_task_id)
          blockedByMap.set(r.task_id, arr)
        }
      } catch {
        // task_blockers may not exist.
      }
      return tasks.map((t) => ({
        id: t.id as string,
        status: t.status as string,
        prompt: (t.prompt as string) ?? '',
        blockedBy: blockedByMap.get(t.id as string) ?? [],
        parentProposalId: (t.parent_proposal_id as string | null) ?? null,
        failureSignature: null,
        branch: (t.branch as string | null) ?? null,
        updatedAt: (t.updated_at as string) ?? '',
        fixForTaskId: null,
      }))
    },
  }
}

/**
 * Build the blocker map (taskId → blockerTaskId[]) from `task_blockers`.
 * Tolerates an absent table.
 */
const loadBlockerMap = async (client: Client): Promise<Map<string, string[]>> => {
  const map = new Map<string, string[]>()
  try {
    const r = await client.execute(
      `SELECT task_id, blocker_task_id FROM task_blockers`,
    )
    for (const row of r.rows) {
      const r0 = row as unknown as { task_id: string; blocker_task_id: string }
      const arr = map.get(r0.task_id) ?? []
      arr.push(r0.blocker_task_id)
      map.set(r0.task_id, arr)
    }
  } catch {
    // task_blockers may not exist on a legacy / partial schema.
  }
  return map
}

/**
 * `/view/tasks` — mirrors `appServices.viewTasks()` (`{ tasks }`). Selects only
 * the columns present in the seeded schema so it tolerates the partial / legacy
 * `tasks` tables the integration tests create, and shapes each row to validate
 * against the UI's `tasksResponseSchema` (every required field is emitted).
 */
const viewTasks = async (dbPath: string): Promise<{ tasks: unknown[] }> => {
  const client = createClient({ url: `file:${dbPath}` })
  const cols = await tableColumns(client, 'tasks')
  if (cols.size === 0) return { tasks: [] }

  const pick = (name: string): string =>
    cols.has(name) ? name : `NULL AS ${name}`
  const select = [
    'id',
    'prompt',
    'status',
    pick('plan_functional'),
    pick('plan_technical'),
    pick('branch'),
    pick('worktree_path'),
    pick('error'),
    pick('failure_signature'),
    pick('drop_reason'),
    cols.has('retry_count') ? 'retry_count' : '0 AS retry_count',
    pick('parent_proposal_id'),
    pick('origin_id'),
    pick('fix_for_task_id'),
    pick('kind'),
    'created_at',
    'updated_at',
  ].join(', ')

  let rows: Record<string, unknown>[] = []
  try {
    const r = await client.execute(`SELECT ${select} FROM tasks ORDER BY created_at ASC`)
    rows = r.rows as unknown as Record<string, unknown>[]
  } catch {
    return { tasks: [] }
  }

  const blockerMap = await loadBlockerMap(client)
  const tasks = rows.map((ro) => {
    const f = (ro.plan_functional as string | null) ?? null
    const t = (ro.plan_technical as string | null) ?? null
    return {
      id: ro.id as string,
      prompt: (ro.prompt as string) ?? '',
      status: ro.status as string,
      plan:
        f !== null || t !== null
          ? { functional: f ?? '', technical: t ?? '' }
          : null,
      branch: (ro.branch as string | null) ?? null,
      worktreePath: (ro.worktree_path as string | null) ?? null,
      error: (ro.error as string | null) ?? null,
      failureSignature: (ro.failure_signature as string | null) ?? null,
      dropReason: (ro.drop_reason as string | null) ?? null,
      retryCount: Number(ro.retry_count ?? 0),
      blockerTaskId: blockerMap.get(ro.id as string)?.[0] ?? null,
      blockedBy: blockerMap.get(ro.id as string) ?? [],
      parentProposalId: (ro.parent_proposal_id as string | null) ?? null,
      spec: null,
      originId: (ro.origin_id as string | null) ?? null,
      fixForTaskId: (ro.fix_for_task_id as string | null) ?? null,
      kind: (ro.kind as string | null) ?? null,
      createdAt: (ro.created_at as string) ?? '',
      updatedAt: (ro.updated_at as string) ?? '',
    }
  })
  return { tasks }
}

/**
 * Schema-tolerant {@link ProgressTaskStore}. The daemon's
 * `createProgressTaskStore` assumes the full modern schema (`task_spec_files`,
 * `origin_id`, `read_first_json`, …); the integration tests seed partial
 * schemas, so we build the SELECT from the columns that actually exist and feed
 * the result to the SAME pure `buildProgressView`.
 */
const makeProgressTaskStore = (
  client: Client,
  cols: Set<string>,
  blockerMap: Map<string, string[]>,
): ProgressTaskStore => ({
  async listProgressTasks(): Promise<ProgressTaskRow[]> {
    const pick = (name: string): string =>
      cols.has(name) ? name : `NULL AS ${name}`
    const select = [
      'id',
      'prompt',
      pick('intent'),
      'status',
      pick('plan_functional'),
      pick('plan_technical'),
      pick('branch'),
      pick('worktree_path'),
      pick('error'),
      pick('failure_signature'),
      pick('drop_reason'),
      cols.has('retry_count') ? 'retry_count' : '0 AS retry_count',
      pick('parent_proposal_id'),
      pick('read_first_json'),
      pick('prescriptive_action'),
      pick('verify_cmd'),
      pick('merge_mode'),
      pick('origin_id'),
      pick('fix_for_task_id'),
      pick('kind'),
      'created_at',
      'updated_at',
    ].join(', ')

    let rows: Record<string, unknown>[] = []
    try {
      const r = await client.execute(`SELECT ${select} FROM tasks ORDER BY created_at ASC`)
      rows = r.rows as unknown as Record<string, unknown>[]
    } catch {
      return []
    }

    return rows.map((ro) => ({
      id: ro.id as string,
      prompt: (ro.prompt as string) ?? '',
      intent: (ro.intent as string | null) ?? null,
      status: ro.status as string,
      planFunctional: (ro.plan_functional as string | null) ?? null,
      planTechnical: (ro.plan_technical as string | null) ?? null,
      branch: (ro.branch as string | null) ?? null,
      worktreePath: (ro.worktree_path as string | null) ?? null,
      error: (ro.error as string | null) ?? null,
      failureSignature: (ro.failure_signature as string | null) ?? null,
      dropReason: (ro.drop_reason as string | null) ?? null,
      retryCount: Number(ro.retry_count ?? 0),
      blockerTaskId: blockerMap.get(ro.id as string)?.[0] ?? null,
      blockedBy: blockerMap.get(ro.id as string) ?? [],
      parentProposalId: (ro.parent_proposal_id as string | null) ?? null,
      // task_spec_files isn't seeded in the integration fixtures; the pure
      // builder treats a null filesJson as "no files".
      filesJson: null,
      readFirstJson: (ro.read_first_json as string | null) ?? null,
      prescriptiveAction: (ro.prescriptive_action as string | null) ?? null,
      verifyCmd: (ro.verify_cmd as string | null) ?? null,
      doneCriteriaJson: null,
      mergeMode: (ro.merge_mode as string | null) ?? null,
      originId: (ro.origin_id as string | null) ?? null,
      fixForTaskId: (ro.fix_for_task_id as string | null) ?? null,
      kind: (ro.kind as string | null) ?? null,
      createdAt: (ro.created_at as string) ?? '',
      updatedAt: (ro.updated_at as string) ?? '',
    }))
  },
})

/**
 * SQLite-compatible ProposalReader. The daemon's `createProposalReader` uses
 * PostgreSQL-specific SQL (`to_regclass`); this adapter uses PRAGMA/catch to
 * tolerate a missing proposals table in legacy fixtures.
 */
const makeProposalReader = (client: Client): ProposalReader => ({
  async listByIds(ids: string[]): Promise<ProposalNode[]> {
    if (ids.length === 0) return []
    try {
      const placeholders = ids.map(() => '?').join(', ')
      const r = await client.execute({
        sql: `SELECT id, title, status, source FROM proposals WHERE id IN (${placeholders})`,
        args: ids,
      })
      return r.rows.map((row) => {
        const ro = row as unknown as Record<string, unknown>
        const src = ro.source
        const source: ProposalSource = isProposalSource(src) ? src : 'human'
        return {
          id: ro.id as string,
          title: (ro.title as string | null) ?? '',
          status: (ro.status as string | null) ?? 'draft',
          source,
        }
      })
    } catch {
      return []
    }
  },
})

/**
 * SQLite-compatible AggregateReader. The daemon's `createAggregateReader` uses
 * PostgreSQL `to_char` / `interval`; this adapter uses `datetime('now', '-1 day')`
 * which is the SQLite equivalent.
 */
const makeAggregateReader = (client: Client): AggregateReader => ({
  async readAggregates(): Promise<ProgressAggregates> {
    try {
      const r = await client.execute(`
        SELECT
          (SELECT COUNT(*) FROM tasks WHERE status = 'done'
             AND updated_at >= datetime('now', '-1 day')) AS done_today,
          (SELECT COUNT(*) FROM tasks WHERE status = 'done') AS done_total,
          (SELECT COUNT(*) FROM tasks WHERE status = 'failed' AND fix_for_task_id IS NULL) AS failed_open
      `)
      const row = r.rows[0] as unknown as Record<string, unknown>
      return {
        doneToday: Number(row?.done_today ?? 0),
        doneTotal: Number(row?.done_total ?? 0),
        failedOpen: Number(row?.failed_open ?? 0),
      }
    } catch {
      return { doneToday: 0, doneTotal: 0, failedOpen: 0 }
    }
  },
})

/**
 * `/view/progress` — mirrors `appServices.viewProgress()`
 * (`{ tasks, proposals }`) by feeding a schema-tolerant store to the SAME pure
 * `buildProgressView` + local SQLite-compatible readers.
 */
const viewProgress = async (
  dbPath: string,
): Promise<ReturnType<typeof buildProgressView> extends Promise<infer T> ? T : never> => {
  const client = createClient({ url: `file:${dbPath}` })
  const cols = await tableColumns(client, 'tasks')
  if (cols.size === 0) return { tasks: [], proposals: [], aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 } }
  const blockerMap = await loadBlockerMap(client)
  return buildProgressView(
    makeProgressTaskStore(client, cols, blockerMap),
    makeProposalReader(client),
    makeAggregateReader(client),
  )
}

/** Task-store adapter for the terminal-events feed. Tolerates an absent table. */
const makeTerminalEventsStore = (client: Client, cols: Set<string>) => ({
  async listTasks() {
    if (cols.size === 0) return []
    try {
      const retry = cols.has('retry_count') ? 'retry_count' : '0 AS retry_count'
      const r = await client.execute(
        `SELECT id, prompt, status, ${retry}, updated_at FROM tasks`,
      )
      return r.rows.map((row) => {
        const ro = row as unknown as Record<string, unknown>
        return {
          id: ro.id as string,
          prompt: (ro.prompt as string) ?? '',
          status: ro.status as string,
          retryCount: Number(ro.retry_count ?? 0),
          updatedAt: (ro.updated_at as string) ?? '',
        }
      })
    } catch {
      return []
    }
  },
})

/** Task-store adapter for the release-notes feed. Tolerates partial schemas. */
const makeReleaseNotesStore = (
  client: Client,
  cols: Set<string>,
): TaskStoreForReleaseNotes => ({
  async listTasks() {
    if (cols.size === 0) return []
    const pick = (name: string): string =>
      cols.has(name) ? name : `NULL AS ${name}`
    const select = [
      'id',
      pick('intent'),
      'prompt',
      'status',
      'updated_at',
      // origin_id may be absent on legacy rows — fall back to id so each task
      // forms its own single-task arc (matches the migration's backfill).
      cols.has('origin_id') ? 'origin_id' : 'id AS origin_id',
      pick('fix_for_task_id'),
      pick('kind'),
    ].join(', ')
    let rows: Record<string, unknown>[] = []
    try {
      const r = await client.execute(`SELECT ${select} FROM tasks`)
      rows = r.rows as unknown as Record<string, unknown>[]
    } catch {
      return []
    }
    return rows.map((ro) => ({
      id: ro.id as string,
      intent: (ro.intent as string | null) ?? '',
      prompt: (ro.prompt as string) ?? '',
      status: ro.status as string,
      updatedAt: (ro.updated_at as string) ?? '',
      originId: ((ro.origin_id as string | null) ?? (ro.id as string)) || (ro.id as string),
      fixForTaskId: (ro.fix_for_task_id as string | null) ?? null,
      kind: (ro.kind as string | null) ?? undefined,
      // task_spec_files / done-criteria aren't seeded in the integration
      // fixtures, so no spec is reconstructed here.
      spec: null as ReleaseNoteSpec | null,
    }))
  },
})

/**
 * `/view/proposals` — mirrors `appServices.viewProposals()`
 * (`{ drafts, staleWorktrees }`). Replicates the AppServices logic directly:
 * draft proposals from `proposals` (+ optional `proposal_user_stories`), and
 * stale-worktree alerts from open `action_queue_items` rows of that kind. Both
 * sources tolerate an absent table.
 */
const viewProposals = async (
  dbPath: string,
): Promise<{ drafts: DraftFeature[]; staleWorktrees: StaleWorktreeAlert[] }> => {
  const client = createClient({ url: `file:${dbPath}` })

  const drafts: DraftFeature[] = []
  try {
    const tablesResult = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'`,
    )
    if (tablesResult.rows.length > 0) {
      const r = await client.execute(
        `SELECT p.id, p.title, p.problem, p.solution, p.status, p.source,
                p.created_at, p.updated_at
           FROM proposals p
          WHERE p.status = 'draft'
          ORDER BY p.created_at DESC`,
      )
      const storiesMap = new Map<string, string[]>()
      if (r.rows.length > 0) {
        try {
          const ids = r.rows.map((row) => (row as unknown as { id: string }).id)
          const placeholders = ids.map(() => '?').join(', ')
          const storiesResult = await client.execute({
            sql: `SELECT proposal_id, text FROM proposal_user_stories
                   WHERE proposal_id IN (${placeholders})
                   ORDER BY proposal_id, position ASC`,
            args: ids,
          })
          for (const row of storiesResult.rows) {
            const r0 = row as unknown as { proposal_id: string; text: string }
            const arr = storiesMap.get(r0.proposal_id) ?? []
            arr.push(r0.text)
            storiesMap.set(r0.proposal_id, arr)
          }
        } catch {
          // proposal_user_stories may not exist on a partial schema.
        }
      }
      for (const row of r.rows) {
        const r0 = row as unknown as Record<string, unknown>
        const src = r0.source
        const source: DraftFeature['source'] = isProposalSource(src) ? src : 'human'
        const stories = storiesMap.get(r0.id as string) ?? []
        drafts.push({
          id: r0.id as string,
          title: (r0.title as string | null) ?? '',
          problem: (r0.problem as string | null) ?? '',
          solution: (r0.solution as string | null) ?? '',
          status: (r0.status as string | null) ?? 'draft',
          source,
          createdAt: Number(r0.created_at ?? 0),
          updatedAt: Number(r0.updated_at ?? 0),
          acceptanceCount: stories.length,
          userStories: stories,
        })
      }
    }
  } catch {
    // proposals table absent — no drafts.
  }

  const staleWorktrees: StaleWorktreeAlert[] = []
  try {
    const r = await client.execute(
      `SELECT context, payload, last_seen_at, raised_at
         FROM action_queue_items
        WHERE kind = 'stale-worktree' AND state = 'open'
        ORDER BY raised_at DESC`,
    )
    for (const row of r.rows) {
      const r0 = row as unknown as Record<string, unknown>
      const ctx = parseJsonObj(r0.context)
      const pld = parseJsonObj(r0.payload)
      const taskId = typeof ctx.taskId === 'string' ? ctx.taskId : null
      if (!taskId) continue
      staleWorktrees.push({
        taskId,
        status: typeof pld.status === 'string' ? pld.status : 'unknown',
        ageHours: typeof pld.ageHours === 'number' ? pld.ageHours : 0,
        // `last_seen_at` / `raised_at` are epoch milliseconds; the alert
        // carries an ISO-8601 string. Mirrors `viewTodo` in app-services.
        // The old `typeof === 'string'` guards silently fell through to
        // "now" for every alert once the columns became epoch integers —
        // both arms were `string`, so no type error surfaced it.
        updatedAt: new Date(
          toEpochMillis(r0.last_seen_at, toEpochMillis(r0.raised_at, Date.now())),
        ).toISOString(),
        prompt: typeof pld.prompt === 'string' ? pld.prompt : '',
        error: typeof pld.error === 'string' ? pld.error : null,
        branch: typeof pld.branch === 'string' ? pld.branch : null,
        blockerTaskId: null,
      })
    }
  } catch {
    // action_queue_items table absent — no stale worktrees.
  }

  return { drafts, staleWorktrees }
}

/**
 * `/view/step-spans` — mirrors `appServices.viewStepSpans()` (`{ spans }`).
 * Reads the seeded trace-event store and replicates the daemon's step pairing
 * logic: pair each `step_started` with its matching `step_ended` (keyed on
 * workflowInstanceId + stepName) and sort ascending by `startedAt`.
 */
const viewStepSpans = async (
  dbPath: string,
  originId: string | undefined,
  taskId: string | undefined,
): Promise<{ spans: StepSpan[] }> => {
  const store = await openTraceEventStore(dbPath)
  try {
    const [started, ended] = await Promise.all([
      store.query({ originId, taskId, kind: ['step_started'], limit: 1000 }),
      store.query({ originId, taskId, kind: ['step_ended'], limit: 1000 }),
    ])

    const endedMap = new Map<string, (typeof ended)[number]>()
    for (const e of ended) {
      const wfId = e.payload.workflowInstanceId
      const stepName = e.payload.stepName
      if (typeof wfId === 'string' && typeof stepName === 'string') {
        endedMap.set(`${wfId}\0${stepName}`, e)
      }
    }

    const spans = started
      .map((s): StepSpan => {
        const wfId = s.payload.workflowInstanceId
        const stepName = s.payload.stepName
        const key =
          typeof wfId === 'string' && typeof stepName === 'string'
            ? `${wfId}\0${stepName}`
            : null
        const endEvent = key ? endedMap.get(key) : undefined
        return {
          stepName: typeof stepName === 'string' ? stepName : '',
          phase: s.phase,
          workflowInstanceId: typeof wfId === 'string' ? wfId : '',
          workerName:
            typeof s.payload.workerName === 'string' ? s.payload.workerName : null,
          outcome: endEvent
            ? typeof endEvent.payload.outcome === 'string'
              ? endEvent.payload.outcome
              : 'completed'
            : 'running',
          startedAt: new Date(s.timestamp).toISOString(),
          endedAt: endEvent ? new Date(endEvent.timestamp).toISOString() : null,
          durationMs:
            endEvent && typeof endEvent.payload.durationMs === 'number'
              ? endEvent.payload.durationMs
              : null,
          taskId: s.taskId,
          originId: s.originId,
          evalResults: Array.isArray(endEvent?.payload.evalResults)
            ? (endEvent.payload.evalResults as StepSpan['evalResults'])
            : undefined,
        }
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))

    return { spans }
  } finally {
    await store.close()
  }
}

/**
 * `/view/framework-update` — mirrors `appServices.viewFrameworkUpdate()`. Reads
 * the `.mars/update.json` poller cache when present; otherwise returns the
 * "no update" default. `selfUpdatable` is hard-coded false in tests (the dev
 * tsx-wrapper install can't self-replace).
 */
const viewFrameworkUpdate = async (repo: string) => {
  const cacheFile = resolve(repo, '.mars', 'update.json')
  try {
    const raw = await readFile(cacheFile, 'utf8')
    const cached = JSON.parse(raw) as Record<string, unknown>
    return { ...cached, selfUpdatable: false }
  } catch {
    return {
      installed: MARS_VERSION,
      latest: MARS_VERSION,
      available: false,
      checkedAt: null,
      releaseUrl: null,
      selfUpdatable: false,
    }
  }
}

/**
 * `/events` — the daemon's unified trace surface (proxied by the UI as
 * `/api/trace-events`). Returns `{ events, nextCursor }`. Only the simple
 * filters the UI actually sends are honoured; cursor pagination is omitted
 * (nextCursor is always null) since the integration fixtures never page.
 */
const viewTraceEvents = async (
  dbPath: string,
  params: URLSearchParams,
): Promise<{ events: unknown[]; nextCursor: string | null }> => {
  const store = await openTraceEventStore(dbPath)
  try {
    const taskId = params.get('taskId') ?? undefined
    const originId = params.get('originId') ?? undefined
    const q = params.get('q') ?? undefined
    const limitRaw = params.get('limit')
    const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : undefined
    const events = await store.query({ taskId, originId, q, limit })
    return { events, nextCursor: null }
  } finally {
    await store.close()
  }
}

/**
 * Build a `proxyGet` stub bound to a seeded repo. It serves the daemon view
 * endpoints the UI server proxies, sourced from the repo's `.mars/mars.db`, via
 * the same view builders the daemon's AppServices use. Unhandled paths return a
 * 404 so an accidental new proxy call surfaces loudly in tests rather than
 * silently returning empty data.
 */
export const makeDaemonStub = (
  repo: string,
): ((stateDir: string, path: string) => Promise<DaemonActionResult>) => {
  const dbPath = resolve(repo, '.mars/mars.db')
  return async (_stateDir, path) => {
    const url = new URL(path, 'http://stub')

    if (url.pathname === '/view/action-queue') {
      const filterRaw = url.searchParams.get('filter')
      const rows = await buildActionQueueView({
        stateStore: makeStateStore(dbPath),
        taskStore: makeTaskStore(dbPath),
        repoRoot: repo,
        filter: filterRaw === 'all' ? 'all' : 'open',
      })
      return { status: 200, body: rows }
    }

    if (url.pathname === '/view/action-queue/history') {
      const limitRaw = url.searchParams.get('limit')
      const result = await buildActionQueueHistoryView({
        stateStore: makeStateStore(dbPath),
        taskStore: makeTaskStore(dbPath),
        repoRoot: repo,
        limit: limitRaw !== null ? Number.parseInt(limitRaw, 10) : undefined,
        cursor: url.searchParams.get('cursor'),
      })
      return { status: 200, body: result }
    }

    if (url.pathname === '/view/tasks') {
      return { status: 200, body: await viewTasks(dbPath) }
    }

    {
      const taskByIdMatch = url.pathname.match(/^\/view\/tasks\/([^/?]+)$/)
      if (taskByIdMatch?.[1]) {
        const taskId = decodeURIComponent(taskByIdMatch[1])
        const { tasks } = await viewTasks(dbPath)
        const found = (tasks as Array<{ id: string }>).find((t) => t.id === taskId)
        if (!found) return { status: 404, body: { error: 'not_found', id: taskId } }
        return { status: 200, body: { task: found } }
      }
    }

    if (url.pathname === '/view/progress') {
      return { status: 200, body: await viewProgress(dbPath) }
    }

    if (url.pathname === '/view/step-spans') {
      return {
        status: 200,
        body: await viewStepSpans(
          dbPath,
          url.searchParams.get('originId') ?? undefined,
          url.searchParams.get('taskId') ?? undefined,
        ),
      }
    }

    if (url.pathname === '/view/sessions') {
      const agentName = url.searchParams.get('agentName') ?? ''
      const store = await openTraceEventStore(dbPath)
      try {
        const body = await buildSessionsView(store, agentName)
        return { status: 200, body }
      } finally {
        await store.close()
      }
    }

    if (url.pathname === '/view/proposals') {
      return { status: 200, body: await viewProposals(dbPath) }
    }

    if (url.pathname === '/view/terminal-events') {
      const client = createClient({ url: `file:${dbPath}` })
      const cols = await tableColumns(client, 'tasks')
      const events = await listTerminalEvents(makeTerminalEventsStore(client, cols))
      return { status: 200, body: { events } }
    }

    if (url.pathname === '/view/release-notes') {
      const client = createClient({ url: `file:${dbPath}` })
      const cols = await tableColumns(client, 'tasks')
      const entries = await listReleaseNotes(makeReleaseNotesStore(client, cols))
      return { status: 200, body: { entries } }
    }

    if (url.pathname === '/view/framework-update') {
      return { status: 200, body: await viewFrameworkUpdate(repo) }
    }

    if (url.pathname === '/events') {
      return { status: 200, body: await viewTraceEvents(dbPath, url.searchParams) }
    }

    return { status: 404, body: { error: `daemon stub: unhandled ${path}` } }
  }
}
