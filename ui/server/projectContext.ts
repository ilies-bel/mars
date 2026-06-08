import { TaskDb, StateDb } from './db.ts'
import { resolveRepo } from './repo.ts'
import type { RepoContext } from './repo.ts'
import { SseHub } from './sse.ts'
import { watchQueue } from './watch.ts'

export interface ProjectContextEntry {
  ctx: RepoContext
  db: TaskDb
  stateDb: StateDb
  hub: SseHub
}

/**
 * Creates a memoising factory for per-project context handles.
 *
 * The returned `getProjectContext` function is keyed by `projectId` (or `''`
 * for the default project). Handles are lazily initialised on the first
 * request and reused on every subsequent call — so the second request for
 * the same project gets the same open `TaskDb`, `StateDb`, `SseHub`, and
 * `watchQueue` unsubscribe handle rather than opening new ones.
 *
 * If `projectId` is not in the registry, `resolveRepo` throws an
 * `UnknownProjectError` synchronously. Because the factory is `async`, that
 * synchronous throw becomes a rejected Promise that callers can catch with
 * `instanceof UnknownProjectError`.
 */
export function createProjectContextCache(
  defaultRepo?: string,
): (projectId?: string) => Promise<ProjectContextEntry> {
  const cache = new Map<string, Promise<ProjectContextEntry>>()

  return function getProjectContext(projectId?: string): Promise<ProjectContextEntry> {
    const key = projectId ?? ''

    const cached = cache.get(key)
    if (cached) return cached

    const p: Promise<ProjectContextEntry> = (async (): Promise<ProjectContextEntry> => {
      // resolveRepo throws UnknownProjectError synchronously for an unknown
      // projectId. Inside an async IIFE that becomes a rejected Promise.
      const ctx = resolveRepo(
        projectId !== undefined ? { projectId } : { override: defaultRepo },
      )
      const db = new TaskDb(ctx.queueDbPath)
      await db.init()
      const stateDb = new StateDb(ctx.stateDbPath)
      await stateDb.init()
      const hub = new SseHub()
      watchQueue(ctx.queueDbPath, () => {
        hub.broadcast('tasks')
        hub.broadcast('proposals')
      })
      return { ctx, db, stateDb, hub }
    })()

    cache.set(key, p)
    // Remove the failed entry so the next call can retry (e.g. UnknownProjectError).
    p.catch(() => cache.delete(key))
    return p
  }
}
