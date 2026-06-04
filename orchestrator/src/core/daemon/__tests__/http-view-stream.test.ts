/**
 * Tests for GET /view/stream — the daemon's SSE invalidation endpoint.
 *
 * Covers:
 *   - Response headers: Content-Type: text/event-stream
 *   - Greeting: event: hello emitted on connect
 *   - Fan-out: hub.broadcast('tasks') is received by connected clients within 1s
 *   - Cleanup: disconnecting a client removes it from the hub (no leak)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { ViewStreamHub } from '../view/stream-hub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<
  ReturnType<typeof loadRecipeCatalog>
> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-stream-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  recipeCatalog: cachedRecipeCatalog as Awaited<
    ReturnType<typeof loadRecipeCatalog>
  >,
  traceStore: nullTraceStore,
  viewTasks: async () => ({ tasks: [] }),
  viewProgress: async () => ({ tasks: [], proposals: [] }),
  actionQueueAck: async () => {},
  actionQueueResolve: async () => {},
  actionQueueDismiss: async () => {},
  todoDismiss: async () => {},
  viewActionQueue: async () => [],
  viewTodo: async () => ({ drafts: [], staleWorktrees: [] }),
  viewTerminalEvents: async () => ({ events: [] }),
  viewStepSpans: async () => ({ spans: [] }),
  viewSessions: async () => ({ sessions: [] }),
  viewFrameworkUpdate: async () => ({
    installed: '0.1.0',
    latest: '0.1.0',
    available: false,
    checkedAt: null,
    releaseUrl: null,
  }),
  ...overrides,
})

/**
 * Read SSE chunks from a response body reader until a chunk matching
 * `predicate` is found, or until the given timeout elapses.
 */
const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string | null> => {
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const readPromise = reader.read()
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), remaining),
    )
    const winner = await Promise.race([readPromise, timeoutPromise])
    if (winner === null) return null // timed out
    const { done, value } = winner as ReadableStreamReadResult<Uint8Array>
    if (done) return null
    const text = decoder.decode(value)
    if (predicate(text)) return text
  }
  return null
}

describe('GET /view/stream', () => {
  it('returns Content-Type: text/event-stream and emits event: hello', async () => {
    const hub = new ViewStreamHub()
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewStreamHub: hub }),
    )

    const abortCtrl = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/stream`, {
        signal: abortCtrl.signal,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const reader = res.body!.getReader()
      const chunk = await readUntil(
        reader,
        (t) => t.includes('event: hello'),
        1000,
      )
      expect(chunk).not.toBeNull()
      expect(chunk).toContain('event: hello')
      reader.cancel()
    } finally {
      abortCtrl.abort()
      await close()
    }
  })

  it('delivers a broadcast tasks event to connected clients within 1s', async () => {
    const hub = new ViewStreamHub()
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewStreamHub: hub }),
    )

    const abortCtrl = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/stream`, {
        signal: abortCtrl.signal,
      })
      const reader = res.body!.getReader()

      // Drain the hello greeting so the connection is established.
      const hello = await readUntil(
        reader,
        (t) => t.includes('event: hello'),
        1000,
      )
      expect(hello).not.toBeNull()

      // Now simulate a task-status transition (what server.ts does on bus events).
      hub.broadcast('tasks')

      // Assert the tasks event arrives within 1s.
      const tasksEvent = await readUntil(
        reader,
        (t) => t.includes('event: tasks'),
        1000,
      )
      expect(tasksEvent).not.toBeNull()
      expect(tasksEvent).toContain('event: tasks')
      reader.cancel()
    } finally {
      abortCtrl.abort()
      await close()
    }
  })

  it('removes the client from the hub when the connection closes (no leak)', async () => {
    const hub = new ViewStreamHub()
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewStreamHub: hub }),
    )

    const abortCtrl = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/stream`, {
        signal: abortCtrl.signal,
      })
      const reader = res.body!.getReader()

      // Wait for hello to confirm the client is registered.
      await readUntil(reader, (t) => t.includes('event: hello'), 1000)
      expect(hub.size()).toBe(1)

      // Disconnect the client.
      abortCtrl.abort()
      await reader.cancel().catch(() => {})

      // Give the 'close' event on the request time to fire and run cleanup.
      await new Promise<void>((r) => setTimeout(r, 100))
      expect(hub.size()).toBe(0)
    } finally {
      await close()
    }
  })
})
