import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeStreamArgs } from '../../lib/git'
import {
  CODER_MODEL,
  DEFAULT_MAX_MESSAGES,
  FIXER_BACKLOG_DENIED_TOOLS,
  READ_ONLY_DENIED_TOOLS,
  WORKER_CONFIGS,
  Workers,
  createWorker,
  getWorker,
  getWorkerForTag,
  resolveWorkerMaxMessages,
  type WorkerConfig,
  type WorkerName,
  type WorkerRuntime,
} from '..'
import { pickWorkerForTask } from '../../workflows/implement-workflow'
import type { Task } from '../../queue'

// Resolve the argv `claude -p` would receive for a given Worker. Behaviour
// test against the public registry rather than reaching into the run()
// implementation — Slice 4 wires stage call sites onto Workers separately,
// and this test must survive that refactor.
const argvFor = (name: WorkerName): readonly string[] => {
  const cfg = WORKER_CONFIGS[name]
  return claudeStreamArgs('prompt', {
    model: cfg.model,
    effort: cfg.effort,
    permissionMode: cfg.permissionMode,
    bare: cfg.bare,
    disallowedTools: cfg.disallowedTools,
  })
}

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  return args[i + 1]
}

describe('Worker runtime field', () => {
  // Tracer bullet: every Worker in the pre-built registry carries runtime: 'headless'.
  // No dispatch logic branches on it yet — this test only asserts the field is present
  // and carries the expected value.
  it('every pre-built Worker exposes runtime === "headless"', () => {
    const allRoles: ReadonlyArray<WorkerName> = [
      'Coder',
      'Planner',
      'Slicer',
      'Triager',
      'Fixer',
    ]
    for (const name of allRoles) {
      const worker = Workers[name]
      const runtime: WorkerRuntime = worker.runtime
      expect(runtime, `${name}.runtime`).toBe('headless')
    }
  })

  it('WORKER_CONFIGS entries carry runtime: "headless"', () => {
    for (const name of Object.keys(WORKER_CONFIGS) as WorkerName[]) {
      expect(WORKER_CONFIGS[name].runtime, `${name} config.runtime`).toBe('headless')
    }
  })

  it('createWorker plumbs runtime through to the resulting Worker', () => {
    const cfg: WorkerConfig = {
      name: 'Coder',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      defaultTimeoutMs: 1000,
      maxMessages: 0,
      runtime: 'headless',
    }
    expect(createWorker(cfg).runtime).toBe('headless')
  })
})

describe('Worker registry', () => {
  it('exposes Coder, Planner, Slicer, Triager, and Fixer as named Workers — Writer is absent (ADR 0019)', () => {
    expect(Workers.Coder).toBeDefined()
    expect(Workers.Planner).toBeDefined()
    expect(Workers.Slicer).toBeDefined()
    expect(Workers.Triager).toBeDefined()
    expect(Workers.Fixer).toBeDefined()
    // The structured-write Writer Worker was removed by ADR 0019.
    expect('Writer' in Workers).toBe(false)
  })

  it('returns the same instance from getWorker(name)', () => {
    expect(getWorker('Coder')).toBe(Workers.Coder)
    expect(getWorker('Fixer')).toBe(Workers.Fixer)
  })

  it("pins Triager's message cap at 40 (tighter than the unbounded default)", () => {
    expect(WORKER_CONFIGS.Triager.maxMessages).toBe(40)
    // Coder runs uncapped (0 = unbounded) so it can explore + implement +
    // commit without being cut off mid-run.
    expect(WORKER_CONFIGS.Coder.maxMessages).toBe(0)
  })

  it("pins Slicer's message cap at 250 so it can finish orienting before emitting slice JSON", () => {
    // The Slicer is a read-heavy, one-shot analysis pass. Before the 250 cap
    // was introduced it was SIGKILLed at ~100 messages before emitting the
    // slice JSON output. 250 gives ~4x headroom while keeping a hard ceiling
    // so a looping slicer can't burn unbounded tokens.
    expect(WORKER_CONFIGS.Slicer.maxMessages).toBe(250)
  })
})

