/**
 * Tests for codex-oauth.ts — request shape, incremental SSE handling, the tool
 * loop, and failure classification.
 *
 * `fetch` is stubbed with a canned SSE body per turn. The shell tool is NOT
 * stubbed: the tool-loop tests run real `echo`/`false` commands so the
 * allowlist and exit-code plumbing are exercised end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deriveCommandName,
  resolveCodexOAuthConfig,
  runCodexOAuthTurn,
  type CodexOAuthConfig,
} from '../codex-oauth'
import type { ChatSegment } from '../chat-runner'

const CREDENTIALS = { accessToken: 'test-token', accountId: 'acct-1' }

const config = (overrides: Partial<CodexOAuthConfig> = {}): CodexOAuthConfig => ({
  baseUrl: 'https://chatgpt.test/backend-api/codex',
  model: 'gpt-5.5',
  effort: 'none',
  maxToolTurns: 4,
  requestTimeoutMs: 5_000,
  shellAllowlist: ['echo', 'false'],
  ...overrides,
})

/** Build an SSE response body from a list of event objects. */
const sseResponse = (events: unknown[], status = 200): Response => {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Chunked mid-event to prove the line buffer reassembles split frames.
      const bytes = new TextEncoder().encode(text)
      const mid = Math.floor(bytes.length / 2)
      controller.enqueue(bytes.slice(0, mid))
      controller.enqueue(bytes.slice(mid))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

const textDelta = (delta: string) => ({ type: 'response.output_text.delta', delta })
const completed = (usage?: Record<string, number>) => ({
  type: 'response.completed',
  response: { id: 'resp-1', usage: usage ?? { input_tokens: 50, output_tokens: 10, cached_input_tokens: 40 } },
})
const functionCall = (command: string, callId = 'call-1') => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', name: 'shell', call_id: callId, arguments: JSON.stringify({ command }) },
})

/** Run a turn, collecting streamed segments. */
const run = async (overrides: Partial<Parameters<typeof runCodexOAuthTurn>[0]> = {}) => {
  const segments: ChatSegment[] = []
  const result = await runCodexOAuthTurn({
    systemPrompt: 'SYSTEM',
    history: [],
    prompt: 'hello',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onSegment: (s) => segments.push(s),
    config: config(),
    credentials: CREDENTIALS,
    ...overrides,
  })
  return { result, segments }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deriveCommandName', () => {
  it('keeps the mars verb so the UI can group consecutive calls', () => {
    expect(deriveCommandName('mars task add "do a thing"')).toBe('mars task')
  })

  it('uses the first token for anything else', () => {
    expect(deriveCommandName('  ls -la /tmp')).toBe('ls')
  })
})

describe('request shape', () => {
  it('sends store:false with the system prompt as instructions', async () => {
    fetchMock.mockImplementation(() => sseResponse([textDelta('hi'), completed()]))
    await run()

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    // The backend rejects store:true outright, so this is not optional.
    expect(body.store).toBe(false)
    expect(body.instructions).toBe('SYSTEM')
    expect(body.model).toBe('gpt-5.5')
    expect(body.reasoning).toEqual({ effort: 'none' })
  })

  it('omits reasoning.encrypted_content at effort none', async () => {
    fetchMock.mockImplementation(() => sseResponse([textDelta('hi'), completed()]))
    await run()

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).include).toBeUndefined()
  })

  it('includes reasoning.encrypted_content once reasoning is enabled', async () => {
    fetchMock.mockImplementation(() => sseResponse([textDelta('hi'), completed()]))
    await run({ config: config({ effort: 'high' }) })

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).include).toEqual([
      'reasoning.encrypted_content',
    ])
  })

  it('sends history before the current prompt', async () => {
    fetchMock.mockImplementation(() => sseResponse([textDelta('hi'), completed()]))
    await run({
      history: [{ role: 'user', content: [{ type: 'input_text', text: 'earlier' }] }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.input).toHaveLength(2)
    expect(body.input[0].content[0].text).toBe('earlier')
    expect(body.input[1].content[0].text).toBe('hello')
  })

  it('sends the bearer token and account id as headers, never in the body', async () => {
    fetchMock.mockImplementation(() => sseResponse([textDelta('hi'), completed()]))
    await run()

    const init = fetchMock.mock.calls[0]![1]
    expect(init.headers.Authorization).toBe('Bearer test-token')
    expect(init.headers['chatgpt-account-id']).toBe('acct-1')
    expect(init.body as string).not.toContain('test-token')
  })
})

