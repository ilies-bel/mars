import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { startWorkerMcpServer } from '../worker-server.js'
import type { DaemonRequest } from '../../daemon/protocol.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a JSON-RPC message to the server's input stream. */
function sendMsg(input: PassThrough, msg: unknown): void {
  input.write(JSON.stringify(msg) + '\n')
}

/**
 * Collect one complete JSON line from the server's output stream.
 * Resolves when the first newline-terminated line arrives.
 */
function nextLine(output: PassThrough): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        const line = buf.slice(0, idx)
        output.off('data', onData)
        output.off('error', onErr)
        try {
          resolve(JSON.parse(line))
        } catch (e) {
          reject(e)
        }
      }
    }
    const onErr = (err: Error): void => reject(err)
    output.on('data', onData)
    output.on('error', onErr)
  })
}

/**
 * Create a pair of PassThrough streams and start the server.
 * Returns the streams and a server promise; the server runs until
 * `serverInput` is closed (end-of-stream).
 */
function startServer(
  env: Record<string, string | undefined>,
  sendRequest: (req: DaemonRequest) => Promise<unknown>,
): {
  serverInput: PassThrough
  serverOutput: PassThrough
  serverDone: Promise<void>
} {
  const serverInput = new PassThrough()
  const serverOutput = new PassThrough()
  const serverDone = startWorkerMcpServer(env, { sendRequest }, {
    input: serverInput,
    output: serverOutput,
  })
  return { serverInput, serverOutput, serverDone }
}

/** Perform the MCP handshake (initialize + initialized notification). */
async function handshake(
  serverInput: PassThrough,
  serverOutput: PassThrough,
): Promise<void> {
  sendMsg(serverInput, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} },
  })
  const initResp = await nextLine(serverOutput)
  expect((initResp as Record<string, unknown>).result).toBeTruthy()

  // Send the initialized notification — no response expected.
  sendMsg(serverInput, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startWorkerMcpServer', () => {
  let capturedRequests: DaemonRequest[]
  let sendRequest: (req: DaemonRequest) => Promise<unknown>

  beforeEach(() => {
    capturedRequests = []
    sendRequest = vi.fn(async (req: DaemonRequest) => {
      capturedRequests.push(req)
      return { ok: true, data: { id: 'note-123' } }
    })
  })

  it('throws when MARS_MCP_TASK_ID is missing', async () => {
    await expect(
      startWorkerMcpServer({}, { sendRequest }),
    ).rejects.toThrow('MARS_MCP_TASK_ID')
  })

  it('throws when MARS_MCP_TASK_ID is empty', async () => {
    await expect(
      startWorkerMcpServer({ MARS_MCP_TASK_ID: '' }, { sendRequest }),
    ).rejects.toThrow('MARS_MCP_TASK_ID')
  })

  it('responds to initialize with server capabilities', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    })

    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(1)
    const result = resp.result as Record<string, unknown>
    expect(result.protocolVersion).toBe('2024-11-05')
    expect(result.serverInfo).toMatchObject({ name: 'mars-worker' })
    expect(result.capabilities).toMatchObject({ tools: {} })

    serverInput.end()
    await serverDone
  })

  it('lists exactly one tool: mars_task_note', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(2)
    const tools = (resp.result as Record<string, unknown>).tools as unknown[]
    expect(tools).toHaveLength(1)
    expect((tools[0] as Record<string, unknown>).name).toBe('mars_task_note')

    serverInput.end()
    await serverDone
  })

  it('mars_task_note forwards op:task.note with env-bound id and verbatim body to daemon', async () => {
    const TASK_ID = 'mars-cfa883a0'
    const BODY = 'working on the MCP wire-up'

    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: TASK_ID },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'mars_task_note', arguments: { body: BODY } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    // Tool call should succeed
    expect(resp.id).toBe(3)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBeFalsy()

    // The daemon received exactly one request with the right fields
    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]
    expect(req.op).toBe('task.note')
    expect((req as { op: 'task.note'; id: string; body: string; author?: string }).id).toBe(TASK_ID)
    expect((req as { op: 'task.note'; id: string; body: string; author?: string }).body).toBe(BODY)

    serverInput.end()
    await serverDone
  })

  it('rejects an empty body as an MCP tool error, not a crash', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'mars_task_note', arguments: { body: '' } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(4)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(true)
    // No daemon request should have been made
    expect(capturedRequests).toHaveLength(0)

    serverInput.end()
    await serverDone
  })

  it('rejects a non-string body as an MCP tool error', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'mars_task_note', arguments: { body: 42 } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(5)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(true)
    expect(capturedRequests).toHaveLength(0)

    serverInput.end()
    await serverDone
  })

  it('surfaces daemon errors as MCP tool errors, not process crashes', async () => {
    const failingSendRequest = vi.fn(async (_req: DaemonRequest) => {
      throw new Error('daemon unavailable')
    })
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      failingSendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'mars_task_note', arguments: { body: 'hello' } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(6)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain('daemon unavailable')

    serverInput.end()
    await serverDone
  })
})
