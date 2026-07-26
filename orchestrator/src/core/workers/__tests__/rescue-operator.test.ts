/**
 * Tests for the rescue-operator Worker and runRescueOperator function.
 *
 * Covers:
 * - System prompt content (exactly 3 actions listed, all others forbidden)
 * - Tool surface registration (WORKER_CONFIGS.RescueOperator, tag routing)
 * - Verdict parsing (restart / continue / supersede)
 * - Integration: fake failed Arc drives through runRescueOperator and
 *   exactly one of the three actions fires.
 */

import { describe, expect, it } from 'vitest'
import {
  RESCUE_OPERATOR_SYSTEM_PROMPT,
  RESCUE_OPERATOR_DENIED_TOOLS,
  buildRescueOperatorPrompt,
  parseRescueVerdict,
  runRescueOperator,
  type RescueVerdict,
} from '../rescue-operator'
import {
  WORKER_CONFIGS,
  Workers,
  pickWorkerForTags,
  type Worker,
  type WorkerName,
} from '..'
import type { Task } from '../../queue'
import type { RunClaudeResult } from '../../lib/git/claude'
import type { ClaudeEvent } from '../../lib/claude-stream'

// ---------------------------------------------------------------------------
// Helper: build a minimal mock Worker that emits a fixed assistant-message
// event then returns a clean RunClaudeResult.
// ---------------------------------------------------------------------------
const makeAssistantEvent = (text: string): ClaudeEvent => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
  },
})

const makeWorkerStub = (
  agentOutput: string,
  exitCode = 0,
): Worker => ({
  config: WORKER_CONFIGS.RescueOperator,
  runtime: 'headless',
  run: async (_prompt, options): Promise<RunClaudeResult> => {
    if (options.onEvent) {
      await options.onEvent(makeAssistantEvent(agentOutput))
    }
    return {
      exitCode,
      stdout: agentOutput,
      stderr: '',
      sessionId: 'rescue-session-test',
      conversation: [],
      quotaRejected: null,
    }
  },
})

// Minimal fake Task as received by runRescueOperator
const fakeTask = (overrides?: Partial<Pick<Task, 'id' | 'prompt' | 'worktreePath'>>): Pick<Task, 'id' | 'prompt' | 'worktreePath'> => ({
  id: 'mars-rescue-test-01',
  prompt: buildRescueOperatorPrompt('mars-origin-01', 'mars-origin-01', 'verify:typecheck'),
  worktreePath: '/tmp/fake-worktree',
  ...overrides,
})

// ---------------------------------------------------------------------------
// System prompt content
// ---------------------------------------------------------------------------

describe('RESCUE_OPERATOR_SYSTEM_PROMPT', () => {
  it('lists restart as a permitted action', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/\brestart\b/i)
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('mars restart')
  })

  it('lists continue as a permitted action', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/\bcontinue\b/i)
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('mars step continue')
  })

  it('lists supersede as a permitted action', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/\bsupersede\b/i)
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('mars task add --supersede')
  })

  it('explicitly forbids mars task add without --supersede', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/Do NOT run `mars task add` without the `--supersede` flag/)
  })

  it('explicitly forbids spawning additional rescue or recovery tasks', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/Do NOT spawn additional rescue/i)
  })

  it('explicitly forbids mars proposal and mars draft commands', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('mars proposal')
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('mars draft')
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/Do NOT run.*mars proposal/i)
  })

  it('instructs the agent to emit a JSON verdict as the last line', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/JSON verdict/)
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('"action":"restart"')
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('"action":"continue"')
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toContain('"action":"supersede"')
  })
})

// ---------------------------------------------------------------------------
// Worker config registration
// ---------------------------------------------------------------------------

describe('WORKER_CONFIGS.RescueOperator', () => {
  it('is registered in WORKER_CONFIGS', () => {
    const cfg = WORKER_CONFIGS.RescueOperator
    expect(cfg).toBeDefined()
    expect(cfg.name).toBe('RescueOperator')
  })

  it('carries the rescue-operator tag for pickWorkerForTags routing', () => {
    expect(WORKER_CONFIGS.RescueOperator.tags).toContain('rescue-operator')
  })

  it('pins the system prompt (not appendSystemPrompt)', () => {
    expect(WORKER_CONFIGS.RescueOperator.systemPrompt).toBe(RESCUE_OPERATOR_SYSTEM_PROMPT)
    expect(WORKER_CONFIGS.RescueOperator.appendSystemPrompt).toBeUndefined()
  })

  it('uses bypassPermissions so it can run mars CLI commands headlessly', () => {
    expect(WORKER_CONFIGS.RescueOperator.permissionMode).toBe('bypassPermissions')
  })

  it('runs on Sonnet with high effort (same posture as Fixer)', () => {
    expect(WORKER_CONFIGS.RescueOperator.model).toBe('claude-sonnet-4-6')
    expect(WORKER_CONFIGS.RescueOperator.effort).toBe('high')
  })

  it('uses headless runtime', () => {
    expect(WORKER_CONFIGS.RescueOperator.runtime).toBe('headless')
    expect(Workers.RescueOperator.runtime).toBe('headless')
  })

  it('denies the backlog-mutation tools from RESCUE_OPERATOR_DENIED_TOOLS', () => {
    for (const denied of RESCUE_OPERATOR_DENIED_TOOLS) {
      expect(WORKER_CONFIGS.RescueOperator.disallowedTools).toContain(denied)
    }
  })

  it('does NOT deny Edit or Write — the agent needs full worktree access to inspect the branch', () => {
    expect(WORKER_CONFIGS.RescueOperator.disallowedTools).not.toContain('Edit')
    expect(WORKER_CONFIGS.RescueOperator.disallowedTools).not.toContain('Write')
  })
})

