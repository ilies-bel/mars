import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sse-stream-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('GET /events SSE stream', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()

    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      {
        proxyGet: makeDaemonStub(repo),
        // Short heartbeat so tests don't take 15 s each.
        sseHeartbeatMs: 100,
      },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('sends event: hello immediately on connect', async () => {
    const res = await fetch(`${baseUrl}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Read just enough to capture the hello event, then abort.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('event: hello')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    reader.cancel()
    expect(buffer).toContain('event: hello')
    expect(buffer).toContain('data: {}')
  })

  it('sends : ping heartbeat comments at the configured interval', async () => {
    const res = await fetch(`${baseUrl}/events`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Collect chunks for up to 1 second (10× the 100 ms heartbeat).
    const deadline = Date.now() + 1_000
    let buffer = ''
    while (Date.now() < deadline) {
      const readPromise = reader.read()
      const timeoutPromise = new Promise<{ value: undefined; done: true }>(
        (resolve) => setTimeout(() => resolve({ value: undefined, done: true }), 200),
      )
      const { value, done } = await Promise.race([readPromise, timeoutPromise])
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })
      if (buffer.includes(': ping')) break
    }
    reader.cancel()

    expect(buffer).toContain(': ping')
  })
})