describe('Coder pinned config', () => {
  const args = argvFor('Coder')

  it('runs on CODER_MODEL (sonnet by default) with high effort, bypassPermissions, and no read-only denials', () => {
    // CODER_MODEL resolves process.env.MARS_WORKER_MODEL ?? 'claude-sonnet-4-6'.
    // This assertion adapts to the test environment so it passes whether or not
    // MARS_WORKER_MODEL is set (e.g. in CI overrides).
    expect(valueAfter(args, '--model')).toBe(CODER_MODEL)
    expect(valueAfter(args, '--effort')).toBe('high')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--bare')
    const denied = (valueAfter(args, '--disallowedTools') ?? '').split(',')
    expect(denied).not.toContain('Edit')
    expect(denied).not.toContain('Write')
    expect(denied).not.toContain('NotebookEdit')
  })
})

describe('Planner / Slicer / Triager pinned config', () => {
  const readOnlyRoles: ReadonlyArray<WorkerName> = ['Planner', 'Slicer', 'Triager']

  for (const name of readOnlyRoles) {
    it(`${name}: runs with --permission-mode default and denies Edit/Write/NotebookEdit at the Worker layer`, () => {
      const args = argvFor(name)
      expect(valueAfter(args, '--permission-mode')).toBe('default')
      expect(args).not.toContain('--dangerously-skip-permissions')
      expect(args).not.toContain('--bare')
      const denied = (valueAfter(args, '--disallowedTools') ?? '').split(',')
      for (const tool of READ_ONLY_DENIED_TOOLS) {
        expect(denied).toContain(tool)
      }
    })
  }

  it('Planner and Slicer pin opus on high effort; Triager pins sonnet on medium effort', () => {
    expect(WORKER_CONFIGS.Planner.model).toBe('claude-opus-4-7')
    expect(WORKER_CONFIGS.Planner.effort).toBe('high')
    expect(WORKER_CONFIGS.Slicer.model).toBe('claude-opus-4-7')
    expect(WORKER_CONFIGS.Slicer.effort).toBe('high')
    expect(WORKER_CONFIGS.Triager.model).toBe('claude-sonnet-4-6')
    expect(WORKER_CONFIGS.Triager.effort).toBe('medium')
  })

  it('pins per-Worker defaultTimeoutMs so call sites do not need to override', () => {
    // Call sites for Planner/Slicer/Triager (slice 4 migration) drop their
    // local timeoutMs and rely on these registry defaults. Changing these
    // numbers changes stage timeouts; this test names the contract.
    expect(WORKER_CONFIGS.Planner.defaultTimeoutMs).toBe(5 * 60 * 1000)
    expect(WORKER_CONFIGS.Slicer.defaultTimeoutMs).toBe(5 * 60 * 1000)
    expect(WORKER_CONFIGS.Triager.defaultTimeoutMs).toBe(2 * 60 * 1000)
  })
})

