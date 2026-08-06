/**
 * Tests for GET /chat/threads/:id/ui-stream — the daemon-native, resumable
 * UIMessage-chunk SSE that replaced the client-side chat-delta mapping.
 *
 * Covers: the versioned protocol preamble, send-mode buffer replay, live
 * fan-out, run sealing closing the stream, resume-mode 204 when idle, and
 * lastEventId dedup on reconnect.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { ChatStreamHub } from '../chat-stream-hub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-uistream-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

/** Read the whole SSE body until the reader closes (run sealed), or timeout. */
const readAll = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string> => {
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let acc = ''
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const winner = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
    ])
    if (winner === 'timeout') break
    const { done, value } = winner as ReadableStreamReadResult<Uint8Array>
    if (done) break
    acc += decoder.decode(value)
  }
  return acc
}

/** Read chunks until `predicate` matches the accumulated text, or timeout. */
const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string | null> => {
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let acc = ''
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const winner = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
    ])
    if (winner === 'timeout') return null
    const { done, value } = winner as ReadableStreamReadResult<Uint8Array>
    if (done) return predicate(acc) ? acc : null
    acc += decoder.decode(value)
    if (predicate(acc)) return acc
  }
  return null
}

describe('GET /chat/threads/:id/ui-stream', () => {
  it('204s in resume mode when there is no active run', async () => {
    const hub = new ChatStreamHub()
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ chatStreamHub: hub }))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/threads/t1/ui-stream?mode=resume`)
      expect(res.status).toBe(204)
      await res.body?.cancel().catch(() => {})
    } finally {
      await close()
    }
  })

  it('replays the buffer (protocol preamble + seeded chunks) in send mode, then closes on seal', async () => {
    const hub = new ChatStreamHub()
    // A run that has already produced output and sealed before the client connects.
    hub.startRun('t1')
    hub.publish('t1', { type: 'text', text: 'Hello world' })
    hub.publish('t1', { type: 'result', durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cost: 0 })
    hub.finishRun('t1')

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ chatStreamHub: hub }))
    const abort = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/threads/t1/ui-stream?mode=send`, {
        signal: abort.signal,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const body = await readAll(res.body!.getReader(), 2000)
      expect(body).toContain('event: protocol')
      expect(body).toContain('"v":1')
      expect(body).toContain('"type":"start"')
      expect(body).toContain('"type":"text-delta"')
      expect(body).toContain('Hello world')
      expect(body).toContain('"type":"finish"')
      // Every buffered chunk carries a <gen>.<seq> id.
      expect(body).toMatch(/id: \d+\.\d+/)
    } finally {
      abort.abort()
      await close()
    }
  })

  it('streams live chunks published after the client connects (resume mode, active run)', async () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1') // active, no output yet

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ chatStreamHub: hub }))
    const abort = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/threads/t1/ui-stream?mode=resume`, {
        signal: abort.signal,
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()

      // Publish AFTER the connection is established.
      hub.publish('t1', { type: 'text', text: 'live-token' })
      const seen = await readUntil(reader, (t) => t.includes('live-token'), 2000)
      expect(seen).not.toBeNull()

      // Sealing the run ends the stream (reader closes).
      hub.finishRun('t1')
      const rest = await readAll(reader, 2000)
      expect(rest).toContain('"type":"finish"')
    } finally {
      abort.abort()
      await close()
    }
  })

  it('honours lastEventId — replays only chunks after the cursor', async () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    hub.publish('t1', { type: 'text', text: 'AAA' }) // text-start (seq2) + text-delta (seq3)
    hub.publish('t1', { type: 'text', text: 'BBB' }) // text-delta (seq4)
    const snap = hub.snapshot('t1')!
    const gen = snap.gen

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ chatStreamHub: hub }))
    const abort = new AbortController()
    try {
      // Resume as if we already have everything through seq 3 (the AAA delta).
      const res = await fetch(
        `http://127.0.0.1:${port}/chat/threads/t1/ui-stream?mode=send&lastEventId=${gen}.3`,
        { signal: abort.signal },
      )
      const reader = res.body!.getReader()
      const seen = await readUntil(reader, (t) => t.includes('BBB'), 1500)
      expect(seen).not.toBeNull()
      // The already-seen AAA delta is NOT replayed.
      expect(seen).not.toContain('AAA')
    } finally {
      abort.abort()
      await close()
    }
  })

  it('204s when no stream hub is configured', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps()) // no chatStreamHub
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/threads/t1/ui-stream?mode=send`)
      expect(res.status).toBe(204)
      await res.body?.cancel().catch(() => {})
    } finally {
      await close()
    }
  })
})
