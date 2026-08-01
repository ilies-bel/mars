// Acceptance tests for the Codex headless adapter (slice 2 of PRD 3f05ebd9).
//
// Mocks runSubprocessStreaming so the tests run without a real codex binary.
// Each describe block corresponds to one acceptance criterion.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClaudeEvent } from '../../lib/claude-stream'

// vi.mock is hoisted by vitest above all imports so the mock factory runs
// before any module that imports '../../lib/git/claude' loads its real
// implementation. Both resolveClaudeBin and runSubprocessStreaming are
// included so the spy can confirm claude's resolver is never touched by
// the codex adapter.
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

import {
  parseCodexEventLine,
  readCodexOutput,
  codexHeadless,
  stripBenignCodexStderr,
} from '../providers/codex-headless'
import { runSubprocessStreaming, resolveClaudeBin } from '../../lib/git/claude'
import { computeFailureSignature } from '../../lib/failure-signature'
import { extractLastStreamText } from '../../lib/claude-stream'

// ---------------------------------------------------------------------------
// parseCodexEventLine — pure normalisation helper
// ---------------------------------------------------------------------------

describe('parseCodexEventLine — normalisation', () => {
  it('maps item.completed(agent_message) to an assistant ClaudeEvent', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hello from codex' },
    })
    const ev = parseCodexEventLine(line)
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe('assistant')
    const msg = (ev as unknown as { message: { role: string; content: { type: string; text: string }[] } }).message
    expect(msg.role).toBe('assistant')
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0].type).toBe('text')
    expect(msg.content[0].text).toBe('hello from codex')
  })

  it('drops item.completed(reasoning) — returns null', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', text: 'internal chain-of-thought' },
    })
    expect(parseCodexEventLine(line)).toBeNull()
  })

  it('maps turn.completed (no error) to a result ClaudeEvent with is_error: false', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    const ev = parseCodexEventLine(line)
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe('result')
    expect((ev as unknown as { is_error: boolean }).is_error).toBe(false)
  })

  it('maps turn.completed (with error field) to a result ClaudeEvent with is_error: true', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      error: { message: 'something went wrong' },
    })
    const ev = parseCodexEventLine(line)
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe('result')
    expect((ev as unknown as { is_error: boolean }).is_error).toBe(true)
  })

  it('returns null for unrecognised event types', () => {
    expect(parseCodexEventLine(JSON.stringify({ type: 'unknown_event', data: 123 }))).toBeNull()
  })

  it('returns null for blank or non-JSON lines', () => {
    expect(parseCodexEventLine('')).toBeNull()
    expect(parseCodexEventLine('   ')).toBeNull()
    expect(parseCodexEventLine('not json')).toBeNull()
  })
})

describe('readCodexOutput', () => {
  it('reads an NDJSON event stream, skipping blank and trailing partial lines', () => {
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      '',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"actionable":true}' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
      '{"type":"item.completed"',
    ].join('\n')

    expect(readCodexOutput(output)).toEqual([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '{"actionable":true}' }],
        },
      },
      { type: 'result', is_error: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// Shared mock setup — simulates two codex JSONL events: one agent_message
// and one turn.completed.
// ---------------------------------------------------------------------------

const AGENT_MESSAGE_LINE = JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'task complete' },
})

const TURN_COMPLETED_LINE = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 42, output_tokens: 7 },
})

