/**
 * MCP bridge for the chat agent.
 *
 * The chat agent runs on the Codex Responses API directly, so MCP servers
 * can't be attached the way Claude Code attaches them — the daemon has to be
 * the MCP client itself. This module reads the repo's `.mcp.json`
 * (`mcpServers`, stdio entries only), spawns each server lazily on first use,
 * lists its tools, and exposes them so chat-runner can advertise them as
 * function tools and proxy calls.
 *
 * The protocol layer is a deliberately minimal stdio MCP client — one JSON-RPC
 * 2.0 message per LF-terminated line, `initialize` → `notifications/initialized`
 * → `tools/list` / `tools/call` — small enough that pulling in the full SDK is
 * not worth a dependency.
 *
 * Servers stay alive for the daemon's lifetime (codegraph, for example, holds
 * an index and a file watcher — respawning per turn would be wasteful). A
 * crashed server is respawned on the next call. `killAll()` is invoked from
 * the chat runner's shutdown path.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Handshake + list must complete within this budget or the server is skipped. */
const CONNECT_TIMEOUT_MS = 15_000
/** Per tools/call budget. */
const CALL_TIMEOUT_MS = 60_000

/**
 * Parse `<repoRoot>/.mcp.json` into stdio server configs. Non-stdio entries
 * (`type` present and ≠ 'stdio') and malformed entries are skipped. Returns []
 * when the file is missing or unparseable.
 */
export const readMcpConfig = async (repoRoot: string): Promise<McpServerConfig[]> => {
  let raw: string
  try {
    raw = await readFile(join(repoRoot, '.mcp.json'), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers
  if (typeof servers !== 'object' || servers === null) return []
  const configs: McpServerConfig[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { type?: string; command?: string; args?: unknown; env?: unknown }
    if (e.type !== undefined && e.type !== 'stdio') continue
    if (typeof e.command !== 'string' || e.command.length === 0) continue
    configs.push({
      name,
      command: e.command,
      args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [],
      env: typeof e.env === 'object' && e.env !== null
        ? Object.fromEntries(Object.entries(e.env).filter(([, v]) => typeof v === 'string') as Array<[string, string]>)
        : {},
    })
  }
  return configs
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One live stdio MCP server connection. Created via `McpConnection.open`,
 * which resolves only after the initialize handshake and tools/list succeed.
 */
export class McpConnection {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  private constructor(
    readonly config: McpServerConfig,
    private readonly child: ChildProcess,
    readonly tools: McpToolInfo[],
  ) {}

  static async open(config: McpServerConfig, cwd: string): Promise<McpConnection> {
    const child = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const conn = new McpConnection(config, child, [])
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => conn.onLine(line))
    child.on('exit', () => conn.failAllPending(new Error(`MCP server "${config.name}" exited`)))
    child.on('error', (err) => conn.failAllPending(err))

    try {
      await conn.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mars-chat', version: '1.0.0' },
      }, CONNECT_TIMEOUT_MS)
      conn.notify('notifications/initialized', {})
      const listed = await conn.request('tools/list', {}, CONNECT_TIMEOUT_MS) as {
        tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>
      }
      for (const t of listed?.tools ?? []) {
        if (typeof t.name !== 'string') continue
        conn.tools.push({
          server: config.name,
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          inputSchema: typeof t.inputSchema === 'object' && t.inputSchema !== null
            ? t.inputSchema as Record<string, unknown>
            : { type: 'object', properties: {} },
        })
      }
      return conn
    } catch (err) {
      conn.kill()
      throw err
    }
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed
  }

  /**
   * Invoke one MCP tool. Returns the concatenated text content (non-text
   * content items are JSON-stringified) and the server's isError flag.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS) as {
      content?: Array<{ type?: unknown; text?: unknown }>
      isError?: unknown
    }
    const text = (result?.content ?? [])
      .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n')
    return { text, isError: result?.isError === true }
  }

  kill(): void {
    this.failAllPending(new Error(`MCP server "${this.config.name}" shut down`))
    this.child.kill('SIGTERM')
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" to "${this.config.name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(`${payload}\n`, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private onLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return // Not JSON-RPC — some servers log to stdout; ignore.
    }
    const m = msg as { id?: unknown; result?: unknown; error?: { message?: unknown } }
    if (typeof m.id !== 'number') return // Notification or request from the server — none handled.
    const req = this.pending.get(m.id)
    if (!req) return
    this.pending.delete(m.id)
    clearTimeout(req.timer)
    if (m.error !== undefined && m.error !== null) {
      req.reject(new Error(typeof m.error.message === 'string' ? m.error.message : 'MCP error'))
    } else {
      req.resolve(m.result)
    }
  }

  private failAllPending(err: Error): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer)
      req.reject(err)
    }
    this.pending.clear()
  }
}

/**
 * Lazy per-repo MCP connection pool for the chat runner.
 *
 * `getTools` connects every configured server on first call and caches the
 * connections for the daemon's lifetime; a server that fails to connect is
 * skipped (chat degrades to the built-in tools). `call` routes a tool name to
 * its owning server, respawning it first if it crashed.
 */
export class ChatMcpManager {
  /** Keyed by repoRoot; the promise is shared so concurrent runs never double-spawn. */
  private readonly connections = new Map<string, Promise<Map<string, McpConnection>>>()

  /** Names of every tool currently reachable for `repoRoot`. */
  async getTools(repoRoot: string): Promise<McpToolInfo[]> {
    const conns = await this.ensureConnections(repoRoot)
    return Array.from(conns.values()).flatMap((c) => c.tools)
  }

  /** Invoke `tool`; never throws — failures come back as isError text. */
  async call(repoRoot: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const conns = await this.ensureConnections(repoRoot)
    for (const [name, conn] of conns) {
      if (!conn.tools.some((t) => t.name === tool)) continue
      let live = conn
      if (!live.alive) {
        // Crashed since connect — one respawn attempt.
        try {
          live = await McpConnection.open(conn.config, repoRoot)
          conns.set(name, live)
        } catch (err) {
          return { text: `MCP server "${name}" is down and failed to restart: ${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
      }
      try {
        return await live.callTool(tool, args)
      } catch (err) {
        return { text: `MCP tool "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    return { text: `unknown MCP tool "${tool}"`, isError: true }
  }

  /** Kill every server process. Called from the daemon shutdown path. */
  killAll(): void {
    for (const pending of this.connections.values()) {
      pending.then((conns) => {
        for (const conn of conns.values()) conn.kill()
      }).catch(() => {})
    }
    this.connections.clear()
  }

  private ensureConnections(repoRoot: string): Promise<Map<string, McpConnection>> {
    let pending = this.connections.get(repoRoot)
    if (!pending) {
      pending = this.connectAll(repoRoot)
      this.connections.set(repoRoot, pending)
    }
    return pending
  }

  private async connectAll(repoRoot: string): Promise<Map<string, McpConnection>> {
    const conns = new Map<string, McpConnection>()
    const configs = await readMcpConfig(repoRoot)
    await Promise.all(configs.map(async (config) => {
      try {
        conns.set(config.name, await McpConnection.open(config, repoRoot))
      } catch {
        // Server failed to start or handshake — chat runs without it.
      }
    }))
    return conns
  }
}
