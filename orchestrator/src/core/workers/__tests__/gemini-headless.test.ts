// Acceptance tests for the Gemini headless adapter (slice 3 of PRD 3f05ebd9).
//
// Mocks runSubprocessStreaming so the tests run without a real gemini binary.
// Each describe block corresponds to one acceptance criterion.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClaudeEvent } from '../../lib/claude-stream'

// vi.mock is hoisted by vitest above all imports so the mock factory runs
// before any module that imports '../../lib/git/claude' loads its real
// implementation. Both resolveClaudeBin and runSubprocessStreaming are
// included so the spy can confirm claude's resolver is never touched by
// the gemini adapter.
// Spread importOriginal rather than listing exports by hand: the adapter also
// pulls pure helpers (isBlankPrompt, emptyPromptResult) from this module, and
// a hand-written export list silently turns any newly-imported helper into
// `undefined` at call time.
vi.mock('../../lib/git/claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/git/claude')>()),
  runSubprocessStreaming: vi.fn(),
  buildWorkerEnv: vi.fn(() => ({})),
  resolveClaudeBin: vi.fn(),
}))

import { parseGeminiEventLine, geminiHeadless } from '../providers/gemini-headless'
import { runSubprocessStreaming, resolveClaudeBin } from '../../lib/git/claude'

// ---------------------------------------------------------------------------
// parseGeminiEventLine — pure normalisation helper
// ---------------------------------------------------------------------------

describe('parseGeminiEventLine — normalisation', () => {
  it('wraps a plain text line as an assistant ClaudeEvent', () => {
    const ev = parseGeminiEventLine('hello from gemini')
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe('assistant')
    const msg = (ev as unknown as { message: { role: string; content: { type: string; text: string }[] } }).message
    expect(msg.role).toBe('assistant')
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0].type).toBe('text')
    expect(msg.content[0].text).toBe('hello from gemini')
  })

  it('returns null for an empty line', () => {
    expect(parseGeminiEventLine('')).toBeNull()
  })

  it('returns null for a whitespace-only line', () => {
    expect(parseGeminiEventLine('   ')).toBeNull()
  })

  it('preserves the full text of a multi-word line', () => {
    const ev = parseGeminiEventLine('The task is complete.')
    expect(ev).not.toBeNull()
    const msg = (ev as unknown as { message: { content: { text: string }[] } }).message
    expect(msg.content[0].text).toBe('The task is complete.')
  })
})

// ---------------------------------------------------------------------------
// Shared mock setup — simulates a gemini stdout text line followed by exit 0.
// ---------------------------------------------------------------------------

const TEXT_LINE = 'Gemini says: task complete'