describe('pickWorkerForTags — rescue-operator routing', () => {
  it('routes tasks tagged "rescue-operator" to Workers.RescueOperator', () => {
    const picked = pickWorkerForTags(['rescue-operator'], Workers)
    expect(picked).toBe(Workers.RescueOperator)
  })

  it('RescueOperator is exposed on the Workers map', () => {
    expect(Workers.RescueOperator).toBeDefined()
    expect(Workers.RescueOperator.config.name).toBe('RescueOperator')
  })
})

// ---------------------------------------------------------------------------
// buildRescueOperatorPrompt
// ---------------------------------------------------------------------------

describe('buildRescueOperatorPrompt', () => {
  it('embeds the failed task id, origin id, and failure signature', () => {
    const prompt = buildRescueOperatorPrompt('mars-failed-01', 'mars-origin-01', 'verify:typecheck')
    expect(prompt).toContain('mars-failed-01')
    expect(prompt).toContain('mars-origin-01')
    expect(prompt).toContain('verify:typecheck')
  })

  it('mentions the three permitted actions', () => {
    const prompt = buildRescueOperatorPrompt('id', 'oid', 'sig')
    expect(prompt).toMatch(/restart|continue|supersede/i)
  })
})

// ---------------------------------------------------------------------------
// parseRescueVerdict
// ---------------------------------------------------------------------------

