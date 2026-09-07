/**
 * Chat runner — drives a chat turn against the Codex Responses API directly
 * (see codex-api.ts), streams typed segments over the `chat` SSE channel, and
 * persists the assistant reply to `chat_messages` when the run finishes.
 *
 * The daemon owns the whole agent loop: it replays the thread transcript as
 * Responses input items on every turn (`store: false` — no server-side session,
 * nothing in the context window the daemon didn't put there), exposes the
 * function tools in `CHAT_TOOLS` (`shell`, `read_file`, `write_file`, `skill`)
 * plus every tool of the repo's `.mcp.json` servers (bridged via chat-mcp.ts),
 * executes tool calls itself, and feeds the outputs back until the model
 * produces a final message. The repo's `.claude/skills` index is appended to
 * the instructions so the agent can load any skill runbook on demand.
 *
 * One run per thread at a time (in-memory guard); concurrent POST requests
 * get a 409 response from the HTTP route. A 10-minute wall-clock timeout
 * finalises the run with an `error` segment. `killAll()` is called by the
 * daemon shutdown path to abort all live runs.
 *
 * Error-kind handling (inlined in _run to avoid single-caller helpers):
 *   auth       → one silent token refresh, then global flag + throttle with
 *                backoff; clears on re-auth
 *   rate-limit → throttle with backoff; auto-retries up to 3 times
 *   http/network → terminal error (user-safe message, no provider details)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { integrationBranchName } from '../lib/blocker-resolution-primitives'
import { createProposal } from '../proposals'
import { enqueueTask, getTask, updateTask } from '../queue'
import { ChatMcpManager, type McpToolInfo } from './chat-mcp'
import { linkTaskToThread, listTasksForThread } from './chat-thread-tasks'
import { runShellCommand } from './chat-shell'
import { buildSkillsSection, discoverSkills, loadSkill } from './chat-skills'
import { corePurgeTask } from './purge-task'
import {
  appendMessage,
  getThread,
  listMainSessionMessages,
  setThreadModel,
  setThreadPosture,
  setThreadStatus,
  updateThreadTitle,
  type AlertSegment,
  type ChatPosture,
  type ChatMessage,
  type CompactionSegment,
} from '../lib/chat-store'
import type { ViewInvalidationBus } from '../../bus/view-invalidation.js'
import type { ChatSegment, ChatStreamHub, ChatStopReason } from './chat-contracts'
import { resolveChatSystemPrompt } from './chat-system-prompt'
import { buildMainThreadPrefix, MAIN_THREAD_PROVIDER_REQUEST_IDENTITY } from './chat-context'
import {
  advanceMainMemoryWindow,
  markMainMemoryWindowUsed,
  readMainMemoryWindow,
  selectMemoryCut,
} from './chat-memory-window'
import { resolveProviderName } from '../workers/providers'
import { PROVIDER_MODELS, type ConversationMemoryFacts } from '../workers/provider-types'
import {
  defaultModelIdFor,
  resolveCatalogFacts,
  resolveDefaultThinkingEffort,
} from '../workers/model-catalog'
import { loadDaemonConfig } from './config'
import {
  CodexApiError,
  loadCodexAuth,
  refreshCodexAuth,
  resolveCodexOAuthConfig,
  streamCodexResponse,
  type CodexAuth,
  type FunctionToolDef,
  type ResponseInputItem,
} from './codex-api'

// ── Attachment info ───────────────────────────────────────────────────────────

/**
 * Metadata for a file uploaded via `POST /chat/threads/:id/attachments`.
 * Passed to `sendMessage` so the runner can embed attachment instructions
 * in the prompt and persist attachment segments on the user message.
 */
export interface AttachmentInfo {
  id: string
  path: string
  mimeType: string
  name: string
  size: number
}

// MIME type classification used when building attachment segments and prompt text.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'])

// ── Domain flow context ───────────────────────────────────────────────────────

/**
 * Look up the rendered Domain Flow for an Arc (task) id.
 *
 * Stub: returns null until the domain flow store lands from its own slice.
 * When the store is available, replace this with the real `getFlowByArcId`
 * import from the flow store module.
 */
const getFlowByArcId = async (_arcId: string): Promise<{ rendered: string } | null> => null

// ── Parser ────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const CHAT_TASK_ID_RE = /\bmars-[a-f0-9]{8,}\b/g

/**
 * Legacy transcript inference is deliberately diagnostic-only. The durable
 * `chat_thread_tasks` relation is authoritative for task links.
 */
const parseCreatedTaskIds = (messages: Pick<ChatMessage, 'segments'>[]): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.segments)) continue
    for (const segment of message.segments) {
      if (!isObject(segment) || segment.type !== 'tool_use') continue
      const input = JSON.stringify(segment.input ?? '')
      if (!input.includes('mars task add')) continue
      const result = JSON.stringify(segment.result ?? '')
      for (const match of result.matchAll(CHAT_TASK_ID_RE)) {
        if (!seen.has(match[0])) {
          seen.add(match[0])
          ids.push(match[0])
        }
      }
    }
  }
  return ids
}

/**
 * Derive a short display name for a shell command.
 * - `mars <verb> ...` → `mars <verb>` (e.g. `mars task add "..."` → `mars task`)
 * - anything else     → first token   (e.g. `ls -la` → `ls`)
 */
const deriveCommandName = (command: string): string => {
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] === 'mars' && tokens[1]) return `mars ${tokens[1]}`
  return tokens[0] ?? 'shell'
}

/**
 * Convert a single Codex Responses SSE event into zero or more `ChatSegment`
 * values. The function is pure (no I/O) and exported for unit testing.
 *
 * Recognised event → segment mappings:
 * - `response.output_item.done(message)`       → `text`
 * - `response.output_item.done(function_call)` → `tool_use` (`tool` carries the
 *   real function name for dispatch/replay; `name` is the display label)
 * - `response.output_item.done(reasoning)`     → `thinking` (summary text)
 * - `response.completed`                       → `result` (usage)
 * All other event types produce no segments.
 */