describe('streaming', () => {
  it('emits each text delta as its own segment', async () => {
    fetchMock.mockImplementation(() => sseResponse([
      textDelta('Hel'), textDelta('lo '), textDelta('world'), completed(),
    ]))
    const { result, segments } = await run()

    expect(result.ok).toBe(true)
    expect(segments).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo ' },
      { type: 'text', text: 'world' },
    ])
  })

  it('accumulates usage from response.completed', async () => {
    fetchMock.mockImplementation(() => sseResponse([
      textDelta('hi'),
      completed({ input_tokens: 120, output_tokens: 8, cached_input_tokens: 100 }),
    ]))
    const { result } = await run()

    expect(result).toEqual({
      ok: true,
      usage: { inputTokens: 120, outputTokens: 8, cachedInputTokens: 100 },
    })
  })

  it('falls back to message item text when no deltas arrive', async () => {
    fetchMock.mockImplementation(() => sseResponse([
      { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'from item' }] } },
      completed(),
    ]))
    const { segments } = await run()

    expect(segments).toEqual([{ type: 'text', text: 'from item' }])
  })

  it('flushes reasoning summary deltas as one thinking segment', async () => {
    fetchMock.mockImplementation(() => sseResponse([
      { type: 'response.reasoning_summary_text.delta', delta: 'Check' },
      { type: 'response.reasoning_summary_text.delta', delta: 'ing.' },
      { type: 'response.output_item.done', item: { type: 'reasoning' } },
      textDelta('done'),
      completed(),
    ]))
    const { segments } = await run({ config: config({ effort: 'high' }) })

    expect(segments[0]).toEqual({ type: 'thinking', thinking: 'Checking.' })
  })
})

