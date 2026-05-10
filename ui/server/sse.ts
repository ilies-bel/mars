interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

export class SseHub {
  private clients = new Set<SseClient>()
  private encoder = new TextEncoder()

  add(controller: ReadableStreamDefaultController<Uint8Array>): SseClient {
    const client: SseClient = { controller, closed: false }
    this.clients.add(client)
    return client
  }

  remove(client: SseClient): void {
    client.closed = true
    this.clients.delete(client)
  }

  broadcast(event: string, data: unknown = {}): void {
    const payload = this.encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    for (const client of this.clients) {
      if (client.closed) {
        this.clients.delete(client)
        continue
      }
      try {
        client.controller.enqueue(payload)
      } catch {
        client.closed = true
        this.clients.delete(client)
      }
    }
  }

  size(): number {
    return this.clients.size
  }
}