export const parseEventToSegments = (event: unknown): ChatSegment[] => {
  const segs: ChatSegment[] = []
  if (!isObject(event)) return segs

  if (event.type === 'response.output_item.done' && isObject(event.item)) {
    const item = event.item
    if (item.type === 'message' && Array.isArray(item.content)) {
      const text = item.content
        .filter((p): p is { type: string; text: string } =>
          isObject(p) && p.type === 'output_text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
      if (text.length > 0) segs.push({ type: 'text', text })
    } else if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.arguments === 'string') {
      let args: unknown
      try { args = JSON.parse(item.arguments) } catch { args = { raw: item.arguments } }
      const tool = typeof item.name === 'string' ? item.name : 'tool'
      const command = tool === 'shell' && isObject(args) && typeof args.command === 'string' ? args.command : null
      const skillName = tool === 'skill' && isObject(args) && typeof args.name === 'string' ? args.name : null
      segs.push({
        type: 'tool_use',
        id: item.call_id,
        tool,
        name: command !== null ? deriveCommandName(command) : skillName !== null ? `skill ${skillName}` : tool,
        input: args,
        status: 'executed',
      })
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      const thinking = item.summary
        .filter((p): p is { type: string; text: string } =>
          isObject(p) && p.type === 'summary_text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n\n')
      if (thinking.length > 0) segs.push({ type: 'thinking', thinking })
    }
  } else if (event.type === 'response.completed') {
    const response = isObject(event.response) ? event.response : undefined
    const usage = response ? response.usage : undefined
    const details = isObject(usage) ? usage.input_tokens_details : undefined
    // Extract the stop reason from the Codex Responses API `response.status`
    // field. Declared here (on the parser, not in a switch(provider) elsewhere)
    // so the Codex Responses API mapping is co-located with the event handler.
    let stopReason: ChatStopReason = 'unknown'
    if (response) {
      const status = typeof response.status === 'string' ? response.status : null
      if (status === 'completed') {
        stopReason = 'complete'
      } else if (status === 'incomplete') {
        const incompleteDetails = isObject(response.incomplete_details) ? response.incomplete_details : null
        const reason = incompleteDetails && typeof incompleteDetails.reason === 'string' ? incompleteDetails.reason : null
        if (reason === 'max_output_tokens') stopReason = 'max_tokens'
        else if (reason === 'content_filter') stopReason = 'refusal'
        else stopReason = 'unknown'
      } else if (status !== null) {
        // 'failed', 'cancelled', unrecognised future status values
        stopReason = 'unknown'
      }
      // status === null (absent from event) → 'unknown' (pre-existing behaviour / test fixtures)
    }
    segs.push({
      type: 'result',
      durationMs: null,
      inputTokens: isObject(usage) && typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      outputTokens: isObject(usage) && typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadTokens: isObject(details) && typeof details.cached_tokens === 'number' ? details.cached_tokens : null,
      cost: null,
      stopReason,
    })
  } else if (event.type === 'item.completed' && isObject(event.item)) {
    // Codex CLI JSONL: agent_message items carry the assistant's reply as a plain text field.
    const item = event.item
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.length > 0) {
      segs.push({ type: 'text', text: item.text })
    }
  } else if (event.type === 'turn.completed') {
    // Codex CLI JSONL: usage is a top-level field on the event (not nested in response).
    // cached_input_tokens (not input_tokens_details.cached_tokens) is the cache field.
    const usage = isObject(event.usage) ? event.usage : undefined
    segs.push({
      type: 'result',
      durationMs: null,
      cost: null,
      inputTokens: usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      outputTokens: usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadTokens: usage && typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : null,
    })
  }

  return segs
}

// ── Transcript → Responses input ──────────────────────────────────────────────

// ── Tool surface ──────────────────────────────────────────────────────────────

const SHELL_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'shell',
  description:
    'Run a shell command from the repository root and return its stdout, stderr, and exit code. ' +
    'Use it for mars CLI commands, git, and daemon HTTP queries.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run (passed to zsh -lc).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
}

const READ_FILE_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'read_file',
  description:
    'Read a UTF-8 text file and return its content. Prefer this over shell cat/sed for file reads.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the repository root.' },
      offset: { type: 'number', description: '1-based line number to start reading from (default 1).' },
      limit: { type: 'number', description: 'Maximum number of lines to return (default: to end of file).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

const WRITE_FILE_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file (parent directories are created). ' +
    'Never use it to edit source files on main — code changes route through `mars task add`. ' +
    'Intended for `.mars/` state files (notes, chat-system-prompt.md) and scratch output.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the repository root.' },
      content: { type: 'string', description: 'The full file content to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
}

const SKILL_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'skill',
  description:
    'Load a skill — a reusable runbook from .claude/skills — and follow its instructions for the ' +
    'rest of the turn. Call it as soon as the user request matches a skill in the index.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name, exactly as listed in the skill index.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
}

/** Lets the agent turn a hard request into a persistent grill conversation. */
const SET_POSTURE_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'set_posture',
  description:
    'Switch this conversation to grill posture when the current request is hard. ' +
    'Only `grill` is valid. Use it before exploring a term-defining, cross-cutting, scope-ambiguous, or ADR-conflicting ask.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      posture: { type: 'string', enum: ['grill'], description: 'The posture to enter.' },
    },
    required: ['posture'],
    additionalProperties: false,
  },
}

/** Lets the agent turn a shaped grill draft into an ordinary queued task. */
const OVERRIDE_END_GRILL_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'override_end_grill',
  description:
    'End grill posture and enqueue the current, shaped task specification. ' +
    'Use this when the operator says “just do it”.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      taskSpec: { type: 'string', description: 'The complete task prompt shaped in this grill thread.' },
    },
    required: ['taskSpec'],
    additionalProperties: false,
  },
}

/** Lets the agent replace a prematurely-enqueued task with a fresh proposal. */
const OVERRIDE_RESHAPE_AS_PROPOSAL_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'override_reshape_as_proposal',
  description:
    'Purge an enqueued task that follow-up has revealed to be hard, then create a new proposal. ' +
    'Use this only when the original task is no longer the right unit of work.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      originalTaskId: { type: 'string', description: 'The id of the enqueued task to replace.' },
      proposalDraft: { type: 'string', description: 'The title for the fresh proposal.' },
    },
    required: ['originalTaskId', 'proposalDraft'],
    additionalProperties: false,
  },
}

/** The built-in function tools the chat agent gets, in the order sent to the API. */
const CHAT_TOOLS: FunctionToolDef[] = [SHELL_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, SKILL_TOOL]
const TRIAGE_TOOLS: FunctionToolDef[] = [...CHAT_TOOLS, SET_POSTURE_TOOL, OVERRIDE_RESHAPE_AS_PROPOSAL_TOOL]

/** Cap on MCP tool output fed back to the model (codegraph_explore returns verbatim source). */
const MCP_OUTPUT_CHAR_CAP = 20_000
/** Cap on an MCP tool description forwarded to the API. */
const MCP_DESCRIPTION_CHAR_CAP = 2_000

/**
 * Map the repo's MCP tools to Responses function tools. A tool whose name
 * collides with a built-in or an earlier server's tool is dropped — tool
 * names are the only dispatch key. Exported for unit testing.
 */
const buildMcpToolDefs = (mcpTools: readonly McpToolInfo[]): FunctionToolDef[] => {
  const taken = new Set([...TRIAGE_TOOLS, OVERRIDE_END_GRILL_TOOL].map((t) => t.name))
  const defs: FunctionToolDef[] = []
  for (const t of mcpTools) {
    if (taken.has(t.name)) continue
    taken.add(t.name)
    defs.push({
      type: 'function',
      name: t.name,
      description: truncate(t.description, MCP_DESCRIPTION_CHAR_CAP),
      strict: false,
      parameters: t.inputSchema,
    })
  }
  return defs
}

/** Per-call cap on stdout/stderr fed back to the model and persisted. */
const TOOL_OUTPUT_CHAR_CAP = 10_000
/** Rough cap on the serialized replayed transcript; oldest messages drop first. */
const MAX_TRANSCRIPT_CHARS = 120_000

/** Larger cap for `skill` output — a runbook must survive loading whole. */
const SKILL_OUTPUT_CHAR_CAP = 30_000

const truncate = (s: string, cap: number): string =>
  s.length > cap ? `${s.slice(0, cap)}…[truncated]` : s

/**
 * Execute one function-tool call and return the content fed back to the model
 * (also persisted as the `tool_result` segment). Exported for unit testing.
 * All failure modes return `isError: true` rather than throwing — a bad tool
 * call must never kill the run.
 */
