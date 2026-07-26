/**
 * Stdio MCP server for dispatched worker sessions.
 *
 * Spawned once per dispatched Coder run via `mars mcp worker`. Reads the
 * origin task id from MARS_MCP_TASK_ID (injected into the worker env by the
 * dispatch path) and exposes exactly one tool — `mars_task_note` — that
 * appends a progress note to that task via the daemon `task.note` op.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio (MCP 2024-11-05).
 * Implements only the methods a dispatched agent session uses:
 *   initialize, notifications/initialized, tools/list, tools/call
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import type { DaemonRequest } from '../daemon/protocol.js'

const TaskNoteArgsSchema = z.object({
  body: z.string().min(1, 'body must be a non-empty string'),
})

export interface WorkerServerDeps {
  sendRequest: (req: DaemonRequest) => Promise<unknown>
}

export interface WorkerServerIO {
  input: Readable
  output: Writable
}

/**
 * Start a stdio MCP server for a dispatched worker session.
 *
 * @param env  - environment to read MARS_MCP_TASK_ID from (usually process.env)
 * @param deps - injected seams; `sendRequest` routes to the daemon
 * @param io   - optional stream override for tests (defaults to process.stdin/stdout)
 * @throws     when MARS_MCP_TASK_ID is missing
 */
export async function startWorkerMcpServer(
  env: Record<string, string | undefined>,
  deps: WorkerServerDeps,
  io: WorkerServerIO = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const taskId = env['MARS_MCP_TASK_ID']
  if (!taskId || taskId.trim().length === 0) {
    throw new Error('MARS_MCP_TASK_ID is required but not set in the environment')
  }

  const { input, output } = io

  const send = (msg: unknown): void => {
    output.write(JSON.stringify(msg) + '\n')
  }

  const respond = (id: unknown, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result })
  }

  const rl = createInterface({ input, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }

    if (typeof msg !== 'object' || msg === null) continue

    const { method, id, params } = msg as Record<string, unknown>

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mars-worker', version: '1.0.0' },
        })
        break

      case 'notifications/initialized':
        // No response for notifications.
        break

      case 'tools/list':
        respond(id, {
          tools: [
            {
              name: 'mars_task_note',
              description: 'Append a progress note to the current task',
              inputSchema: {
                type: 'object',
                properties: {
                  body: {
                    type: 'string',
                    minLength: 1,
                    description: 'Note body text',
                  },
                },
                required: ['body'],
                additionalProperties: false,
              },
            },
          ],
        })
        break

      case 'tools/call': {
        const p = params as Record<string, unknown> | undefined

        if (p?.name !== 'mars_task_note') {
          respond(id, {
            content: [{ type: 'text', text: `Unknown tool: ${String(p?.name)}` }],
            isError: true,
          })
          break
        }

        const parsed = TaskNoteArgsSchema.safeParse(p?.arguments)
        if (!parsed.success) {
          respond(id, {
            content: [
              {
                type: 'text',
                text: `Invalid arguments: ${parsed.error.message}`,
              },
            ],
            isError: true,
          })
          break
        }

        try {
          await deps.sendRequest({
            op: 'task.note',
            id: taskId,
            body: parsed.data.body,
            author: 'mcp-worker',
          })
          respond(id, { content: [{ type: 'text', text: 'Note appended' }] })
        } catch (err) {
          respond(id, {
            content: [
              {
                type: 'text',
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          })
        }
        break
      }

      default:
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${String(method)}` },
        })
    }
  }
}
