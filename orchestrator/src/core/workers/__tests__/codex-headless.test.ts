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
vi.mock('../../lib/git/claude', () => ({
  runSubprocessStreaming: vi.fn(),
  buildWorkerEnv: vi.fn(() => ({})),
  resolveClaudeBin: vi.fn(),
}))

import { parseCodexEventLine, codexHeadless } from '../providers/codex-headless'
import { runSubprocessStreaming, resolveClaudeBin } from '../../lib/git/claude'

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
})

// ---------------------------------------------------------------------------
// capabilities descriptor
// ---------------------------------------------------------------------------

describe('codexHeadless capabilities', () => {
  it('exposes contextTokenMetering: false, quotaRejected: false, sessionId: false', () => {
    const { capabilities } = codexHeadless
    expect(capabilities.contextTokenMetering).toBe(false)
    expect(capabilities.quotaRejected).toBe(false)
    expect(capabilities.sessionId).toBe(false)
  })
})
