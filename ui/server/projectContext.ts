import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TaskDb, StateDb } from './db.ts'
import { resolveRepo } from './repo.ts'
import type { RepoContext } from './repo.ts'
import { SseHub } from './sse.ts'
import { watchQueue } from './watch.ts'
import { startChatBridge } from './chatBridge.ts'

export interface ProjectContextEntry {
  ctx: RepoContext
  db: TaskDb
  stateDb: StateDb
  hub: SseHub
}

export interface ProjectAdrEntry {
  number: number
  title: string
  slug: string
  path: string
}

export interface ProjectMeta {
  vision: string | null
  theme: string | null
}

/** ADR files written during one browser session, newest decision first. */
export const readSessionAdrs = (
  ctx: RepoContext,
  sessionStartedAt: number,
): ProjectAdrEntry[] => {
  const adrDir = join(ctx.repoRoot, 'docs', 'adr')
  if (!existsSync(adrDir)) return []

  return readdirSync(adrDir)
    .filter((filename) => filename.endsWith('.md'))
    .map((filename) => ({ filename, stat: statSync(join(adrDir, filename)) }))
    .filter(({ stat }) => stat.isFile() && stat.mtimeMs >= sessionStartedAt)
    .map(({ filename }) => {
      const match = filename.match(/^(\d+)-(.*)\.md$/)
      if (!match) return null
      const [, number, slug] = match
      return {
        number: Number(number),
        title: slug.replace(/-/g, ' '),
        slug,
        path: `docs/adr/${filename}`,
      }
    })
    .filter((adr): adr is ProjectAdrEntry => adr !== null)
    .sort((a, b) => b.number - a.number)
}

/** Product context is optional so new projects can grow it through chat. */
export const readProjectMeta = (ctx: RepoContext): ProjectMeta => {
  const readOptional = (filename: string): string | null => {
    const path = join(ctx.repoRoot, filename)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  return { vision: readOptional('VISION.md'), theme: readOptional('THEME.md') }
}

/** Returns a project-owned ADR only when its requested path stays in docs/adr. */
export const readProjectAdr = (ctx: RepoContext, path: string): string | null => {
  const filename = basename(path)
  if (path !== `docs/adr/${filename}` || !filename.endsWith('.md')) return null
  const adrPath = join(ctx.repoRoot, 'docs', 'adr', filename)
  return existsSync(adrPath) ? readFileSync(adrPath, 'utf8') : null
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
      // Bridge daemon live chat segments to the UI SSE hub so browsers receive
      // `chat-delta` events without polling.
      startChatBridge(ctx.stateDir, hub)
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