export const executeToolCall = async (
  tool: string,
  args: Record<string, unknown>,
  repoRoot: string,
  signal: AbortSignal,
): Promise<{ content: unknown; isError: boolean }> => {
  switch (tool) {
    case 'shell': {
      const command = typeof args.command === 'string' ? args.command : null
      if (command === null) {
        return { content: { stdout: '', stderr: 'invalid shell arguments: missing "command"', exitCode: 1 }, isError: true }
      }
      const r = await runShellCommand(command, repoRoot, signal)
      return {
        content: {
          stdout: truncate(r.stdout, TOOL_OUTPUT_CHAR_CAP),
          stderr: truncate(r.stderr, TOOL_OUTPUT_CHAR_CAP),
          exitCode: r.exitCode,
        },
        isError: r.exitCode !== 0,
      }
    }
    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path : null
      if (path === null) return { content: 'invalid read_file arguments: missing "path"', isError: true }
      try {
        const lines = (await readFile(resolve(repoRoot, path), 'utf8')).split('\n')
        const offset = typeof args.offset === 'number' && args.offset > 1 ? Math.floor(args.offset) : 1
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : lines.length
        return { content: truncate(lines.slice(offset - 1, offset - 1 + limit).join('\n'), TOOL_OUTPUT_CHAR_CAP), isError: false }
      } catch (err) {
        return { content: `read failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    case 'write_file': {
      const path = typeof args.path === 'string' ? args.path : null
      const content = typeof args.content === 'string' ? args.content : null
      if (path === null || content === null) {
        return { content: 'invalid write_file arguments: "path" and "content" are required', isError: true }
      }
      try {
        const target = resolve(repoRoot, path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
        return { content: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${target}`, isError: false }
      } catch (err) {
        return { content: `write failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    }
    case 'skill': {
      const name = typeof args.name === 'string' ? args.name : null
      if (name === null) return { content: 'invalid skill arguments: missing "name"', isError: true }
      const skill = await loadSkill(repoRoot, name)
      if (!skill) {
        const available = (await discoverSkills(repoRoot)).map((s) => s.name).join(', ')
        return { content: `unknown skill "${name}". Available skills: ${available || '(none)'}`, isError: true }
      }
      const filesNote = skill.files.length > 0
        ? `\n\n[Bundled files under .claude/skills/${name}/: ${skill.files.join(', ')} — read them with read_file when the instructions reference them.]`
        : ''
      return { content: truncate(`${skill.content}${filesNote}`, SKILL_OUTPUT_CHAR_CAP), isError: false }
    }
    default:
      return { content: `unknown tool "${tool}"`, isError: true }
  }
}

const renderAlertText = (seg: AlertSegment): string => {
  const lines = [`[Alert: ${seg.kind}] ${seg.title}`, `Why now: ${seg.whyNow}`]
  const actionLabels = seg.actions.map((a) => a.label).join(', ')
  if (actionLabels) lines.push(`Available actions: ${actionLabels}`)
  return lines.join('\n')
}

const findCompactionSegment = (segments: readonly unknown[]): CompactionSegment | undefined =>
  segments.find((segment): segment is CompactionSegment => {
    if (!isObject(segment) || segment.type !== 'compaction') return false
    return typeof segment.summary === 'string'
      && Array.isArray(segment.taskIds) && segment.taskIds.every((value) => typeof value === 'string')
      && Array.isArray(segment.adrRefs) && segment.adrRefs.every((value) => typeof value === 'string')
      && Array.isArray(segment.glossaryRefs) && segment.glossaryRefs.every((value) => typeof value === 'string')
      && Array.isArray(segment.artifactRefs) && segment.artifactRefs.every((value) => typeof value === 'string')
  })

/** Convert one persisted chat message into its Responses input items. */
export const messageToApiInput = (msg: ChatMessage): ResponseInputItem[] => {
  const role: 'user' | 'assistant' = msg.role
  const segs = Array.isArray(msg.segments) ? (msg.segments as unknown[]) : []
  const checkpoint = findCompactionSegment(segs)
  if (checkpoint) {
    const refs = [
      ...checkpoint.taskIds.map((id) => `task: ${id}`),
      ...checkpoint.adrRefs.map((ref) => `ADR: ${ref}`),
      ...checkpoint.glossaryRefs.map((ref) => `glossary: ${ref}`),
      ...checkpoint.artifactRefs.map((ref) => `artifact: ${ref}`),
    ]
    const text = [
      '[Compaction checkpoint: earlier transcript]',
      checkpoint.summary,
      refs.length > 0 ? `Structured references:\n${refs.join('\n')}` : '',
    ].filter((part) => part.length > 0).join('\n\n')
    return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
  }
  if (segs.length === 0) {
    if (msg.content.trim().length === 0) return []
    return [{ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: msg.content }] }]
  }

  // Pair each tool_use with its tool_result so the API never sees a
  // function_call without a matching function_call_output.
  const resultsById = new Map<string, { content: unknown }>()
  for (const seg of segs) {
    if (isObject(seg) && seg.type === 'tool_result' && typeof seg.tool_use_id === 'string') {
      resultsById.set(seg.tool_use_id, { content: seg.content })
    }
  }

  const items: ResponseInputItem[] = []
  const textParts: string[] = []
  for (const seg of segs) {
    if (!isObject(seg)) continue
    if (seg.type === 'text' && typeof seg.text === 'string') {
      textParts.push(seg.text)
    } else if (seg.type === 'alert') {
      textParts.push(renderAlertText(seg as unknown as AlertSegment))
    } else if (seg.type === 'attachment' && typeof seg.path === 'string') {
      textParts.push(`[attachment: ${seg.path} (${String(seg.mimeType)})]`)
    } else if (seg.type === 'tool_use' && typeof seg.id === 'string') {
      const result = resultsById.get(seg.id)
      if (!result) continue
      const tool = typeof seg.tool === 'string' ? seg.tool : 'shell'
      items.push({ type: 'function_call', name: tool, arguments: JSON.stringify(seg.input ?? {}), call_id: seg.id })
      items.push({ type: 'function_call_output', call_id: seg.id, output: truncate(JSON.stringify(result.content ?? ''), TOOL_OUTPUT_CHAR_CAP) })
    }
    // thinking / result / error / tool_result → not replayed
  }
  const text = textParts.join('\n')
  if (text.trim().length > 0) {
    items.push({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
  }
  return items
}

/**
 * Build the replayed conversation input from the persisted transcript. The
 * newest messages always survive; older ones drop wholesale (never splitting
 * a message, so function_call/output pairs stay intact) once the serialized
 * transcript exceeds `MAX_TRANSCRIPT_CHARS`. Exported for unit testing.
 */
export const buildApiInput = (messages: readonly ChatMessage[]): ResponseInputItem[] => {
  let checkpointIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const segments = messages[i]?.segments
    if (Array.isArray(segments) && findCompactionSegment(segments)) {
      checkpointIndex = i
      break
    }
  }

  const checkpointItems = checkpointIndex >= 0 ? messageToApiInput(messages[checkpointIndex]!) : []
  const replayTail = checkpointIndex >= 0 ? messages.slice(checkpointIndex + 1) : messages
  const perMessage = replayTail.map(messageToApiInput)
  const kept: ResponseInputItem[][] = []
  let chars = 0
  for (let i = perMessage.length - 1; i >= 0; i--) {
    const items = perMessage[i]
    const size = JSON.stringify(items).length
    if (kept.length > 0 && chars + size > MAX_TRANSCRIPT_CHARS) break
    kept.unshift(items)
    chars += size
  }
  return [...checkpointItems, ...kept.flat()]
}

/** User-facing text for each non-complete stop reason. */
const STOP_REASON_NOTICES: Record<Exclude<ChatStopReason, 'complete'>, string> = {
  max_tokens: 'The response stopped early: the output-token limit was reached.',
  refusal: 'The response stopped early: the model declined to continue.',
  max_turns: 'The response stopped early: the tool-turn limit was reached.',
  unknown: 'The response stopped early.',
}

/** Exponential backoff delays for throttled retries (ms). */
const THROTTLE_BACKOFF_MS = [30_000, 60_000, 120_000]

// ── Runner ────────────────────────────────────────────────────────────────────

/** 10-minute wall-clock timeout per chat run. */
export const CHAT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Conversation-memory facts for the chat model of the *active* provider.
 *
 * Uses the model catalog for resolution (never throws on unknown model id).
 * The active model is:
 *   1. The thread-stored model_id when set (resolved at turn start by _run).
 *   2. The Codex OAuth-configured model for the codex provider.
 *   3. The catalog's default model for any other provider.
 *
 * This constructor-time resolver is the fallback used when no thread is
 * available (e.g. `new ChatRunner()` in tests or `describeConfig`). Per-turn
 * resolution with thread context lives in `_run`.
 */
const resolveChatConversationMemory = (): ConversationMemoryFacts => {
  const provider = resolveProviderName()
  const model =
    provider === 'codex'
      ? resolveCodexOAuthConfig().model
      : (defaultModelIdFor(provider) ?? PROVIDER_MODELS[provider]?.balanced ?? '')
  return resolveCatalogFacts(provider, model)
}

/**
 * Resolve the effective model id and thinking effort for a chat thread.
 *
 * Priority order:
 *   1. Thread-stored values (non-null model_id / thinking_effort).
 *   2. Operator defaults from daemon.json (`chat.defaultModelId` /
 *      `chat.defaultThinkingEffort` — set via `mars operator set chat-model`).
 *   3. MARS_CHAT_MODEL / MARS_CHAT_EFFORT env vars (from OAuth config).
 *   4. Catalog defaults for the active provider and resolved model.
 *
 * Returns `{ modelId, thinkingEffort, isNew }` where `isNew` is true when
 * no stored values existed so the caller can persist the resolved defaults.
 */
const resolveThreadModelAndEffort = (
  provider: string,
  storedModelId: string | null,
  storedEffort: string | null,
): { modelId: string; thinkingEffort: string | undefined; isNew: boolean } => {
  const cfg = resolveCodexOAuthConfig()

  // Operator defaults (best-effort: loadDaemonConfig never throws).
  let operatorModelId: string | undefined
  let operatorEffort: string | undefined
  try {
    const daemonCfg = loadDaemonConfig()
    const chatCfg = daemonCfg.chat
    if (chatCfg !== null && typeof chatCfg === 'object' && !Array.isArray(chatCfg)) {
      const rec = chatCfg as Record<string, unknown>
      if (typeof rec.defaultModelId === 'string' && rec.defaultModelId.length > 0) {
        operatorModelId = rec.defaultModelId
      }
      if (typeof rec.defaultThinkingEffort === 'string' && rec.defaultThinkingEffort.length > 0) {
        operatorEffort = rec.defaultThinkingEffort
      }
    }
  } catch {
    // loadDaemonConfig failed (no daemon.json yet) — fall through to env/catalog defaults.
  }

  // Step 1: model id
  const modelId: string =
    storedModelId ??
    operatorModelId ??
    (provider === 'codex' ? cfg.model : (defaultModelIdFor(provider) ?? cfg.model))

  // Step 2: thinking effort
  const thinkingEffort: string | undefined =
    storedEffort ??
    operatorEffort ??
    (provider === 'codex' ? cfg.effort : undefined) ??
    resolveDefaultThinkingEffort(provider, modelId)

  const isNew = storedModelId === null && storedEffort === null

  return { modelId, thinkingEffort, isNew }
}

/**
 * ChatRunner manages in-flight Codex API runs for chat threads.
 *
 * Call `sendMessage` to start a run. The run is fire-and-forget from the
 * HTTP handler's perspective: segments are pushed live over SSE and the
 * assistant message is persisted when the run completes. Call `stop` to
 * abort a run in progress. Call `killAll` from the daemon shutdown hook to
 * abort every active run.
 */
export class ChatRunner {
  /** Map from threadId to the AbortController that can kill the active run. */
  private activeRuns = new Map<string, AbortController>()

  /** Lazy per-repo MCP servers (`.mcp.json`) whose tools the agent gets. */
  private readonly mcp = new ChatMcpManager()

  /**
   * Per-thread retry state for throttled runs.
   * `retryCount` tracks how many backoff retries have fired so far;
   * `timer` is the pending timeout handle so `stop()` can cancel it.
   */
  private throttledRetries = new Map<string, { retryCount: number; timer: ReturnType<typeof setTimeout> }>()

  /**
   * True when the most recent auth failure was observed. A single global flag
   * because one OAuth token backs all threads.
   */
  private codexAuthFailed = false

  /** Listeners notified when the auth-failure state changes. */
  private authListeners: Array<(failed: boolean) => void> = []

  /**
   * Tracks the in-flight `_run` promise for each thread so `shutdownDrain`
   * can wait for them to finalise before the daemon exits.
   */
  private _activeRunPromises = new Map<string, Promise<void>>()

  /**
   * When set, an aborted run that has accumulated no text segments will use
   * this value as its assistant reply instead of the default `[no output]`.
   * Set by `shutdownDrain` before aborting runs.
   */
  private _shutdownMessage: string | null = null

  /**
   * @param chatStreamHub Optional per-thread `UIMessageChunk` source backing the
   *   `GET /chat/threads/:id/ui-stream` route. When present, the runner mirrors
   *   every streamed segment into it (mapped + buffered for resume); when absent
   *   (e.g. a bare `new ChatRunner()` in a unit test), streaming is a no-op.
   */
  constructor(
    private readonly chatStreamHub?: ChatStreamHub,
    private readonly conversationMemory: ConversationMemoryFacts =
      resolveChatConversationMemory(),
  ) {}

  /** Returns true when all threads are stalled due to a Codex auth failure. */
  isAuthFailed(): boolean {
    return this.codexAuthFailed
  }

  /** Whether any chat turn is actively generating or waiting to retry. */
  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0 || this.throttledRetries.size > 0
  }

  /**
   * Describe the agent's effective configuration for `GET /view/chat/config`:
   * the model, the resolved system prompt (and whether it is the built-in or
   * the `.mars/chat-system-prompt.md` override), the built-in tools, the skill
   * index, and each `.mcp.json` server with its status and tools. Connecting
   * to the MCP servers happens here too when chat has not run yet — the view
   * reports what a run would actually get.
   */
  async describeConfig(repoRoot: string): Promise<{
    model: string
    retentionMs: number
    minimumReusablePrefixTokens: number
    contextWindowTokens: number
    systemPrompt: string
    systemPromptSource: 'built-in' | 'override'
    builtinTools: Array<{ name: string; description: string }>
    skills: Array<{ name: string; description: string }>
    mcpServers: Array<{ name: string; command: string; status: 'connected' | 'failed'; tools: Array<{ name: string; description: string }> }>
  }> {
    const model = resolveCodexOAuthConfig().model
    const [resolved, skills, mcpServers] = await Promise.all([
      resolveChatSystemPrompt(repoRoot),
      discoverSkills(repoRoot),
      this.mcp.describe(repoRoot),
    ])
    return {
      model,
      ...this.conversationMemory,
      systemPrompt: resolved.prompt,
      systemPromptSource: resolved.source,
      builtinTools: TRIAGE_TOOLS.map((t) => ({ name: t.name, description: t.description })),
      skills,
      mcpServers,
    }
  }

  /**
   * Clear the global auth-failure flag and re-queue all throttled threads.
   * Call this after the user has re-authenticated so stalled threads resume.
   */
  clearAuthFailure(repoRoot: string, bus: ViewInvalidationBus | undefined): void {
    if (!this.codexAuthFailed) return
    this.codexAuthFailed = false
    for (const listener of this.authListeners) listener(false)

    // Re-queue every throttled thread immediately.
    for (const [threadId, retry] of this.throttledRetries) {
      clearTimeout(retry.timer)
      this.throttledRetries.delete(threadId)
      const abort = new AbortController()
      this.activeRuns.set(threadId, abort)
      const runPromise = this._run(threadId, '', repoRoot, bus, abort, undefined, 0)
        .catch(() => { this.activeRuns.delete(threadId) })
        .finally(() => { this._activeRunPromises.delete(threadId) })
      this._activeRunPromises.set(threadId, runPromise)
    }
  }

  /** Subscribe to auth-failure state changes. */
  onAuthStateChange(listener: (failed: boolean) => void): () => void {
    this.authListeners.push(listener)
    return () => {
      this.authListeners = this.authListeners.filter((l) => l !== listener)
    }
  }

  /**
   * Start a Codex run for `threadId`. Returns `{ alreadyRunning: true }`
   * without starting if there is already an active run for that thread
   * (the HTTP layer should respond 409). Otherwise starts the run
   * asynchronously and returns `{ alreadyRunning: false }`.
   *
   * When `attachments` are provided, they are persisted as `attachment`
   * segments on the user message and their paths/types are appended to the
   * prompt so the agent can read or process them.
   */
  async sendMessage(
    threadId: string,
    content: string,
    repoRoot: string,
    bus: ViewInvalidationBus | undefined,
    attachments?: AttachmentInfo[],
    opts?: { userMessagePersisted?: boolean },
  ): Promise<{ alreadyRunning: boolean }> {
    if (this.activeRuns.has(threadId)) return { alreadyRunning: true }
    // If there's a pending throttle timer for this thread, cancel it and
    // treat the new sendMessage as an immediate re-run instead.
    const pending = this.throttledRetries.get(threadId)
    if (pending) {
      clearTimeout(pending.timer)
      this.throttledRetries.delete(threadId)
    }

    const abort = new AbortController()
    this.activeRuns.set(threadId, abort)

    // Fire-and-forget: HTTP responds immediately; segments arrive via SSE.
    // Track the promise so shutdownDrain() can await completion before exit.
    const runPromise = this._run(
      threadId,
      content,
      repoRoot,
      bus,
      abort,
      attachments,
      0,
      opts?.userMessagePersisted ?? false,
    )
      .catch(() => {
        // Ensure the map entry is removed even if _run throws unexpectedly.
        this.activeRuns.delete(threadId)
      })
      .finally(() => {
        this._activeRunPromises.delete(threadId)
      })
    this._activeRunPromises.set(threadId, runPromise)

    return { alreadyRunning: false }
  }

  /**
   * Kill the active run for `threadId`. Returns `true` when a run or pending
   * throttle retry was found and cancelled, `false` when the thread was idle.
   */
  stop(threadId: string): boolean {
    const retry = this.throttledRetries.get(threadId)
    if (retry) {
      clearTimeout(retry.timer)
      this.throttledRetries.delete(threadId)
      // Flip the DB status back to idle.
      setThreadStatus(threadId, 'idle').catch(() => {})
      return true
    }
    const ctrl = this.activeRuns.get(threadId)
    if (!ctrl) return false
    ctrl.abort()
    return true
  }

  /**
   * Abort every active run. Called by the daemon shutdown hook to ensure all
   * in-flight requests and tool subprocesses are killed before the daemon
   * exits.
   */
  killAll(): void {
    for (const ctrl of this.activeRuns.values()) {
      ctrl.abort()
    }
    for (const retry of this.throttledRetries.values()) {
      clearTimeout(retry.timer)
    }
    this.throttledRetries.clear()
    this.mcp.killAll()
  }

  /**
   * Gracefully drain all active chat runs before daemon shutdown.
   *
   * For each in-flight run:
   * - Cancels pending throttle timers (their retries won't happen post-shutdown).
   * - Aborts each run so `_run` can reach its abort path and call
   *   `finalize()` with whatever segments it has accumulated.
   * - If a run has accumulated no text segments, `message` is written as the
   *   assistant reply so the thread does not end with the default `[no output]`.
   *
   * Waits up to `timeoutMs` for all runs to finalise (bounded by the same
   * wall-clock cap individual runs carry). After the timeout, `killAll()`
   * should be called as a safety net for any runs that did not settle.
   */
  async shutdownDrain(message: string, timeoutMs: number): Promise<void> {
    if (this.activeRuns.size === 0 && this.throttledRetries.size === 0) return
    this._shutdownMessage = message
    // Clear throttle timers — their retries will not run after shutdown.
    for (const retry of this.throttledRetries.values()) clearTimeout(retry.timer)
    this.throttledRetries.clear()
    // Abort all active runs so their _run calls reach finalize().
    for (const ctrl of this.activeRuns.values()) ctrl.abort()
    // Wait for all tracked _run promises to settle, bounded by timeoutMs.
    const promises = Array.from(this._activeRunPromises.values())
    if (promises.length === 0) return
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ])
  }

  // ── Internal run orchestration ─────────────────────────────────────────────

  /**
   * Park a thread in `'throttled'` status and schedule a retry after the
   * appropriate backoff interval. After `THROTTLE_BACKOFF_MS.length` retries
   * the thread is finalised with an error segment so it does not retry forever.
   */
  private async _scheduleThrottle(
    threadId: string,
    content: string,
    repoRoot: string,
    bus: ViewInvalidationBus | undefined,
    attachments: AttachmentInfo[] | undefined,
    retryCount: number,
    userMessagePersisted: boolean,
  ): Promise<void> {
    this.activeRuns.delete(threadId)

    if (retryCount >= THROTTLE_BACKOFF_MS.length) {
      // Exhausted retries — surface a terminal error.
      await setThreadStatus(threadId, 'idle')
      await appendMessage(
        threadId,
        'assistant',
        'Codex is temporarily unavailable. Please try again later.',
        [{ type: 'error', message: 'Codex is temporarily unavailable (rate/usage limit). Retries exhausted.' }],
      )
      bus?.emit('view.chat-invalidated')
      return
    }

    await setThreadStatus(threadId, 'throttled')
    bus?.emit('view.chat-invalidated')

    const delay = THROTTLE_BACKOFF_MS[retryCount]
    const timer = setTimeout(() => {
      this.throttledRetries.delete(threadId)
      const abort = new AbortController()
      this.activeRuns.set(threadId, abort)
      const runPromise = this._run(threadId, content, repoRoot, bus, abort, attachments, retryCount + 1, userMessagePersisted)
        .catch(() => { this.activeRuns.delete(threadId) })
        .finally(() => { this._activeRunPromises.delete(threadId) })
      this._activeRunPromises.set(threadId, runPromise)
    }, delay)
    this.throttledRetries.set(threadId, { retryCount, timer })
  }

  private async _run(
    threadId: string,
    content: string,
    repoRoot: string,
    bus: ViewInvalidationBus | undefined,
    abort: AbortController,
    attachments: AttachmentInfo[] | undefined,
    retryCount: number,
    userMessagePersisted = false,
  ): Promise<void> {
    const cfg = resolveCodexOAuthConfig()
    const accumulatedSegments: ChatSegment[] = []
    let posture: ChatPosture = 'triage'
    const broadcastSegment = (seg: ChatSegment): void => {
      if (seg.type === 'text' && seg.text.length === 0) return
      accumulatedSegments.push(seg)
      // Live UIMessage-chunk streaming: the hub maps + buffers each segment for
      // GET /chat/threads/:id/ui-stream (replacing the old `chat-delta` carrier
      // that the client transport used to map itself).
      this.chatStreamHub?.publish(threadId, seg)
    }

    const finalize = async (extraSeg?: ChatSegment): Promise<void> => {
      this.activeRuns.delete(threadId)
      if (extraSeg) {
        accumulatedSegments.push(extraSeg)
        this.chatStreamHub?.publish(threadId, extraSeg)
      }
      // Seal the UIMessage-chunk stream so connected clients settle. A `result`
      // or `error` segment already emitted the terminal `finish`; otherwise
      // (e.g. a manual stop) this emits `finish` with reason `stop`.
      this.chatStreamHub?.finishRun(threadId)
      // Build a plain-text content from all text segments for the message body.
      const textContent = accumulatedSegments
        .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
        .map((s) => s.text)
        .join('')
      await appendMessage(
        threadId,
        'assistant',
        textContent.length > 0 ? textContent : '[no output]',
        accumulatedSegments,
      )
      // Text extraction predates the durable relation and is lossy (notably
      // for non-shell tools). Keep it solely as a signal for unexpected drift.
      try {
        const [thread, linkedTasks] = await Promise.all([
          getThread(threadId),
          listTasksForThread(threadId),
        ])
        const inferredTaskIds = parseCreatedTaskIds(thread?.messages ?? [])
        const linkedTaskIds = linkedTasks.map((link) => link.taskId)
        if (inferredTaskIds.join('\u0000') !== linkedTaskIds.join('\u0000')) {
          console.warn('[mars chat] task-link drift', { threadId, inferredTaskIds, linkedTaskIds })
        }
      } catch (err) {
        console.warn('[mars chat] unable to check task-link drift', {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      await setThreadStatus(threadId, 'idle')
      const { flushRoutineConversationNotices } = await import('../lib/conversation-delivery.js')
      await flushRoutineConversationNotices(() => this.hasActiveRuns())
      // Invalidation ping so the sidebar re-fetches the thread list.
      bus?.emit('view.chat-invalidated')
    }

    // Open the UIMessage-chunk buffer up-front so EVERY exit path (including an
    // early error before the first request) streams into a live run that
    // connected clients can settle on. The POST that triggered this run already
    // returned 202, so the ui-stream is the client's only channel for outcomes.
    this.chatStreamHub?.startRun(threadId)

    try {
      // Fetch thread for transcript and existence check.
      const threadData = await getThread(threadId)
      if (!threadData) {
        this.activeRuns.delete(threadId)
        // Publish an error segment before sealing so connected clients can
        // surface the failure rather than seeing a silent empty response.
        this.chatStreamHub?.publish(threadId, {
          type: 'error',
          message: `Thread ${threadId} not found — it may have been deleted.`,
        })
        this.chatStreamHub?.finishRun(threadId, 'error')
        return
      }
      posture = threadData.thread.posture

      // ── Per-thread model and thinking-effort resolution ────────────────────
      // Fixed at turn start (rule: "Fixed at turn start; a mid-turn change
      // applies to the next turn"). On the very first turn, the thread has no
      // stored values → resolve from defaults and persist them so subsequent
      // turns in this thread use the same selection even across daemon restarts.
      const provider = resolveProviderName()
      const { modelId: chatModel, thinkingEffort: chatEffort, isNew: isFirstSelection } =
        resolveThreadModelAndEffort(
          provider,
          threadData.thread.model_id,
          threadData.thread.thinking_effort,
        )
      if (isFirstSelection) {
        // Best-effort: a failure here must not abort the turn.
        setThreadModel(threadId, chatModel, chatEffort ?? null).catch((err: unknown) => {
          console.warn('[chat-runner] setThreadModel failed', {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
      // Update conversationMemory facts for the resolved model so the memory
      // window uses accurate limits for this thread's model.
      const threadConversationMemory = resolveCatalogFacts(provider, chatModel)

      const hasMessages = threadData.messages.length > 0

      // Build user segments: always start with a text segment, then append one
      // attachment segment per uploaded file so the UI can render them.
      const userSegments: ChatSegment[] = [{ type: 'text', text: content }]
      let promptContent = content

      if (attachments && attachments.length > 0) {
        const promptLines: string[] = []
        for (const att of attachments) {
          const kindHint: 'image' | 'audio' | 'video' = IMAGE_MIMES.has(att.mimeType)
            ? 'image'
            : AUDIO_MIMES.has(att.mimeType)
              ? 'audio'
              : 'video'
          userSegments.push({ type: 'attachment', path: att.path, mimeType: att.mimeType, name: att.name, size: att.size, kindHint })
          if (kindHint === 'image') {
            promptLines.push(`The user attached image ${att.path} — read it with the shell tool.`)
          } else {
            promptLines.push(
              `The user attached ${kindHint} file ${att.path} (${att.mimeType}) — the agent may use local tools (e.g. ffmpeg) to inspect or transcode it; the model cannot natively hear or watch it.`,
            )
          }
        }
        promptContent = `${content}\n\n---\n${promptLines.join('\n')}\n---`
      }

      // Persist the user message with typed segments so the UI can render it.
      // On throttle retries (retryCount > 0), the user message was already
      // persisted on the first attempt — skip to avoid duplicates.
      if (retryCount === 0 && !userMessagePersisted && (content.length > 0 || (attachments?.length ?? 0) > 0)) {
        await appendMessage(threadId, 'user', content, userSegments)
      }

      // Auto-title: set the thread title to the first user message (≤60 chars)
      // when the thread has no title and no prior messages.
      if (!threadData.thread.title && (!hasMessages || userMessagePersisted)) {
        const title = content.slice(0, 60)
        await updateThreadTitle(threadId, title)
        bus?.emit('view.chat-invalidated')
      }

      // Mark thread as running.
      await setThreadStatus(threadId, 'running')
      bus?.emit('view.chat-invalidated')

      // Replay the persisted transcript as conversation input. On a throttle
      // retry the current user message is already persisted — drop it from the
      // replay so the attachment-augmented prompt below isn't duplicated.
      let transcript: readonly ChatMessage[] = threadData.messages
      if ((retryCount > 0 || userMessagePersisted) && content.length > 0) {
        const last = transcript.at(-1)
        if (last && last.role === 'user') transcript = transcript.slice(0, -1)
      }
      // Main-session cuts happen only while assembling the next Operator
      // request. They never run from an idle timer and never ask a provider to
      // summarize or maintain the prefix.
      const memoryCut = await selectMemoryCut(undefined, threadConversationMemory)
      if (memoryCut) await advanceMainMemoryWindow(undefined, memoryCut)
      const memoryWindow = await readMainMemoryWindow()
      const mainThreadMessages = await listMainSessionMessages(memoryWindow.startsAfterSeq)
      const mainPrefix = buildApiInput(buildMainThreadPrefix(mainThreadMessages))
      const subthreadInput = buildApiInput(
        transcript.filter((message) => message.context_scope !== 'main' && message.kind !== 'situation'),
      )

      // Inject the existing Domain Flow as a context_line prefix when this
      // thread is scoped to a specific task. `getFlowByArcId` is a stub until
      // the domain flow store lands; when it returns a flow the rendered text
      // is prepended so the agent can re-render or update the flow without
      // calling `get_domain_flow` explicitly.
      const arcId = threadData.thread.terminal_entity_id ?? null
      const existingFlow = arcId !== null ? await getFlowByArcId(arcId) : null
      const flowContextItems: ResponseInputItem[] = existingFlow !== null
        ? [{ type: 'message', role: 'user' as const, content: [{ type: 'input_text' as const, text: `[Domain Flow context for this task]\n${existingFlow.rendered}` }] }]
        : []

      const input: ResponseInputItem[] = [...mainPrefix, ...flowContextItems, ...subthreadInput]
      if (content.length > 0) {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: promptContent }] })
      }

      // Arm the wall-clock timeout.
      let isTimeout = false
      const timer = setTimeout(() => {
        isTimeout = true
        abort.abort()
      }, cfg.requestTimeoutMs)

      try {
        const [resolvedPrompt, skills, mcpTools] = await Promise.all([
          resolveChatSystemPrompt(repoRoot),
          discoverSkills(repoRoot),
          this.mcp.getTools(repoRoot),
        ])
        const mcpDefs = buildMcpToolDefs(mcpTools)
        const mcpToolNames = new Set(mcpDefs.map((t) => t.name))
        const instructionsForPosture = (): string => {
          const skillsSection = buildSkillsSection(skills, posture)
          return skillsSection.length > 0 ? `${resolvedPrompt.prompt}\n\n${skillsSection}` : resolvedPrompt.prompt
        }
        const toolsForPosture = (): FunctionToolDef[] =>
          posture === 'grill' ? [...CHAT_TOOLS, OVERRIDE_END_GRILL_TOOL, ...mcpDefs] : TRIAGE_TOOLS
        let auth: CodexAuth = await loadCodexAuth()
        let authRetried = false

        // Aggregate usage across all tool-loop round-trips into one result segment.
        let sawUsage = false
        const usageTotals = { input: 0, output: 0, cached: 0 }
        // Stop reason from the last `response.completed` event seen in any turn.
        // May be overridden to 'max_turns' after the loop when the turn cap fires.
        let lastTurnStopReason: ChatStopReason = 'complete'
        // True when the loop exited because pendingCalls was empty (normal end).
        // False if it ran to the cfg.maxToolTurns cap with pending calls remaining.
        let exitedWithNoPending = false

        for (let turn = 0; turn < cfg.maxToolTurns; turn++) {
          type PendingCall = { callId: string; tool: string; input: unknown; seg: ChatSegment & { type: 'tool_use' } }
          const pendingCalls: PendingCall[] = []

          for (;;) {
            pendingCalls.length = 0
            try {
              const providerRequest = streamCodexResponse({
                auth,
                model: chatModel,
                effort: chatEffort,
                instructions: instructionsForPosture(),
                input,
                tools: toolsForPosture(),
                requestIdentity: MAIN_THREAD_PROVIDER_REQUEST_IDENTITY,
                signal: abort.signal,
                onEvent: (event) => {
                  for (const seg of parseEventToSegments(event)) {
                    if (seg.type === 'result') {
                      sawUsage = true
                      usageTotals.input += seg.inputTokens ?? 0
                      usageTotals.output += seg.outputTokens ?? 0
                      usageTotals.cached += seg.cacheReadTokens ?? 0
                      // Capture the stop reason from this turn's result event.
                      if (seg.stopReason) lastTurnStopReason = seg.stopReason
                      continue
                    }
                    // Defer tool_use broadcast until after execution so we can
                    // detect mars-propose envelopes and set the correct status.
                    if (seg.type === 'tool_use') {
                      pendingCalls.push({ callId: seg.id, tool: seg.tool, input: seg.input, seg })
                    } else {
                      broadcastSegment(seg)
                    }
                  }
                },
              })
              // The provider request has been started. Updating this after
              // construction keeps idle time entirely side-effect free.
              await markMainMemoryWindowUsed(undefined)
              await providerRequest
              break
            } catch (err) {
              // One silent token refresh per run before surfacing the auth banner.
              if (err instanceof CodexApiError && err.kind === 'auth' && !authRetried) {
                authRetried = true
                auth = await refreshCodexAuth(auth)
                continue
              }
              throw err
            }
          }

          if (abort.signal.aborted || pendingCalls.length === 0) {
            exitedWithNoPending = pendingCalls.length === 0
            break
          }

          for (const call of pendingCalls) {
            const args = isObject(call.input) ? call.input : {}
            let result: { content: unknown; isError: boolean }
            if (call.tool === 'set_posture') {
              if (args.posture !== 'grill') {
                result = { content: 'invalid set_posture arguments: only "grill" is supported', isError: true }
              } else if (posture === 'grill') {
                result = { content: 'grill posture is already active', isError: false }
              } else {
                await setThreadPosture(threadId, 'grill')
                posture = 'grill'
                await appendMessage(
                  threadId,
                  'assistant',
                  'System: This conversation is now in grill posture. I can use glossary, ADR, and PRD tools as we shape the work.',
                  [{ type: 'system', message: 'Grill posture enabled.' }],
                )
                bus?.emit('view.chat-invalidated')
                result = { content: 'grill posture enabled', isError: false }
              }
            } else if (call.tool === 'override_end_grill') {
              const taskSpec = typeof args.taskSpec === 'string' ? args.taskSpec.trim() : ''
              if (posture !== 'grill') {
                result = { content: 'override_end_grill is only available in grill posture', isError: true }
              } else if (taskSpec.length === 0) {
                result = { content: 'invalid override_end_grill arguments: "taskSpec" must be a non-empty string', isError: true }
              } else {
                const task = await enqueueTask(taskSpec, undefined, { skipTriage: true, chatThreadId: threadId })
                await setThreadPosture(threadId, 'triage')
                posture = 'triage'
                await appendMessage(
                  threadId,
                  'assistant',
                  `System: I left grill posture and queued task ${task.id}.`,
                  [{ type: 'system', message: `Grill override queued task ${task.id}.` }],
                )
                bus?.emit('view.chat-invalidated')
                result = { content: `queued task ${task.id}; grill posture ended`, isError: false }
              }
            } else if (call.tool === 'override_reshape_as_proposal') {
              const originalTaskId = typeof args.originalTaskId === 'string' ? args.originalTaskId : ''
              const proposalDraft = typeof args.proposalDraft === 'string' ? args.proposalDraft.trim() : ''
              if (posture !== 'triage') {
                result = { content: 'override_reshape_as_proposal is only available in triage posture', isError: true }
              } else if (originalTaskId.length === 0 || proposalDraft.length === 0) {
                result = { content: 'invalid override_reshape_as_proposal arguments: "originalTaskId" and "proposalDraft" must be non-empty strings', isError: true }
              } else {
                const original = await getTask(originalTaskId)
                if (!original) {
                  result = { content: `task ${originalTaskId} not found`, isError: true }
                } else if (original.status !== 'queued') {
                  result = { content: `task ${originalTaskId} is ${original.status}; only queued tasks can be reshaped`, isError: true }
                } else {
                  // A newly enqueued task has no worker-owned worktree yet. Mark it
                  // terminal before using the canonical purge path, preserving the
                  // same lifecycle cleanup and audit semantics as `mars purge`.
                  await updateTask(originalTaskId, { status: 'dropped', dropReason: 'superseded' })
                  await corePurgeTask(originalTaskId, false, integrationBranchName(), repoRoot)
                  const proposal = await createProposal(proposalDraft, {
                    notes: `Reshaped from task ${originalTaskId}. Original ask: ${original.prompt}`,
                  })
                  await appendMessage(
                    threadId,
                    'assistant',
                    `System: I replaced task ${originalTaskId} with proposal ${proposal.id}.`,
                    [{ type: 'system', message: `Task ${originalTaskId} reshaped as proposal ${proposal.id}.` }],
                  )
                  bus?.emit('view.chat-invalidated')
                  result = { content: `purged task ${originalTaskId}; created proposal ${proposal.id}`, isError: false }
                }
              }
            } else if (posture === 'grill' && mcpToolNames.has(call.tool)) {
              const r = await this.mcp.call(repoRoot, call.tool, args)
              result = { content: truncate(r.text, MCP_OUTPUT_CHAR_CAP), isError: r.isError }
            } else {
              result = await executeToolCall(call.tool, args, repoRoot, abort.signal)
              // When the agent runs `mars task add ...` as a shell command, link
              // any created tasks to this thread so the TASKS panel reflects them.
              // `linkTaskToThread` uses ON CONFLICT DO NOTHING — repeated calls for
              // the same pair are safe. Errors are swallowed; the end-of-run drift
              // log will flag any residual gap.
              if (call.tool === 'shell' && !result.isError) {
                const cmd = typeof args.command === 'string' ? args.command : ''
                if (cmd.includes('mars task') && isObject(result.content)) {
                  const stdout = String((result.content as Record<string, unknown>).stdout ?? '')
                  for (const m of stdout.matchAll(CHAT_TASK_ID_RE)) {
                    await linkTaskToThread(threadId, m[0]).catch(() => {})
                  }
                }
              }
            }

            // Detect mars-propose envelope: stdout is valid JSON matching
            // { kind: 'mars-propose', verb, args, proposalId }.
            let proposed: { verb: string; propArgs: unknown; proposalId: string } | null = null
            if (call.tool === 'shell' && isObject(result.content) && typeof (result.content as Record<string, unknown>).stdout === 'string') {
              const raw = ((result.content as Record<string, unknown>).stdout as string).trim()
              try {
                const parsed = JSON.parse(raw)
                if (
                  isObject(parsed) &&
                  parsed.kind === 'mars-propose' &&
                  typeof parsed.verb === 'string' &&
                  typeof parsed.proposalId === 'string'
                ) {
                  proposed = { verb: parsed.verb, propArgs: parsed.args, proposalId: parsed.proposalId as string }
                }
              } catch { /* not JSON — treat as normal output */ }
            }

            if (proposed !== null) {
              // Proposed: emit a single tool_use with status:'proposed'; no tool_result.
              broadcastSegment({
                type: 'tool_use',
                id: call.callId,
                tool: call.tool,
                name: 'mars ' + proposed.verb,
                input: { args: proposed.propArgs, proposalId: proposed.proposalId },
                status: 'proposed',
              })
            } else {
              // Normal: emit deferred tool_use then tool_result.
              broadcastSegment(call.seg)
              broadcastSegment({ type: 'tool_result', tool_use_id: call.callId, content: result.content, isError: result.isError })
            }

            input.push({ type: 'function_call', name: call.tool, arguments: JSON.stringify(args), call_id: call.callId })
            input.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(result.content) })
            if (abort.signal.aborted) break
          }
          if (abort.signal.aborted) break
        }

        if (!abort.signal.aborted) {
          // Determine the final stop reason for this run.
          // max_turns fires when the loop ran to its cap without a clean exit.
          const finalStopReason: ChatStopReason =
            !exitedWithNoPending && !abort.signal.aborted ? 'max_turns' : lastTurnStopReason

          // Surface a plain notice for any non-complete stop so the truncation
          // is visible both in the live stream and on reload. Broadcast it BEFORE
          // the result segment so it lands in the stream before the run seals.
          if (finalStopReason !== 'complete') {
            broadcastSegment({ type: 'notice', text: STOP_REASON_NOTICES[finalStopReason] })
          }

          if (sawUsage) {
            broadcastSegment({
              type: 'result',
              durationMs: null,
              inputTokens: usageTotals.input,
              outputTokens: usageTotals.output,
              cacheReadTokens: usageTotals.cached,
              cost: null,
              stopReason: finalStopReason,
            })
          }
        }
      } catch (err) {
        clearTimeout(timer)

        if (isTimeout) {
          await finalize({ type: 'error', message: 'Run timed out after 10 minutes' })
          return
        }
        if (abort.signal.aborted) {
          // When the daemon is shutting down and no text was produced yet,
          // surface the shutdown notice so the thread doesn't end with
          // "[no output]".
          const shutdownMsg = this._shutdownMessage
          if (shutdownMsg && !accumulatedSegments.some((s) => s.type === 'text')) {
            await finalize({ type: 'text', text: shutdownMsg })
          } else {
            await finalize()
          }
          return
        }

        if (err instanceof CodexApiError) {
          // ── Auth failure: surface a single global banner, set throttled. ────
          if (err.kind === 'auth') {
            if (!this.codexAuthFailed) {
              this.codexAuthFailed = true
              for (const listener of this.authListeners) listener(true)
            }
            await this._scheduleThrottle(threadId, content, repoRoot, bus, attachments, retryCount, userMessagePersisted)
            return
          }
          // ── Rate/usage limit: throttle + auto-retry with backoff. ───────────
          if (err.kind === 'rate-limit') {
            await this._scheduleThrottle(threadId, content, repoRoot, bus, attachments, retryCount, userMessagePersisted)
            return
          }
          // ── http/network: terminal error (user-safe, no provider details). ──
          await finalize({
            type: 'error',
            message: 'Codex could not complete this response. Try again; if it continues, check the local Codex auth and network.',
          })
          return
        }
        throw err
      }
      clearTimeout(timer)

      if (isTimeout) {
        await finalize({ type: 'error', message: 'Run timed out after 10 minutes' })
        return
      }

      if (abort.signal.aborted) {
        const shutdownMsg = this._shutdownMessage
        if (shutdownMsg && !accumulatedSegments.some((s) => s.type === 'text')) {
          await finalize({ type: 'text', text: shutdownMsg })
        } else {
          await finalize()
        }
        return
      }

      if (!accumulatedSegments.some((seg) => seg.type === 'text')) {
        // The model completed a turn but produced zero assistant text. This is a
        // distinct failure mode — it can happen when the selected model rejects
        // the requested thinking mode, refuses the turn upstream before producing
        // output, or the protocol delivers no message items. Surface it as an
        // explicit empty-turn notice rather than rendering a blank message.
        await finalize({
          type: 'notice',
          text: 'The model completed without producing any output. This may indicate a model capability mismatch or a transient issue — try again.',
        })
        return
      }

      await finalize()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Best-effort finalisation — may itself fail if the DB is gone.
      try {
        await finalize({ type: 'error', message: msg })
      } catch {
        this.activeRuns.delete(threadId)
        await setThreadStatus(threadId, 'idle').catch(() => {})
      }
    }
  }
}
