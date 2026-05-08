import type { ServerResponse } from 'node:http'

export class SseHub {
  private clients = new Set<ServerResponse>()

  add(res: ServerResponse): void {
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  broadcast(event: string, data: unknown = {}): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(payload)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  size(): number {
    return this.clients.size
  }
}
