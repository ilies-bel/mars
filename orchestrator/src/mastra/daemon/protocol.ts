import type { Socket } from 'node:net'
import type { Author } from '../author'
import type { Task, TaskPlan } from '../queue'

export type DaemonRequest =
  | {
      op: 'add'
      prompt: string
      plan?: TaskPlan
      skipTriage?: boolean
      author?: Author
    }
  | {
      op: 'update'
      id: string
      patch: {
        status?: Task['status']
        plan?: TaskPlan | null
        branch?: string | null
        worktreePath?: string | null
        claudeSessionId?: string | null
        error?: string | null
      }
    }
  | { op: 'retry'; id: string }
  | { op: 'purge'; id: string }
  | { op: 'unblock'; id: string }
  | { op: 'promote'; suggestionId: string }
  | { op: 'refine'; id: string; refresh?: boolean }
  | {
      op: 'glossary-write'
      kind: 'set' | 'remove'
      term: string
      definition?: string
      aliases?: readonly string[]
    }
  | { op: 'adr-add'; title: string; body: string }
  | { op: 'status' }
  | { op: 'reload-config' }
  | { op: 'shutdown'; force?: boolean }
  | { op: 'ping' }
  | {
      op: 'spans'
      kind: SpansKind
      id: string
      limit?: number
      offset?: number
    }

export type SpansKind = 'by-run' | 'by-task' | 'by-trace'

export interface SpanRow {
  eventType: string | null
  timestamp: string | null
  traceId: string | null
  spanId: string | null
  parentSpanId: string | null
  experimentId: string | null
  entityType: string | null
  entityId: string | null
  entityName: string | null
  entityVersionId: string | null
  userId: string | null
  organizationId: string | null
  resourceId: string | null
  runId: string | null
  sessionId: string | null
  threadId: string | null
  requestId: string | null
  environment: string | null
  source: string | null
  serviceName: string | null
  requestContext: unknown
  name: string | null
  spanType: string | null
  isEvent: boolean | null
  endedAt: string | null
  attributes: unknown
  metadata: unknown
  tags: unknown
  scope: unknown
  links: unknown
  input: unknown
  output: unknown
  error: unknown
}

export interface SpansResponse {
  rows: SpanRow[]
  total: number
  truncated: boolean
}

export type DaemonResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

export interface DaemonStatusPayload {
  pid: number
  startedAt: string
  inFlight: ReadonlyArray<{
    taskId: string
    kind: 'triage' | 'implement' | 'refine' | 'glossary-write' | 'adr-add'
  }>
  counts: { draft: number; queued: number; running: number; verifying: number; merging: number }
}

const NEWLINE = 0x0a

export const writeLine = (sock: Socket, payload: unknown): boolean => {
  const line = `${JSON.stringify(payload)}\n`
  return sock.write(line)
}

export const readLines = (
  sock: Socket,
  onLine: (line: string) => void,
): void => {
  const chunks: Buffer[] = []
  let length = 0
  sock.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    length += chunk.length
    while (true) {
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length)
      if (chunks.length !== 1) {
        chunks.length = 0
        chunks.push(buf as Buffer)
      }
      const target = chunks[0] as Buffer
      const idx = target.indexOf(NEWLINE)
      if (idx === -1) return
      const line = target.subarray(0, idx).toString('utf8')
      const rest = target.subarray(idx + 1)
      chunks.length = 0
      length = rest.length
      if (rest.length > 0) chunks.push(rest)
      if (line.length > 0) onLine(line)
    }
  })
}