describe('Fixer pinned config', () => {
  const args = argvFor('Fixer')

  it('runs Opus on high effort with bypassPermissions (intentionally Opus — recovery resilience over cost)', () => {
    // Fixer intentionally stays on Opus even though Coder uses Sonnet.
    // Recovery tasks deal with broken/partially-applied code where extra
    // reasoning headroom pays off.
    expect(valueAfter(args, '--model')).toBe('claude-opus-4-7')
    expect(valueAfter(args, '--effort')).toBe('high')
    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('denies every Bash pattern that mutates the orchestrator backlog', () => {
    const denied = (valueAfter(args, '--disallowedTools') ?? '').split(',')
    for (const pattern of FIXER_BACKLOG_DENIED_TOOLS) {
      expect(denied).toContain(pattern)
    }
  })

  it('retains the full coding surface — does not deny Edit, Write, or NotebookEdit', () => {
    // Fixer needs to mutate the worktree to apply a fix. Unlike the read-only
    // synthesis Workers (Planner/Slicer/Triager), it must NOT have Edit, Write,
    // or NotebookEdit blocked. The only denials on Fixer are the backlog-
    // mutation guards (FIXER_BACKLOG_DENIED_TOOLS) and the wrapper-layer
    // agent-to-user ban.
    const denied = (valueAfter(args, '--disallowedTools') ?? '').split(',')
    expect(denied).not.toContain('Edit')
    expect(denied).not.toContain('Write')
    expect(denied).not.toContain('NotebookEdit')
  })
})

describe('MARS_WORKER_MODEL env var', () => {
  it('defaults Coder to sonnet when MARS_WORKER_MODEL is unset', () => {
    // CODER_MODEL is resolved at module-load time: process.env.MARS_WORKER_MODEL
    // ?? 'claude-sonnet-4-6'. This test verifies the resolved value matches the
    // env — either the override or the Sonnet default.
    const expected = process.env.MARS_WORKER_MODEL ?? 'claude-sonnet-4-6'
    expect(CODER_MODEL).toBe(expected)
  })

  it('Coder config carries the resolved CODER_MODEL so the env var takes effect', () => {
    expect(WORKER_CONFIGS.Coder.model).toBe(CODER_MODEL)
  })
})

// The Writer pinned config describe block was removed by ADR 0019.
// The Writer Worker no longer exists in the registry.

describe('getWorkerForTag', () => {
  it('routing seam exists and resolves "coder" to the Coder Worker', () => {
    // The classification-tag routing seam is preserved (ADR 0019 acceptance
    // criterion 5). 'coder' is the only valid tag and it resolves to Coder.
    expect(getWorkerForTag('coder')).toBe(Workers.Coder)
  })
})

describe('agent-to-user denial inheritance', () => {
  it('is present in every Worker on top of any per-Worker denial', () => {
    const allRoles: ReadonlyArray<WorkerName> = [
      'Coder',
      'Planner',
      'Slicer',
      'Triager',
      'Fixer',
    ]
    for (const name of allRoles) {
      const denied = (valueAfter(argvFor(name), '--disallowedTools') ?? '').split(',')
      expect(denied).toContain('AskUserQuestion')
      expect(denied).toContain('SendUserMessage')
    }
  })
})

describe('pickWorkerForTask', () => {
  it('routes fix tasks to Fixer', () => {
    expect(pickWorkerForTask({ kind: 'fix' } as Task)).toBe('Fixer')
  })

  it('routes task-kind tasks to Coder', () => {
    expect(pickWorkerForTask({ kind: 'task' } as Task)).toBe('Coder')
  })

  it('routes diagnose-kind tasks to Coder (diagnose is not a fix)', () => {
    expect(pickWorkerForTask({ kind: 'diagnose' } as Task)).toBe('Coder')
  })

  it('routes legacy rows with undefined kind to Coder', () => {
    expect(pickWorkerForTask({} as Task)).toBe('Coder')
  })
})

describe('audit surface — full role-pinned config exposed via WORKER_CONFIGS', () => {
  it('every Worker exposes the full dispatch-surface contract in one place', () => {
    // Operator-facing audit point: any shipped Worker can be inspected through
    // WORKER_CONFIGS without chasing call sites. Each entry MUST carry the
    // structural fields named in the PRD; optional fields may be undefined
    // when the role does not pin them, but they must be representable.
    const requiredKeys: ReadonlyArray<keyof WorkerConfig> = [
      'name',
      'model',
      'effort',
      'permissionMode',
      'bare',
      'disallowedTools',
      'outputFormat',
      'defaultTimeoutMs',
      'maxMessages',
      'runtime',
    ]
    for (const name of Object.keys(WORKER_CONFIGS) as WorkerName[]) {
      const cfg = WORKER_CONFIGS[name]
      for (const k of requiredKeys) {
        expect(cfg[k], `${name}.${k} must be defined`).toBeDefined()
      }
    }
  })

  it('every Worker pins outputFormat to stream-json (the only format the orchestrator parses)', () => {
    for (const name of Object.keys(WORKER_CONFIGS) as WorkerName[]) {
      expect(WORKER_CONFIGS[name].outputFormat).toBe('stream-json')
    }
  })
})

describe('systemPrompt / appendSystemPrompt mutual exclusion', () => {
  const baseConfig: WorkerConfig = {
    name: 'Coder',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'default',
    bare: false,
    disallowedTools: [],
    outputFormat: 'stream-json',
    defaultTimeoutMs: 1000,
    maxMessages: 100,
    runtime: 'headless',
  }

  it('createWorker throws when both systemPrompt and appendSystemPrompt are pinned', () => {
    // Behaviour: claude -p cannot honour both --system-prompt and
    // --append-system-prompt on the same invocation. The factory must fail
    // loudly at construction so the misconfiguration surfaces at module-load
    // (where the operator can fix it) rather than being silently dropped at
    // dispatch.
    expect(() =>
      createWorker({ ...baseConfig, systemPrompt: 'X', appendSystemPrompt: 'Y' }),
    ).toThrow(/mutually exclusive/i)
  })

  it('createWorker accepts a config with only systemPrompt set', () => {
    expect(() => createWorker({ ...baseConfig, systemPrompt: 'X' })).not.toThrow()
  })

  it('createWorker accepts a config with only appendSystemPrompt set', () => {
    expect(() => createWorker({ ...baseConfig, appendSystemPrompt: 'Y' })).not.toThrow()
  })

  it('createWorker accepts a config with neither system-prompt field set', () => {
    expect(() => createWorker(baseConfig)).not.toThrow()
  })

  it('shipped registry never pins both system-prompt fields on the same Worker', () => {
    for (const name of Object.keys(WORKER_CONFIGS) as WorkerName[]) {
      const c = WORKER_CONFIGS[name]
      const bothSet = c.systemPrompt !== undefined && c.appendSystemPrompt !== undefined
      expect(bothSet, `${name} pins both system-prompt fields`).toBe(false)
    }
  })
})

describe('resolveWorkerMaxMessages — explicit → env var → DEFAULT_MAX_MESSAGES', () => {
  const original = process.env.MARS_CLAUDE_MAX_MESSAGES
  beforeEach(() => {
    delete process.env.MARS_CLAUDE_MAX_MESSAGES
  })
  afterEach(() => {
    if (original === undefined) delete process.env.MARS_CLAUDE_MAX_MESSAGES
    else process.env.MARS_CLAUDE_MAX_MESSAGES = original
  })

  it('returns the explicit override when one is provided', () => {
    expect(resolveWorkerMaxMessages(42)).toBe(42)
  })

  it('falls back to MARS_CLAUDE_MAX_MESSAGES when no override is given', () => {
    process.env.MARS_CLAUDE_MAX_MESSAGES = '77'
    expect(resolveWorkerMaxMessages()).toBe(77)
  })

  it('falls back to DEFAULT_MAX_MESSAGES (0 = unbounded) when neither override nor env is set', () => {
    expect(resolveWorkerMaxMessages()).toBe(DEFAULT_MAX_MESSAGES)
    expect(DEFAULT_MAX_MESSAGES).toBe(0)
  })

  it('ignores non-integer env values and falls back to the default', () => {
    process.env.MARS_CLAUDE_MAX_MESSAGES = 'notanumber'
    expect(resolveWorkerMaxMessages()).toBe(DEFAULT_MAX_MESSAGES)
  })
})

describe('Fixer denial set — backlog-mutation guard', () => {
  it('WORKER_CONFIGS.Fixer.disallowedTools contains all FIXER_BACKLOG_DENIED_TOOLS entries', () => {
    for (const denied of FIXER_BACKLOG_DENIED_TOOLS) {
      expect(WORKER_CONFIGS.Fixer.disallowedTools).toContain(denied)
    }
  })

  it('WORKER_CONFIGS.Fixer.disallowedTools blocks mars task add, mars proposal, and mars draft CLI paths', () => {
    expect(WORKER_CONFIGS.Fixer.disallowedTools).toContain('Bash(mars task add*)')
    expect(WORKER_CONFIGS.Fixer.disallowedTools).toContain('Bash(mars proposal*)')
    expect(WORKER_CONFIGS.Fixer.disallowedTools).toContain('Bash(mars draft*)')
  })
})
