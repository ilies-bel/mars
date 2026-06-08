/**
 * Test-only daemon stub for {@link startServer}.
 *
 * The UI server proxies daemon view endpoints (`/view/action-queue`,
 * `/view/action-queue/history`, …) rather than re-deriving them, so the
 * daemon's `buildActionQueueView` stays the single source of truth for the
 * action-queue projection. In tests there is no daemon, so we inject this
 * `proxyGet` stub: it reads the same seeded SQLite fixture the test wrote and
 * serves the view via the SAME `buildActionQueueView`/`buildActionQueueHistoryView`
 * the daemon uses. That keeps the tests asserting the canonical projection
 * instead of a hand-authored fixture that could drift from production (the
 * drift that commit b89c57ce introduced and this stub exists to prevent).
 */
import { createClient } from '@libsql/client'
import { resolve } from 'node:path'

import {
  buildActionQueueView,
  buildActionQueueHistoryView,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
  type PersistedActionQueueRow,
  type TaskForActionQueue,
} from '../../orchestrator/src/core/daemon/view/action-queue.ts'
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

/** State-store adapter over the seeded `action_queue_items` table. */
const makeStateStore = (dbPath: string): ActionQueueStateStore => {
  const client = createClient({ url: `file:${dbPath}` })
  const mapRow = (row: Record<string, unknown>): PersistedActionQueueRow => ({
    id: row.id as string,
    kind: row.kind as string,
    priority: row.priority as string,
    title: (row.title as string) ?? '',
    body: (row.body as string) ?? '',
    payload: parseJsonObj(row.payload),
    context: parseJsonObj(row.context),
    raisedAt: (row.raised_at as string) ?? '',
    lastSeenAt: (row.last_seen_at as string) ?? (row.raised_at as string) ?? '',
    signature: (row.signature as string | null) ?? null,
  })
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
            resolvedAt: (r0.resolved_at as string | null) ?? null,
            resolution: (r0.resolution as string | null) ?? null,
            resolutionNote: (r0.resolution_note as string | null) ?? null,
            rootCause: (r0.root_cause as string | null) ?? null,
            resolvedBy: (r0.resolved_by as string | null) ?? null,
          }
        })
        const lim = limit ?? 50
        const page = rows.slice(0, lim)
        const nextCursor =
          rows.length > lim ? (page[page.length - 1]?.resolvedAt ?? null) : null
        return { items: page, nextCursor }
      } catch {
        return { items: [], nextCursor: null }
      }
    },
  }
}

/** Task-store adapter over the seeded `tasks` + `task_blockers` tables. */
const makeTaskStore = (dbPath: string): ActionQueueTaskStore => {
  const client = createClient({ url: `file:${dbPath}` })
  return {
    listTasks: async (): Promise<TaskForActionQueue[]> => {
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
 * Build a `proxyGet` stub bound to a seeded repo. It serves the daemon view
 * endpoints the UI server proxies, sourced from the repo's `.mars/mars.db`.
 * Unhandled paths return a 404 so an accidental new proxy call surfaces loudly
 * in tests rather than silently returning empty data.
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
    return { status: 404, body: { error: `daemon stub: unhandled ${path}` } }
  }
}