beforeEach(() => {
  vi.mocked(runSubprocessStreaming).mockImplementation(
    async (
      _cmd: string,
      _args: readonly string[],
      _cwd: string,
      onLine?: (event: { stream: 'stdout' | 'stderr'; line: string }) => void | Promise<void>,
    ) => {
      if (onLine) {
        await onLine({ stream: 'stdout', line: TEXT_LINE })
        // A stderr line should be ignored by the adapter's stream guard
        await onLine({ stream: 'stderr', line: 'some stderr output' })
      }
      return { exitCode: 0, stdout: TEXT_LINE, stderr: '' }
    },
  )
  vi.mocked(resolveClaudeBin).mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Acceptance criterion (a): argv starts with ['-p', prompt, '--model', ...]
// ---------------------------------------------------------------------------

describe('geminiHeadless.run — (a) argv shape', () => {
  it("first four argv entries are ['-p', <prompt>, '--model', <model>]", async () => {
    await geminiHeadless.run('build the feature', { cwd: '/tmp', model: 'gemini-2.5-flash' })

    const callArgs = vi.mocked(runSubprocessStreaming).mock.calls[0]
    const argv = callArgs[1] as readonly string[]

    expect(argv[0]).toBe('-p')
    expect(argv[1]).toBe('build the feature')
    expect(argv[2]).toBe('--model')
    expect(argv[3]).toBe('gemini-2.5-flash')
  })

  it("defaults model to 'gemini-2.5-pro' when opts.model is absent", async () => {
    await geminiHeadless.run('task', { cwd: '/tmp' })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    expect(argv[2]).toBe('--model')
    expect(argv[3]).toBe('gemini-2.5-pro')
  })

  it('argv has exactly four entries: -p, prompt, --model, model', async () => {
    await geminiHeadless.run('do something', { cwd: '/tmp', model: 'gemini-2.5-pro' })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    expect(argv).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion (b): resolveClaudeBin is NOT called
// ---------------------------------------------------------------------------

describe('geminiHeadless.run — (b) resolveClaudeBin not called', () => {
  it('does not invoke resolveClaudeBin during a gemini headless run', async () => {
    await geminiHeadless.run('task', { cwd: '/tmp', model: 'gemini-2.5-pro' })
    expect(vi.mocked(resolveClaudeBin)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Event normalisation: stdout lines → assistant events, stderr ignored
// ---------------------------------------------------------------------------

describe('geminiHeadless.run — (c) event normalisation and onEvent forwarding', () => {
  it('forwards stdout text lines as assistant events (ignores stderr)', async () => {
    const received: ClaudeEvent[] = []
    await geminiHeadless.run('task', {
      cwd: '/tmp',
      model: 'gemini-2.5-pro',
      onEvent: (ev) => { received.push(ev) },
    })

    const assistantEvents = received.filter((ev) => ev.type === 'assistant')
    expect(assistantEvents).toHaveLength(1)
    const msgEv = assistantEvents[0] as unknown as {
      message: { role: string; content: { type: string; text: string }[] }
    }
    expect(msgEv.message.role).toBe('assistant')
    expect(msgEv.message.content[0].text).toBe(TEXT_LINE)
  })

  it('conversation in the returned result matches events forwarded to onEvent', async () => {
    const fromHook: ClaudeEvent[] = []
    const result = await geminiHeadless.run('task', {
      cwd: '/tmp',
      model: 'gemini-2.5-pro',
      onEvent: (ev) => { fromHook.push(ev) },
    })

    expect(result.conversation).toHaveLength(fromHook.length)
    for (let i = 0; i < fromHook.length; i++) {
      expect(result.conversation[i].type).toBe(fromHook[i].type)
    }
  })

  it('synthesises a result event with is_error: true and stderr when exit code is nonzero', async () => {
    vi.mocked(runSubprocessStreaming).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'gemini: command failed',
    })

    const received: ClaudeEvent[] = []
    await geminiHeadless.run('task', {
      cwd: '/tmp',
      model: 'gemini-2.5-pro',
      onEvent: (ev) => { received.push(ev) },
    })

    const resultEvents = received.filter((ev) => ev.type === 'result')
    expect(resultEvents).toHaveLength(1)
    const resultEv = resultEvents[0] as unknown as { is_error: boolean; result: string }
    expect(resultEv.is_error).toBe(true)
    expect(resultEv.result).toBe('gemini: command failed')
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion (d): result has sessionId: null and quotaRejected: null
// ---------------------------------------------------------------------------

describe('geminiHeadless.run — (d) null signals', () => {
  it('returns sessionId: null', async () => {
    const result = await geminiHeadless.run('task', { cwd: '/tmp', model: 'gemini-2.5-pro' })
    expect(result.sessionId).toBeNull()
  })

  it('returns quotaRejected: null', async () => {
    const result = await geminiHeadless.run('task', { cwd: '/tmp', model: 'gemini-2.5-pro' })
    expect(result.quotaRejected).toBeNull()
  })

  it('passes through exitCode from the subprocess result', async () => {
    vi.mocked(runSubprocessStreaming).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'oops' })
    const result = await geminiHeadless.run('task', { cwd: '/tmp', model: 'gemini-2.5-pro' })
    expect(result.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// capabilities descriptor
// ---------------------------------------------------------------------------

describe('geminiHeadless capabilities', () => {
  it("exposes usageSemantics: 'none', quotaRejected: false, sessionId: false", () => {
    const { capabilities } = geminiHeadless
    expect(capabilities.usageSemantics).toBe('none')
    expect(capabilities.quotaRejected).toBe(false)
    expect(capabilities.sessionId).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Regression: an empty prompt must never reach the CLI.
//
// `gemini -p ''` falls back to reading the prompt from stdin. Dispatched
// workers get stdin=/dev/null, so the CLI reads EOF and exits non-zero having
// produced no usable diagnostic — the same contentless failure shape that made
// a codex quota rejection unreadable in production.
// ---------------------------------------------------------------------------

describe('geminiHeadless.run — empty prompt fails fast without spawning', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '  \n\t '],
  ])('refuses to spawn for a %s prompt', async (_label, prompt) => {
    const result = await geminiHeadless.run(prompt, { cwd: '/tmp', model: 'gemini-2.5-pro' })

    expect(runSubprocessStreaming).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/refusing to spawn gemini with an empty prompt/i)
    expect(result.conversation).toEqual([])
  })
})
