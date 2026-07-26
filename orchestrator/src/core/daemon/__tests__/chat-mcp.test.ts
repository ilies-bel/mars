/**
 * Tests for chat-mcp.ts — .mcp.json parsing and the stdio MCP client, driven
 * against a real fake MCP server (a small node script speaking newline JSON-RPC)
 * spawned from a per-test temp repo.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChatMcpManager, readMcpConfig } from '../chat-mcp'

let repoRoot: string
let manager: ChatMcpManager | null = null

const FAKE_SERVER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notification
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  if (msg.method === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } })
  } else if (msg.method === 'tools/list') {
    reply({ tools: [
      { name: 'echo_tool', description: 'Echo the message back.', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } },
    ] })
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo_tool') {
      reply({ content: [{ type: 'text', text: 'echo:' + msg.params.arguments.msg }], isError: false })
    } else {
      reply({ content: [{ type: 'text', text: 'no such tool' }], isError: true })
    }
  }
})
`

const writeRepo = async (mcpJson: unknown): Promise<void> => {
  await writeFile(join(repoRoot, 'fake-server.cjs'), FAKE_SERVER, 'utf8')
  await writeFile(join(repoRoot, '.mcp.json'), JSON.stringify(mcpJson), 'utf8')
}

const fakeConfig = {
  mcpServers: {
    fake: { type: 'stdio', command: 'node', args: ['fake-server.cjs'] },
  },
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'chat-mcp-'))
})

afterEach(async () => {
  manager?.killAll()
  manager = null
  await rm(repoRoot, { recursive: true, force: true })
})

describe('readMcpConfig', () => {
  it('returns [] when .mcp.json is missing', async () => {
    expect(await readMcpConfig(repoRoot)).toEqual([])
  })

  it('parses stdio servers and skips non-stdio or malformed entries', async () => {
    await writeFile(join(repoRoot, '.mcp.json'), JSON.stringify({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
        remote: { type: 'http', url: 'https://example.com' },
        broken: { args: ['x'] },
        untyped: { command: 'foo' },
      },
    }), 'utf8')
    const configs = await readMcpConfig(repoRoot)
    expect(configs.map((c) => c.name).sort()).toEqual(['codegraph', 'untyped'])
    expect(configs.find((c) => c.name === 'codegraph')).toEqual(
      { name: 'codegraph', command: 'codegraph', args: ['serve', '--mcp'], env: {} },
    )
  })

  it('returns [] for unparseable JSON', async () => {
    await writeFile(join(repoRoot, '.mcp.json'), 'not json', 'utf8')
    expect(await readMcpConfig(repoRoot)).toEqual([])
  })
})

describe('ChatMcpManager', () => {
  it('connects to a configured server and lists its tools', async () => {
    await writeRepo(fakeConfig)
    manager = new ChatMcpManager()
    const tools = await manager.getTools(repoRoot)
    expect(tools).toEqual([
      {
        server: 'fake',
        name: 'echo_tool',
        description: 'Echo the message back.',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      },
    ])
  })

  it('routes a tool call to the owning server and returns its text', async () => {
    await writeRepo(fakeConfig)
    manager = new ChatMcpManager()
    await manager.getTools(repoRoot)
    const result = await manager.call(repoRoot, 'echo_tool', { msg: 'hi' })
    expect(result).toEqual({ text: 'echo:hi', isError: false })
  })

  it('returns isError for an unknown tool name', async () => {
    await writeRepo(fakeConfig)
    manager = new ChatMcpManager()
    const result = await manager.call(repoRoot, 'teleport', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unknown MCP tool')
  })

  it('yields no tools when the repo has no .mcp.json', async () => {
    manager = new ChatMcpManager()
    expect(await manager.getTools(repoRoot)).toEqual([])
  })

  it('skips a server whose command cannot be spawned', async () => {
    await writeFile(join(repoRoot, '.mcp.json'), JSON.stringify({
      mcpServers: { ghost: { type: 'stdio', command: '/nonexistent/binary-xyz' } },
    }), 'utf8')
    manager = new ChatMcpManager()
    expect(await manager.getTools(repoRoot)).toEqual([])
  })

  it('describe reports connected servers with tools and failed ones without', async () => {
    await writeRepo({
      mcpServers: {
        fake: { type: 'stdio', command: 'node', args: ['fake-server.cjs'] },
        ghost: { type: 'stdio', command: '/nonexistent/binary-xyz' },
      },
    })
    manager = new ChatMcpManager()
    const described = await manager.describe(repoRoot)
    expect(described).toEqual([
      {
        name: 'fake',
        command: 'node fake-server.cjs',
        status: 'connected',
        tools: [{ name: 'echo_tool', description: 'Echo the message back.' }],
      },
      { name: 'ghost', command: '/nonexistent/binary-xyz', status: 'failed', tools: [] },
    ])
  })
})
