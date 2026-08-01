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

  it('lists mars_task_note, mars_task_check, and mars_task_context in tools/list', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(2)
    const tools = (resp.result as Record<string, unknown>).tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(3)
    expect(tools.map(t => t.name)).toEqual(['mars_task_note', 'mars_task_check', 'mars_task_context'])

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

    // The mutation is followed by one durable audit append request.
    expect(capturedRequests).toHaveLength(2)
    const req = capturedRequests[0]
    expect(req.op).toBe('task.note')
    expect((req as { op: 'task.note'; id: string; body: string; author?: string }).id).toBe(TASK_ID)
    expect((req as { op: 'task.note'; id: string; body: string; author?: string }).body).toBe(BODY)

    expect(capturedRequests[1]).toMatchObject({
      op: 'mcp.audit.append',
      toolName: 'mars_task_note',
      taskId: TASK_ID,
      argsJson: { body: '[redacted]' },
      ok: true,
      errorMessage: null,
    })

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

  it('mars_task_check forwards op:task.check with criterionIndex and uncheck:false', async () => {
    const TASK_ID = 'mars-abc123'
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: TASK_ID },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'mars_task_check', arguments: { index: 2 } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(10)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBeFalsy()

    expect(capturedRequests).toHaveLength(2)
    const req = capturedRequests[0] as { op: string; id: string; criterionIndex: number; uncheck: boolean; author: string }
    expect(req.op).toBe('task.check')
    expect(req.id).toBe(TASK_ID)
    expect(req.criterionIndex).toBe(2)
    expect(req.uncheck).toBe(false)
    expect(req.author).toBe('mcp-worker')
    expect(capturedRequests[1]).toMatchObject({
      op: 'mcp.audit.append',
      toolName: 'mars_task_check',
      taskId: TASK_ID,
      argsJson: { index: 2 },
      ok: true,
    })

    serverInput.end()
    await serverDone
  })

  it('mars_task_check with uncheck:true forwards uncheck:true', async () => {
    const TASK_ID = 'mars-abc123'
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: TASK_ID },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'mars_task_check', arguments: { index: 3, uncheck: true } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(11)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBeFalsy()

    expect(capturedRequests).toHaveLength(2)
    const req = capturedRequests[0] as { op: string; id: string; criterionIndex: number; uncheck: boolean }
    expect(req.op).toBe('task.check')
    expect(req.criterionIndex).toBe(3)
    expect(req.uncheck).toBe(true)

    serverInput.end()
    await serverDone
  })

  it('mars_task_check rejects index=0 at schema level', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'mars_task_check', arguments: { index: 0 } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(12)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(true)
    expect(capturedRequests).toHaveLength(0)

    serverInput.end()
    await serverDone
  })

  it('mars_task_check rejects non-integer index at schema level', async () => {
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      sendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'mars_task_check', arguments: { index: 1.5 } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(13)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(true)
    expect(capturedRequests).toHaveLength(0)

    serverInput.end()
    await serverDone
  })

  it('audits a failed mutation before surfacing its daemon error', async () => {
    const captured: DaemonRequest[] = []
    const failingSendRequest = vi.fn(async (req: DaemonRequest) => {
      captured.push(req)
      if (req.op === 'task.note') {
        throw new Error('daemon unavailable')
      }
      return { ok: true }
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
    expect(captured).toHaveLength(2)
    expect(captured[1]).toMatchObject({
      op: 'mcp.audit.append',
      toolName: 'mars_task_note',
      taskId: 'task-abc',
      argsJson: { body: '[redacted]' },
      ok: false,
      errorMessage: 'daemon unavailable',
    })

    serverInput.end()
    await serverDone
  })

  it('audits a failed criterion change before returning its daemon error', async () => {
    const captured: DaemonRequest[] = []
    const failingSendRequest = vi.fn(async (req: DaemonRequest) => {
      captured.push(req)
      if (req.op === 'task.check') {
        throw new Error('criterion no longer exists')
      }
      return { ok: true }
    })
    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: 'task-abc' },
      failingSendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'mars_task_check', arguments: { index: 3, uncheck: true } },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect((resp.result as Record<string, unknown>).isError).toBe(true)
    expect(captured).toHaveLength(2)
    expect(captured[1]).toMatchObject({
      op: 'mcp.audit.append',
      toolName: 'mars_task_check',
      taskId: 'task-abc',
      argsJson: { index: 3, uncheck: true },
      ok: false,
      errorMessage: 'criterion no longer exists',
    })

    serverInput.end()
    await serverDone
  })

  it('mars_task_context returns all worker-safe fields from the daemon response', async () => {
    const TASK_ID = 'mars-context-test'
    const seededContext = {
      id: TASK_ID,
      title: 'Implement the feature',
      prompt: 'Add the MCP context tool to the worker server',
      files: ['src/core/mcp/worker-server.ts', 'src/core/daemon/protocol.ts'],
      verify: 'cd orchestrator && npx vitest run src/core/mcp',
      done: [
        { text: 'mars_task_context is registered', checked: true },
        { text: 'handler returns worker-safe fields', checked: false },
      ],
      mergeMode: 'auto',
      status: 'running',
      blockers: ['mars-blocker-1'],
    }

    const contextSendRequest = vi.fn(async (req: DaemonRequest) => {
      if (req.op === 'task.contextForWorker') {
        return seededContext
      }
      return { ok: true }
    })

    const { serverInput, serverOutput, serverDone } = startServer(
      { MARS_MCP_TASK_ID: TASK_ID },
      contextSendRequest,
    )
    await handshake(serverInput, serverOutput)

    sendMsg(serverInput, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'mars_task_context', arguments: {} },
    })
    const resp = await nextLine(serverOutput) as Record<string, unknown>

    expect(resp.id).toBe(20)
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBeFalsy()

    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0].text) as typeof seededContext

    expect(parsed.id).toBe(seededContext.id)
    expect(parsed.title).toBe(seededContext.title)
    expect(parsed.prompt).toBe(seededContext.prompt)
    expect(parsed.files).toEqual(seededContext.files)
    expect(parsed.verify).toBe(seededContext.verify)
    expect(parsed.done).toEqual(seededContext.done)
    expect(parsed.mergeMode).toBe(seededContext.mergeMode)
    expect(parsed.status).toBe(seededContext.status)
    expect(parsed.blockers).toEqual(seededContext.blockers)

    // Confirm the daemon received exactly one task.contextForWorker request with the env-bound id
    const contextReq = contextSendRequest.mock.calls.find(
      ([r]) => (r as DaemonRequest).op === 'task.contextForWorker',
    )
    expect(contextReq).toBeDefined()
    expect((contextReq![0] as { op: string; id: string }).id).toBe(TASK_ID)
    expect(contextSendRequest).toHaveBeenCalledOnce()

    serverInput.end()
    await serverDone
  })
})