beforeEach(() => {
  vi.mocked(runSubprocessStreaming).mockImplementation(
    async (
      _cmd: string,
      _args: readonly string[],
      _cwd: string,
      onLine?: (event: { stream: 'stdout' | 'stderr'; line: string }) => void | Promise<void>,
    ) => {
      if (onLine) {
        await onLine({ stream: 'stdout', line: AGENT_MESSAGE_LINE })
        await onLine({ stream: 'stdout', line: TURN_COMPLETED_LINE })
        // A stderr line should be ignored by the adapter's stream guard
        await onLine({ stream: 'stderr', line: '{"type":"item.completed","item":{"type":"agent_message","text":"should be ignored"}}' })
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  )
  vi.mocked(resolveClaudeBin).mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Acceptance criterion (a): argv uses ephemeral codex exec JSON mode, no -p flag
// ---------------------------------------------------------------------------

describe('codexHeadless.run — (a) argv shape', () => {
  it("starts with ['exec', '--ephemeral', '--json', '--model', <model>]", async () => {
    await codexHeadless.run('build the feature', { cwd: '/tmp', model: 'o4-mini', effort: 'high' })

    const callArgs = vi.mocked(runSubprocessStreaming).mock.calls[0]
    const argv = callArgs[1] as readonly string[]

    expect(argv[0]).toBe('exec')
    expect(argv[1]).toBe('--ephemeral')
    expect(argv[2]).toBe('--json')
    expect(argv[3]).toBe('--model')
    expect(argv[4]).toBe('o4-mini')
  })

  it('does not contain the -p flag anywhere in argv', async () => {
    await codexHeadless.run('build the feature', { cwd: '/tmp', model: 'o4-mini', effort: 'high' })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    expect(argv).not.toContain('-p')
  })

  it('includes --sandbox workspace-write in argv', async () => {
    await codexHeadless.run('build the feature', { cwd: '/tmp', model: 'o4-mini', effort: 'high' })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    const sandboxIdx = argv.indexOf('--sandbox')
    expect(sandboxIdx).toBeGreaterThan(-1)
    expect(argv[sandboxIdx + 1]).toBe('workspace-write')
  })

  it('uses a read-only sandbox for read-only Workers', async () => {
    await codexHeadless.run('inspect only', {
      cwd: '/tmp',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    const sandboxIdx = argv.indexOf('--sandbox')
    expect(argv[sandboxIdx + 1]).toBe('read-only')
  })

  it('appends the prompt as the final argv entry', async () => {
    const prompt = 'implement the codex adapter'
    await codexHeadless.run(prompt, { cwd: '/tmp', model: 'o4-mini' })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    expect(argv[argv.length - 1]).toBe(prompt)
  })

  it('prepends the resolved system instructions to the submitted prompt', async () => {
    await codexHeadless.run('do the task', {
      cwd: '/tmp',
      systemPrompt: 'Use the code graph first.',
    })

    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    expect(argv.at(-1)).toContain('<mars_system_instructions>')
    expect(argv.at(-1)).toContain('Use the code graph first.')
    expect(argv.at(-1)).toContain('do the task')
  })

  it("defaults to the current flagship Codex model when no model is supplied", async () => {
    await codexHeadless.run('task', { cwd: '/tmp' })
    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    const modelIdx = argv.indexOf('--model')
    expect(argv[modelIdx + 1]).toBe('gpt-5.6-sol')
  })

  it('uses opts.effort in the -c flag, defaulting to "high"', async () => {
    await codexHeadless.run('task', { cwd: '/tmp', model: 'o4-mini', effort: 'low' })
    const argv = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    const cIdx = argv.indexOf('-c')
    expect(cIdx).toBeGreaterThan(-1)
    expect(argv[cIdx + 1]).toBe('model_reasoning_effort="low"')

    vi.clearAllMocks()
    vi.mocked(runSubprocessStreaming).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

    await codexHeadless.run('task', { cwd: '/tmp' })
    const argv2 = vi.mocked(runSubprocessStreaming).mock.calls[0][1] as readonly string[]
    const cIdx2 = argv2.indexOf('-c')
    expect(argv2[cIdx2 + 1]).toBe('model_reasoning_effort="high"')
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion (b): resolveClaudeBin is NOT called
// ---------------------------------------------------------------------------

describe('codexHeadless.run — (b) resolveClaudeBin not called', () => {
  it('does not invoke resolveClaudeBin during a codex headless run', async () => {
    await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.5' })
    expect(vi.mocked(resolveClaudeBin)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion (c): JSONL lines normalised and forwarded to onEvent
// ---------------------------------------------------------------------------

describe('codexHeadless.run — (c) JSONL normalisation and onEvent forwarding', () => {
  it('forwards only stdout lines (not stderr) through parseCodexEventLine to onEvent', async () => {
    const received: ClaudeEvent[] = []
    await codexHeadless.run('task', {
      cwd: '/tmp',
      model: 'gpt-5.5',
      onEvent: (ev) => { received.push(ev) },
    })

    // Only the two stdout lines should produce events (the stderr line is dropped)
    expect(received).toHaveLength(2)
    expect(received[0].type).toBe('assistant')
    expect(received[1].type).toBe('result')
  })

  it('normalises agent_message to assistant event with the correct text', async () => {
    const received: ClaudeEvent[] = []
    await codexHeadless.run('task', {
      cwd: '/tmp',
      model: 'gpt-5.5',
      onEvent: (ev) => { received.push(ev) },
    })

    const assistantEv = received[0] as unknown as {
      type: string
      message: { role: string; content: Array<{ type: string; text: string }> }
    }
    expect(assistantEv.message.role).toBe('assistant')
    expect(assistantEv.message.content[0].text).toBe('task complete')
  })

  it('normalises turn.completed to result event with is_error: false', async () => {
    const received: ClaudeEvent[] = []
    await codexHeadless.run('task', {
      cwd: '/tmp',
      model: 'gpt-5.5',
      onEvent: (ev) => { received.push(ev) },
    })

    const resultEv = received[1] as unknown as { type: string; is_error: boolean }
    expect(resultEv.is_error).toBe(false)
  })

  it('conversation in the returned result matches events forwarded to onEvent', async () => {
    const fromHook: ClaudeEvent[] = []
    const result = await codexHeadless.run('task', {
      cwd: '/tmp',
      model: 'gpt-5.5',
      onEvent: (ev) => { fromHook.push(ev) },
    })

    expect(result.conversation).toHaveLength(fromHook.length)
    for (let i = 0; i < fromHook.length; i++) {
      expect(result.conversation[i].type).toBe(fromHook[i].type)
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion (d): result has sessionId: null and quotaRejected: null
// ---------------------------------------------------------------------------

describe('codexHeadless.run — (d) null signals', () => {
  it('returns sessionId: null', async () => {
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.5' })
    expect(result.sessionId).toBeNull()
  })

  it('returns quotaRejected: null', async () => {
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.5' })
    expect(result.quotaRejected).toBeNull()
  })

  it('passes through exitCode from the subprocess result', async () => {
    vi.mocked(runSubprocessStreaming).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'oops' })
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.5' })
    expect(result.exitCode).toBe(1)
  })

  it('does not treat terminal cumulative usage as a live context measurement', async () => {
    const result = await codexHeadless.run('task', {
      cwd: '/tmp',
      model: 'gpt-5.5',
      maxContextTokens: 40,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain('context budget exhausted')
  })
})

// ---------------------------------------------------------------------------
// capabilities descriptor
// ---------------------------------------------------------------------------

describe('codexHeadless capabilities', () => {
  it("exposes usageSemantics: 'cumulative', a quota-rejection signal, and no session id", () => {
    const { capabilities } = codexHeadless
    // Codex reports usage ONCE, on turn.completed, as total spend for the
    // turn. Declaring it 'cumulative' is what stops the orchestrator reading
    // that number as context occupancy.
    expect(capabilities.usageSemantics).toBe('cumulative')
    // Codex DOES report rate/spend rejections — as an error/turn.failed pair
    // on stdout. The adapter recovers them into RunClaudeResult.quotaRejected.
    expect(capabilities.quotaRejected).toBe(true)
    expect(capabilities.sessionId).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Regression: provider refusal must not vanish.
//
// Incident: codex hit its ChatGPT usage limit and emitted
//   {"type":"error","message":"You've hit your usage limit. … try again at …"}
//   {"type":"turn.failed","error":{"message":"…"}}
// on STDOUT, exiting 1 with nothing on stderr but the benign
// "Reading additional input from stdin..." notice it prints on every run whose
// stdin is not a TTY. The adapter dropped both lines, so `conversation` was
// empty and `quotaRejected` was hardcoded null — the task failed as
// `code/unclassified` with the stdin notice as its only evidence and churned
// in a 30-second requeue loop.
// ---------------------------------------------------------------------------

describe('parseCodexEventLine — provider refusal events', () => {
  it('maps a top-level error event to an error result carrying the message', () => {
    const ev = parseCodexEventLine(
      JSON.stringify({ type: 'error', message: "You've hit your usage limit." }),
    )
    expect(ev?.type).toBe('result')
    expect((ev as unknown as { is_error: boolean }).is_error).toBe(true)
    expect((ev as unknown as { result: string }).result).toBe("You've hit your usage limit.")
  })

  it('maps turn.failed to an error result, unwrapping the nested error.message', () => {
    const ev = parseCodexEventLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'model refused the request' } }),
    )
    expect(ev?.type).toBe('result')
    expect((ev as unknown as { is_error: boolean }).is_error).toBe(true)
    expect((ev as unknown as { result: string }).result).toBe('model refused the request')
  })

  it('drops a refusal envelope that carries no message text', () => {
    expect(parseCodexEventLine(JSON.stringify({ type: 'turn.failed' }))).toBeNull()
  })
})

describe('codexHeadless.run — quota rejection is surfaced, not swallowed', () => {
  const QUOTA_MESSAGE =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 6th, 2026 11:58 PM."

  const mockQuotaRun = (): void => {
    vi.mocked(runSubprocessStreaming).mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine?: (event: { stream: 'stdout' | 'stderr'; line: string }) => void | Promise<void>,
      ) => {
        if (onLine) {
          await onLine({ stream: 'stdout', line: JSON.stringify({ type: 'thread.started', thread_id: 't' }) })
          await onLine({ stream: 'stdout', line: JSON.stringify({ type: 'turn.started' }) })
          await onLine({ stream: 'stdout', line: JSON.stringify({ type: 'error', message: QUOTA_MESSAGE }) })
          await onLine({ stream: 'stdout', line: JSON.stringify({ type: 'turn.failed', error: { message: QUOTA_MESSAGE } }) })
        }
        return {
          exitCode: 1,
          stdout: '',
          // Exactly what codex leaves on stderr for this failure.
          stderr: 'Reading additional input from stdin...\n',
        }
      },
    )
  }

  it('returns a non-null quotaRejected sentinel so the code step re-queues instead of failing', async () => {
    mockQuotaRun()
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.6-sol' })

    expect(result.exitCode).toBe(1)
    expect(result.quotaRejected).not.toBeNull()
  })

  it('parses the reset point out of codex prose into a Unix-second timestamp', async () => {
    mockQuotaRun()
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.6-sol' })

    const resetsAt = result.quotaRejected?.resetsAt ?? 0
    expect(resetsAt).toBeGreaterThan(0)
    expect(new Date(resetsAt * 1000).getUTCFullYear()).toBe(2026)
  })

  it('keeps the refusal text in the conversation so the failure is diagnosable', async () => {
    mockQuotaRun()
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.6-sol' })

    const texts = result.conversation
      .filter((e) => e.type === 'result')
      .map((e) => (e as unknown as { result?: string }).result)
    expect(texts.some((t) => typeof t === 'string' && t.includes('usage limit'))).toBe(true)
  })

  it("strips codex's benign stdin notice so it cannot masquerade as the failure diagnostic", async () => {
    mockQuotaRun()
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.6-sol' })

    // The code step picks "stderr tail if non-empty, else last stream text".
    // Leaving the notice in stderr is what made the real cause invisible.
    expect(result.stderr.trim()).toBe('')

    const stderrTail = result.stderr.trim().slice(-1000)
    const diagText =
      stderrTail.length > 0
        ? `stderr tail:\n${stderrTail}`
        : `stderr empty; last stream text:\n${extractLastStreamText(result.conversation)}`
    expect(diagText).toContain('usage limit')
    expect(diagText).not.toContain('Reading additional input from stdin')
  })

  it('classifies the composed coder-exit output as provider-quota, not unclassified', async () => {
    mockQuotaRun()
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.6-sol' })

    // Mirrors coderExitOutput in workflows/primitives/index.ts.
    const coderExitOutput = `coder process exited 1. worktree was clean at exit (no uncommitted work found). stderr empty; last stream text:\n${extractLastStreamText(result.conversation)}`
    expect(computeFailureSignature('code:coder-exit-nonzero', coderExitOutput)).toBe(
      'code:coder-exit-nonzero/provider-quota',
    )
  })

  it('preserves genuine stderr content while dropping only the notice', () => {
    expect(
      stripBenignCodexStderr('Reading additional input from stdin...\nreal explosion here\n'),
    ).toContain('real explosion here')
    expect(
      stripBenignCodexStderr('Reading additional input from stdin...\nreal explosion here\n'),
    ).not.toContain('Reading additional input')
    expect(stripBenignCodexStderr('Reading additional input from stdin...\n')).toBe('')
  })

  it('leaves quotaRejected null when the run failed for a non-quota reason', async () => {
    vi.mocked(runSubprocessStreaming).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'some other explosion',
    })
    const result = await codexHeadless.run('task', { cwd: '/tmp', model: 'gpt-5.6-sol' })
    expect(result.quotaRejected).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Regression: an empty prompt must never reach the CLI.
//
// `codex exec` with no prompt argument reads the prompt from stdin. Dispatched
// workers get stdin=/dev/null, so it reads EOF and exits 1 with no usable
// diagnostic — the same contentless failure shape as the quota incident above.
// ---------------------------------------------------------------------------

describe('codexHeadless.run — empty prompt fails fast without spawning', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
  ])('refuses to spawn for a %s prompt', async (_label, prompt) => {
    const result = await codexHeadless.run(prompt, { cwd: '/tmp', model: 'gpt-5.6-sol' })

    expect(runSubprocessStreaming).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/refusing to spawn codex with an empty prompt/i)
    expect(result.conversation).toEqual([])
  })

  it('classifies the refusal as empty-prompt rather than unclassified', async () => {
    const result = await codexHeadless.run('', { cwd: '/tmp', model: 'gpt-5.6-sol' })
    expect(computeFailureSignature('code:coder-exit-nonzero', result.stderr)).toBe(
      'code:coder-exit-nonzero/empty-prompt',
    )
  })

  it('still spawns when only the systemPrompt is blank but the prompt is real', async () => {
    await codexHeadless.run('do the thing', {
      cwd: '/tmp',
      model: 'gpt-5.6-sol',
      systemPrompt: '   ',
    })
    expect(runSubprocessStreaming).toHaveBeenCalled()
  })
})
