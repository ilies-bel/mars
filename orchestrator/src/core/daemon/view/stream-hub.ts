import type { ServerResponse } from 'node:http'

export type StreamChannel = 'tasks' | 'progress' | 'action-queue' | 'proposals' | 'kpis'

interface StreamClient {
  res: ServerResponse
}

/**
 * Hub that tracks long-lived SSE connections to `GET /view/stream` and
 * fan-outs invalidation events to every connected client.
 *
 * One instance is created per daemon startup and passed into
 * `startHttpServer` via {@link HttpServerDeps}. The daemon's write sites
 * call `broadcast(channel)` whenever they mutate the corresponding store;
 * each connected UI client receives the event and re-fetches the relevant
 * view endpoint.
 *
 * The design mirrors `SseHub` in `ui/server/sse.ts` but wraps Node.js
 * `ServerResponse` objects rather than `ReadableStreamDefaultController`.
 */
export class ViewStreamHub {
  private clients = new Set<StreamClient>()

  /** Register a new SSE client. Returns the client reference for later removal. */
  add(res: ServerResponse): StreamClient {
    const client: StreamClient = { res }
    this.clients.add(client)
    return client
  }

  /** Deregister a client (call from the request 'close' handler). */
  remove(client: StreamClient): void {
    this.clients.delete(client)
  }

  /**
   * Send `event: <channel>\ndata: {}\n\n` to every live client. Clients
   * whose socket has already closed are silently pruned.
   */
  broadcast(channel: StreamChannel): void {
    const payload = `event: ${channel}\ndata: {}\n\n`
    for (const client of this.clients) {
      try {
        client.res.write(payload)
      } catch {
        // Dead socket — prune silently.
        this.clients.delete(client)
      }
    }
  }

  /** Number of currently connected clients. Useful for tests and logging. */
  size(): number {
    return this.clients.size
  }
}
