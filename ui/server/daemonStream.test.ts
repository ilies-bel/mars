/**
 * Tests for connectDaemonStream — the bridge that subscribes the UI server to
 * the daemon's /view/stream SSE endpoint and relays each channel event to all
 * connected browser clients via the SseHub.
 *
 * A fake Bun HTTP server stands in for the daemon. We subscribe a synthetic
 * SSE client to the hub (via hub.add) and assert that an event emitted by the
 * fake daemon reaches that client within 1 second.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectDaemonStream } from './daemonHttp.ts'
import { SseHub } from './sse.ts'

describe('connectDaemonStream', () => {
  let stateDir: string
  let fakeServer: ReturnType<typeof Bun.serve> | null = null

  afterEach(() => {
    if (fakeServer) {
      fakeServer.stop(true)
      fakeServer = null
    }
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('relays a tasks event from the daemon stream to hub subscribers within 1s', async () => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'mars-daemon-stream-test-'))

    // resolveConnected fires once the fake daemon's stream start() callback
    // runs — i.e. once the SSE connection is established server-side.
    let resolveConnected!: () => void
    const connectedPromise = new Promise<void>((r) => {
      resolveConnected = r
    })
    let sendEvent!: (event: string) => void

    fakeServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === '/view/stream') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder()
              sendEvent = (event: string) => {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: {}\n\n`),
                )
              }
              resolveConnected()
            },
          })
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    writeFileSync(join(stateDir, 'http.port'), String(fakeServer.port))

    const hub = new SseHub()
    const received: string[] = []

    // Attach a synthetic SSE client that records broadcast event names.
    hub.add({
      enqueue(chunk: Uint8Array) {
        const text = new TextDecoder().decode(chunk)
        const match = text.match(/^event: (\S+)/)
        if (match) received.push(match[1])
      },
      close() {},
      error() {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>)

    connectDaemonStream(stateDir, hub)

    // Wait until the fake daemon stream is open on the server side.
    await connectedPromise

    // Emit a 'tasks' event from the fake daemon.
    sendEvent('tasks')

    // Poll until the event arrives at the hub subscriber (≤1s).
    const deadline = Date.now() + 1000
    while (!received.includes('tasks') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(received).toContain('tasks')
  })
})
