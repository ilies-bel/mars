/**
 * `mars mcp worker` — start a stdio MCP server for a dispatched worker session.
 *
 * The server reads MARS_MCP_TASK_ID from the environment (injected by the
 * dispatch path) and exposes a single tool `mars_task_note` that routes
 * progress notes to the daemon via the `task.note` op.
 */

import type { Command, CommandDeps, CommandResult } from '../command.js'
import { startWorkerMcpServer } from '../../core/mcp/worker-server.js'
import { fail, ok } from '../command.js'

const mcpWorker: Command = {
  path: 'mcp worker',
  summary: 'Start a stdio MCP server for a dispatched worker session',
  usage: 'usage: mars mcp worker',
  async run(_args: unknown, deps: CommandDeps): Promise<CommandResult> {
    try {
      await startWorkerMcpServer(
        process.env as Record<string, string | undefined>,
        { sendRequest: (req) => deps.daemon.sendRequest(req) },
        { input: process.stdin, output: process.stdout },
      )
      return ok()
    } catch (err) {
      deps.err(err instanceof Error ? err.message : String(err))
      return fail()
    }
  },
}

export const mcpWorkerCommands: readonly Command[] = [mcpWorker]