describe('parseRescueVerdict', () => {
  it('parses a restart verdict from the last JSON line', () => {
    const text = 'Analysing the worktree...\n{"action":"restart","reasoning":"transient failure"}'
    const verdict = parseRescueVerdict(text)
    expect(verdict).not.toBeNull()
    expect(verdict!.action).toBe('restart')
    expect(verdict!.reasoning).toBe('transient failure')
  })

  it('parses a continue verdict', () => {
    const text = 'Found partial work.\n{"action":"continue","reasoning":"salvageable diff"}'
    const verdict = parseRescueVerdict(text)
    expect(verdict).not.toBeNull()
    expect(verdict!.action).toBe('continue')
  })

  it('parses a supersede verdict with supersedePrompt', () => {
    const text =
      'The original prompt was wrong.\n' +
      '{"action":"supersede","reasoning":"wrong approach","supersedePrompt":"Fix the actual bug"}'
    const verdict = parseRescueVerdict(text)
    expect(verdict).not.toBeNull()
    expect(verdict!.action).toBe('supersede')
    expect(verdict!.supersedePrompt).toBe('Fix the actual bug')
  })

  it('picks the LAST JSON block when multiple appear in the output', () => {
    const text =
      '{"action":"restart","reasoning":"first attempt"}\n' +
      'some more output\n' +
      '{"action":"continue","reasoning":"final decision"}'
    const verdict = parseRescueVerdict(text)
    expect(verdict!.action).toBe('continue')
  })

  it('ignores JSON objects that lack a valid action field', () => {
    const text = '{"foo":"bar"}\n{"action":"restart","reasoning":"ok"}'
    const verdict = parseRescueVerdict(text)
    expect(verdict!.action).toBe('restart')
  })

  it('returns null when no verdict JSON is present', () => {
    expect(parseRescueVerdict('No JSON here at all')).toBeNull()
    expect(parseRescueVerdict('')).toBeNull()
  })

  it('returns null for JSON with an invalid action value', () => {
    expect(parseRescueVerdict('{"action":"explode","reasoning":"bad"}')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runRescueOperator — integration
// ---------------------------------------------------------------------------

describe('runRescueOperator — integration', () => {
  it('drives a fake failed Arc through the operator and returns a restart verdict', async () => {
    const agentOutput = 'Inspecting the worktree...\n{"action":"restart","reasoning":"transient env failure"}'
    const worker = makeWorkerStub(agentOutput)
    const verdict = await runRescueOperator(fakeTask(), { worker })
    expect(verdict.action).toBe('restart')
    expect(verdict.reasoning).toBe('transient env failure')
  })

  it('drives a fake failed Arc through the operator and returns a continue verdict', async () => {
    const agentOutput = 'Found partial commits.\n{"action":"continue","reasoning":"has useful work"}'
    const worker = makeWorkerStub(agentOutput)
    const verdict = await runRescueOperator(fakeTask(), { worker })
    expect(verdict.action).toBe('continue')
  })

  it('drives a fake failed Arc through the operator and returns a supersede verdict', async () => {
    const agentOutput =
      'The task prompt was wrong.\n' +
      '{"action":"supersede","reasoning":"wrong prompt","supersedePrompt":"Fix the real bug in auth.ts"}'
    const worker = makeWorkerStub(agentOutput)
    const verdict = await runRescueOperator(fakeTask(), { worker })
    expect(verdict.action).toBe('supersede')
    expect(verdict.supersedePrompt).toBe('Fix the real bug in auth.ts')
  })

  it('asserts exactly one of the three actions fires (not multiple, not zero)', async () => {
    const validActions: Array<RescueVerdict['action']> = ['restart', 'continue', 'supersede']
    const agentOutputs = [
      '{"action":"restart","reasoning":"r1"}',
      '{"action":"continue","reasoning":"r2"}',
      '{"action":"supersede","reasoning":"r3","supersedePrompt":"new"}',
    ]
    for (const output of agentOutputs) {
      const worker = makeWorkerStub(output)
      const verdict = await runRescueOperator(fakeTask(), { worker })
      expect(validActions).toContain(verdict.action)
    }
  })

  it('falls back to stdout when onEvent carries no text content', async () => {
    // Worker that emits no assistant events but puts verdict in stdout
    const worker: Worker = {
      config: WORKER_CONFIGS.RescueOperator,
      runtime: 'headless',
      run: async (): Promise<RunClaudeResult> => ({
        exitCode: 0,
        stdout: '{"action":"restart","reasoning":"from stdout"}',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      }),
    }
    const verdict = await runRescueOperator(fakeTask(), { worker })
    expect(verdict.action).toBe('restart')
    expect(verdict.reasoning).toBe('from stdout')
  })

  it('throws when the agent emits no valid verdict JSON', async () => {
    const worker = makeWorkerStub('No JSON verdict at all', 1)
    await expect(runRescueOperator(fakeTask(), { worker })).rejects.toThrow(
      /rescue-operator.*did not emit a valid RescueVerdict JSON/,
    )
  })

  it('uses task.worktreePath as default cwd when options.cwd is not provided', async () => {
    let capturedCwd: string | undefined
    const worker: Worker = {
      config: WORKER_CONFIGS.RescueOperator,
      runtime: 'headless',
      run: async (_prompt, options): Promise<RunClaudeResult> => {
        capturedCwd = options.cwd
        if (options.onEvent) {
          await options.onEvent(makeAssistantEvent('{"action":"restart","reasoning":"ok"}'))
        }
        return { exitCode: 0, stdout: '', stderr: '', sessionId: null, conversation: [], quotaRejected: null }
      },
    }
    await runRescueOperator(
      { id: 'x', prompt: 'p', worktreePath: '/specific/path' },
      { worker },
    )
    expect(capturedCwd).toBe('/specific/path')
  })

  it('uses options.cwd when explicitly provided, overriding task.worktreePath', async () => {
    let capturedCwd: string | undefined
    const worker: Worker = {
      config: WORKER_CONFIGS.RescueOperator,
      runtime: 'headless',
      run: async (_prompt, options): Promise<RunClaudeResult> => {
        capturedCwd = options.cwd
        if (options.onEvent) {
          await options.onEvent(makeAssistantEvent('{"action":"restart","reasoning":"ok"}'))
        }
        return { exitCode: 0, stdout: '', stderr: '', sessionId: null, conversation: [], quotaRejected: null }
      },
    }
    await runRescueOperator(
      { id: 'x', prompt: 'p', worktreePath: '/task/path' },
      { worker, cwd: '/override/path' },
    )
    expect(capturedCwd).toBe('/override/path')
  })
})

// ---------------------------------------------------------------------------
// Audit: rescue-operator cannot spawn another rescue-operator
// (behavioural contract — the arc_rescue_attempts guard is in
//  rescue-operator-spawn.ts; here we verify the Worker config does not
//  carry tags or tool-surface that would let it enqueue one)
// ---------------------------------------------------------------------------

describe('rescue-operator cannot spawn a rescue-operator sibling (tool surface)', () => {
  it('system prompt explicitly forbids spawning additional rescue tasks', () => {
    expect(RESCUE_OPERATOR_SYSTEM_PROMPT).toMatch(/Do NOT spawn additional rescue/i)
  })

  it('denied tools block mars proposal and mars draft backlog mutations', () => {
    expect(RESCUE_OPERATOR_DENIED_TOOLS).toContain('Bash(mars proposal*)')
    expect(RESCUE_OPERATOR_DENIED_TOOLS).toContain('Bash(mars draft*)')
  })
})