describe('tool loop', () => {
  it('runs an allowed command and feeds the output back for a second turn', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([functionCall('echo mars-ok'), completed()]))
      .mockResolvedValueOnce(sseResponse([textDelta('mars-ok'), completed()]))

    const { result, segments } = await run()

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const toolUse = segments.find((s) => s.type === 'tool_use')
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'echo' })

    const toolResult = segments.find((s) => s.type === 'tool_result')
    expect(toolResult).toMatchObject({ isError: false })
    expect((toolResult as { content: { stdout: string } }).content.stdout).toContain('mars-ok')

    // Turn two replays the call and its output.
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string)
    const output = secondBody.input.find((i: { type?: string }) => i.type === 'function_call_output')
    expect(output.call_id).toBe('call-1')
    expect(output.output).toContain('mars-ok')
  })

  it('reports a non-zero exit as a tool error without failing the turn', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([functionCall('false'), completed()]))
      .mockResolvedValueOnce(sseResponse([textDelta('that failed'), completed()]))

    const { result, segments } = await run()

    expect(result.ok).toBe(true)
    expect(segments.find((s) => s.type === 'tool_result')).toMatchObject({ isError: true })
  })

  it('refuses a command outside the allowlist without executing it', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([functionCall('rm -rf /tmp/should-not-run'), completed()]))
      .mockResolvedValueOnce(sseResponse([textDelta('refused'), completed()]))

    const { segments } = await run()

    const toolResult = segments.find((s) => s.type === 'tool_result') as {
      isError: boolean
      content: { stderr: string; exitCode: number }
    }
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content.exitCode).toBe(126)
    expect(toolResult.content.stderr).toContain('not permitted')
  })

  it('runs any command when the allowlist is disabled', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([functionCall('printf unrestricted'), completed()]))
      .mockResolvedValueOnce(sseResponse([textDelta('ok'), completed()]))

    const { segments } = await run({ config: config({ shellAllowlist: null }) })

    const toolResult = segments.find((s) => s.type === 'tool_result') as {
      isError: boolean
      content: { stdout: string }
    }
    expect(toolResult.isError).toBe(false)
    expect(toolResult.content.stdout).toContain('unrestricted')
  })

  it('accumulates usage across tool turns', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([functionCall('echo a'), completed({ input_tokens: 10, output_tokens: 1, cached_input_tokens: 0 })]))
      .mockResolvedValueOnce(sseResponse([textDelta('a'), completed({ input_tokens: 30, output_tokens: 2, cached_input_tokens: 8 })]))

    const { result } = await run()

    expect(result).toEqual({
      ok: true,
      usage: { inputTokens: 40, outputTokens: 3, cachedInputTokens: 8 },
    })
  })

  it('stops after maxToolTurns rather than looping forever', async () => {
    fetchMock.mockImplementation(() => sseResponse([functionCall('echo loop'), completed()]))

    const { result } = await run({ config: config({ maxToolTurns: 2 }) })

    expect(result).toMatchObject({ ok: false, kind: 'generic' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('failure classification', () => {
  it('maps 401 to auth', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"unauthorized"}', { status: 401 }))
    expect((await run()).result).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('maps 403 to auth', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"forbidden"}', { status: 403 }))
    expect((await run()).result).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('maps 429 to rate-limit', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"too many requests"}', { status: 429 }))
    expect((await run()).result).toMatchObject({ ok: false, kind: 'rate-limit' })
  })

  it('maps other statuses to generic and surfaces the provider detail', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"Store must be set to false"}', { status: 400 }))
    const { result } = await run()

    expect(result).toMatchObject({ ok: false, kind: 'generic' })
    expect((result as { message: string }).message).toBe('Store must be set to false')
  })

  it('classifies a rate-limit reported mid-stream', async () => {
    fetchMock.mockImplementation(() => sseResponse([
      { type: 'response.failed', response: { error: { message: 'usage limit reached' } } },
    ]))
    expect((await run()).result).toMatchObject({ ok: false, kind: 'rate-limit' })
  })

  it('retries a 500 and succeeds — the endpoint returns these intermittently', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"detail":"{\\"error\\":{\\"message\\":\\"server_error\\"}}"}', { status: 500 }))
      .mockImplementationOnce(() => sseResponse([textDelta('recovered'), completed()]))

    const { result, segments } = await run()

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(segments).toEqual([{ type: 'text', text: 'recovered' }])
  })

  it('gives up after the retry budget and reports the unwrapped message', async () => {
    // A fresh Response per attempt: a body can only be read once.
    fetchMock.mockImplementation(
      () => new Response('{"detail":"{\\n \\"error\\": {\\n \\"message\\": \\"The server had an error.\\"\\n }\\n}"}', { status: 500 }),
    )

    const { result } = await run()

    // Initial attempt plus three retries.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ ok: false, kind: 'generic' })
    // Double-encoded `detail` is unwrapped rather than surfaced as escaped JSON.
    expect((result as { message: string }).message).toBe('The server had an error.')
  })

  it('retries a dropped connection before the stream starts', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(() => sseResponse([textDelta('ok'), completed()]))

    expect((await run()).result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 401 — re-authentication is the only fix', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"unauthorized"}', { status: 401 }))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 429 — the runner owns throttle backoff', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"too many requests"}', { status: 429 }))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a stream that ended without producing anything', async () => {
    fetchMock.mockImplementation(() => sseResponse([{ type: 'response.created' }]))
    const { result } = await run()

    expect(result).toMatchObject({ ok: false, kind: 'generic' })
    expect((result as { message: string }).message).toMatch(/ended without producing/)
  })

  it('reports no-token when credentials are unavailable', async () => {
    // CODEX_HOME points somewhere without an auth.json, so the on-disk lookup fails.
    vi.stubEnv('CODEX_HOME', '/nonexistent/codex-home')
    const segments: ChatSegment[] = []
    const result = await runCodexOAuthTurn({
      systemPrompt: 'SYSTEM',
      history: [],
      prompt: 'hello',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onSegment: (s) => segments.push(s),
      config: config(),
    })

    expect(result).toMatchObject({ ok: false, kind: 'no-token' })
    expect((result as { message: string }).message).toContain('codex login')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('treats a caller abort as a clean stop, not a provider failure', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    })

    const { result } = await run({ signal: controller.signal })
    expect(result.ok).toBe(true)
  })
})

describe('resolveCodexOAuthConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to effort none with no allowlist', () => {
    const resolved = resolveCodexOAuthConfig()
    expect(resolved.effort).toBe('none')
    expect(resolved.model).toBe('gpt-5.5')
    // Off by default: a prefix check is not a sandbox and breaks real commands.
    expect(resolved.shellAllowlist).toBeNull()
  })

  it('honours env overrides', () => {
    vi.stubEnv('MARS_CHAT_MODEL', 'gpt-5.6')
    vi.stubEnv('MARS_CHAT_EFFORT', 'low')
    vi.stubEnv('MARS_CHAT_MAX_TOOL_TURNS', '3')
    vi.stubEnv('MARS_CHAT_SHELL_ALLOWLIST', '1')

    const resolved = resolveCodexOAuthConfig()
    expect(resolved).toMatchObject({ model: 'gpt-5.6', effort: 'low', maxToolTurns: 3 })
    expect(resolved.shellAllowlist).toContain('mars')
  })

  it('ignores a non-numeric tool-turn override', () => {
    vi.stubEnv('MARS_CHAT_MAX_TOOL_TURNS', 'lots')
    expect(resolveCodexOAuthConfig().maxToolTurns).toBe(12)
  })
})
