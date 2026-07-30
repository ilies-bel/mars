import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeStreamArgs } from '../../lib/git/claude'
import {
  ASK_USER_DENIED_TOOL,
  CODER_MODEL,
  FIXER_BACKLOG_DENIED_TOOLS,
  READ_ONLY_DENIED_TOOLS,
  WORKER_PROVIDER,
  WORKER_CONFIGS,
  Workers,
  createWorker,
  getWorker,
  pickWorkerForTags,
  providerModel,
  resolveWorkerMaxContextTokens,
  type Worker,
  type WorkerConfig,
  type WorkerName,
  type WorkerRuntime,
} from '..'
import { pickWorkerForTask } from '../../../workflows/primitives/shared'
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
      maxContextTokens: 0,
      runtime: 'headless',
      provider: 'claude',
    }
    expect(createWorker(cfg).runtime).toBe('headless')
  })
})

describe('built-in Worker tag sets', () => {
  it('every built-in Worker carries a non-empty tags array reflecting its role', () => {
    // Each built-in Worker must declare at least one tag so pickWorkerForTags
    // can route tasks to it. The tag must match the Worker's role name.
    const expectedTags: Record<WorkerName, string> = {
      Coder: 'coder',
      Planner: 'planner',
      Slicer: 'slicer',
      Triager: 'triager',
      Fixer: 'fixer',
      BehaviourVerifier: 'behaviour-verifier',
      Scorer: 'scorer',
      RescueOperator: 'rescue-operator',
    }
    for (const [name, expectedTag] of Object.entries(expectedTags) as [WorkerName, string][]) {
      expect(WORKER_CONFIGS[name].tags, `${name} must have a tags array`).toBeDefined()
      expect(WORKER_CONFIGS[name].tags, `${name}.tags must be non-empty`).not.toHaveLength(0)
      expect(WORKER_CONFIGS[name].tags, `${name}.tags must include '${expectedTag}'`).toContain(expectedTag)
    }
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

  it('Planner and Slicer use the flagship tier; Triager uses balanced', () => {
    expect(WORKER_CONFIGS.Planner.model).toBe(providerModel(WORKER_PROVIDER, 'flagship'))
    expect(WORKER_CONFIGS.Planner.effort).toBe('high')
    expect(WORKER_CONFIGS.Slicer.model).toBe(providerModel(WORKER_PROVIDER, 'flagship'))
    expect(WORKER_CONFIGS.Slicer.effort).toBe('high')
    expect(WORKER_CONFIGS.Triager.model).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
    expect(WORKER_CONFIGS.Triager.effort).toBe('medium')
  })


})

describe('Fixer pinned config', () => {
  const args = argvFor('Fixer')

  it('runs the balanced provider tier on high effort with bypassPermissions', () => {
    // Fixer uses the balanced tier (same as Coder) because recovery briefs are scoped
    // mechanical work (finish-the-job or repair-one-defect). Opus pinning was
    // a cost amplifier under failure storms.
    expect(valueAfter(args, '--model')).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
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

// Regression guard: before commit 77b0f693, WORKER_CONFIGS.Fixer.model was
// 'claude-opus-4-7', causing every recovery run to dispatch on Opus even though
// the intent was Sonnet (scoped mechanical work, not architectural reasoning).
// During a failure storm this multiplied cost — each failed task spawned one
// Opus Fixer. The tests below pin the dispatch-time model to prevent regression.
describe('fix-run model-tier regression', () => {
  it('Workers.Fixer is selected for fix tasks and uses the balanced tier', () => {
    // The dispatch path in runAgent: kind === 'fix' ? Workers.Fixer : ...
    // Workers.Fixer must never silently revert to opus.
    expect(Workers.Fixer.config.model).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
    expect(WORKER_CONFIGS.Fixer.model).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
  })

  it('fix-run argv contains the balanced model and not the flagship model', () => {
    // Verify the argv path end-to-end: WORKER_CONFIGS.Fixer → claudeStreamArgs.
    // If the model is ever reverted to opus, this catches it at the argv level,
    // not just at the config level.
    const fixArgs = argvFor('Fixer')
    expect(valueAfter(fixArgs, '--model')).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
    expect(fixArgs).not.toContain(providerModel(WORKER_PROVIDER, 'flagship'))
  })

  it('Fixer model is NOT overridable by MARS_WORKER_MODEL (only Coder is)', () => {
    // MARS_WORKER_MODEL feeds CODER_MODEL, which is used only by WORKER_CONFIGS.Coder.
    // Fixer must always use CLAUDE_SONNET_MODEL regardless of MARS_WORKER_MODEL.
    // This test verifies the isolation: even if MARS_WORKER_MODEL were set to opus,
    // the Fixer config stays on the pinned sonnet.
    expect(WORKER_CONFIGS.Fixer.model).toBe(providerModel(WORKER_PROVIDER, 'balanced'))
    // Coder may differ from Fixer if MARS_WORKER_MODEL is set, but Fixer must not.
    // The pinned constant is the same 'claude-sonnet-4-6' regardless of env.
    expect(WORKER_CONFIGS.Fixer.model).not.toBe(WORKER_CONFIGS.Planner.model) // Planner is Opus
    expect(WORKER_CONFIGS.Fixer.model).not.toBe(WORKER_CONFIGS.Slicer.model) // Slicer is Opus
  })
})

describe('MARS_WORKER_MODEL env var', () => {
  it('defaults Coder to the selected provider balanced tier when MARS_WORKER_MODEL is unset', () => {
    // CODER_MODEL is resolved at module-load time: process.env.MARS_WORKER_MODEL
    // or the provider-native balanced model. This verifies the resolved value.
    const expected = process.env.MARS_WORKER_MODEL ?? providerModel(WORKER_PROVIDER, 'balanced')
    expect(CODER_MODEL).toBe(expected)
  })

  it('Coder config carries the resolved CODER_MODEL so the env var takes effect', () => {
    expect(WORKER_CONFIGS.Coder.model).toBe(CODER_MODEL)
  })
})

// The Writer pinned config describe block was removed by ADR 0019.
// The Writer Worker no longer exists in the registry.

describe('pickWorkerForTags', () => {
  it('returns the Coder Worker when tags include "coder"', () => {
    // A task tagged 'coder' intersects the Coder Worker's tag set → Coder.
    expect(pickWorkerForTags(['coder'], Workers)).toBe(Workers.Coder)
  })

  it('falls back to the Coder Worker (default headless Worker) when no tags match', () => {
    // No registered Worker claims this tag → fall through to default headless
    // Worker (Coder, full tool surface, bypassPermissions).
    expect(pickWorkerForTags(['unknown-tag'], Workers)).toBe(Workers.Coder)
  })

  it('falls back to the Coder Worker for an empty tag list', () => {
    // An empty tag list never intersects any Worker's tag set.
    expect(pickWorkerForTags([], Workers)).toBe(Workers.Coder)
  })

  it('returns the matching Worker when the tag list contains multiple tags', () => {
    // The first Worker whose tags intersect the list is returned.
    expect(pickWorkerForTags(['something-else', 'coder'], Workers)).toBe(
      Workers.Coder,
    )
  })

  it('routes tasks tagged "planner" to the Planner Worker', () => {
    expect(pickWorkerForTags(['planner'], Workers)).toBe(Workers.Planner)
  })

  it('routes tasks tagged "slicer" to the Slicer Worker', () => {
    expect(pickWorkerForTags(['slicer'], Workers)).toBe(Workers.Slicer)
  })

  it('routes tasks tagged "triager" to the Triager Worker', () => {
    expect(pickWorkerForTags(['triager'], Workers)).toBe(Workers.Triager)
  })

  it('routes tasks tagged "fixer" to the Fixer Worker', () => {
    expect(pickWorkerForTags(['fixer'], Workers)).toBe(Workers.Fixer)
  })

  it('routes to an operator-declared custom Worker when its tag matches', () => {
    // Simulate an operator-declared Worker added to the registry with a custom tag.
    const customWorker = createWorker({
      name: 'ScaffoldWorker',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      maxContextTokens: 0,
      runtime: 'headless',
      provider: 'claude',
      tags: ['scaffold'],
    })
    const allWorkers: Record<string, Worker> = { ...Workers, ScaffoldWorker: customWorker }
    // A task with tag 'scaffold' must route to the custom Worker, not Coder.
    expect(pickWorkerForTags(['scaffold'], allWorkers)).toBe(customWorker)
  })

  it('falls back to Coder when a custom worker map lacks a matching tag', () => {
    const customWorker = createWorker({
      name: 'ScaffoldWorker',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      permissionMode: 'default',
      bare: false,
      disallowedTools: [],
      outputFormat: 'stream-json',
      maxContextTokens: 0,
      runtime: 'headless',
      provider: 'claude',
      tags: ['scaffold'],
    })
    const allWorkers: Record<string, Worker> = { ...Workers, ScaffoldWorker: customWorker }
    expect(pickWorkerForTags(['unknown'], allWorkers)).toBe(Workers.Coder)
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
    maxContextTokens: 0,
    runtime: 'headless',
    provider: 'claude',
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

describe('resolveWorkerMaxContextTokens — env override > per-worker default > 0 (disabled)', () => {
  const origEnv = process.env.MARS_CONTEXT_TOKEN_BUDGET

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.MARS_CONTEXT_TOKEN_BUDGET
    } else {
      process.env.MARS_CONTEXT_TOKEN_BUDGET = origEnv
    }
  })

  it('returns the per-worker default when no env override is set', () => {
    delete process.env.MARS_CONTEXT_TOKEN_BUDGET
    expect(resolveWorkerMaxContextTokens(150_000)).toBe(150_000)
  })

  it('returns 0 (disabled) when neither env var nor override is provided', () => {
    delete process.env.MARS_CONTEXT_TOKEN_BUDGET
    expect(resolveWorkerMaxContextTokens()).toBe(0)
  })

  it('returns 0 (disabled) when override is 0', () => {
    delete process.env.MARS_CONTEXT_TOKEN_BUDGET
    expect(resolveWorkerMaxContextTokens(0)).toBe(0)
  })

  it('env override MARS_CONTEXT_TOKEN_BUDGET supersedes the per-worker default', () => {
    process.env.MARS_CONTEXT_TOKEN_BUDGET = '99999'
    expect(resolveWorkerMaxContextTokens(150_000)).toBe(99_999)
  })

  it('env override of 0 is treated as disabled (falls through to per-worker default)', () => {
    // "0" in the env means "no override" — the per-worker default takes effect.
    process.env.MARS_CONTEXT_TOKEN_BUDGET = '0'
    expect(resolveWorkerMaxContextTokens(150_000)).toBe(150_000)
  })

  it('a non-numeric env value falls through to the per-worker default', () => {
    process.env.MARS_CONTEXT_TOKEN_BUDGET = 'not-a-number'
    expect(resolveWorkerMaxContextTokens(150_000)).toBe(150_000)
  })
})

describe('WORKER_CONFIGS context token budgets', () => {
  it('every Worker in WORKER_CONFIGS carries a non-negative maxContextTokens', () => {
    for (const name of Object.keys(WORKER_CONFIGS) as WorkerName[]) {
      expect(WORKER_CONFIGS[name].maxContextTokens, `${name}.maxContextTokens`).toBeGreaterThanOrEqual(0)
    }
  })

  it('Coder, Fixer, Planner, and Slicer carry a generous context budget (> 0)', () => {
    for (const name of ['Coder', 'Fixer', 'Planner', 'Slicer'] as WorkerName[]) {
      expect(WORKER_CONFIGS[name].maxContextTokens, `${name} must have a positive context budget`).toBeGreaterThan(0)
    }
  })

  it('all context budgets are below the model context window (200k) to pre-empt compaction', () => {
    const MODEL_CONTEXT_WINDOW = 200_000
    for (const name of Object.keys(WORKER_CONFIGS) as WorkerName[]) {
      const budget = WORKER_CONFIGS[name].maxContextTokens
      if (budget > 0) {
        expect(budget, `${name} budget must be < 200k`).toBeLessThan(MODEL_CONTEXT_WINDOW)
      }
    }
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

describe('ask-user tool policy — worker access control', () => {
  // Coder and Fixer may surface questions to the operator via
  // `mars task ask <taskId> "<question>"`. Read-only workers must not be
  // able to stall on operator input — their role is to read and emit text.

  it('ASK_USER_DENIED_TOOL is the bash pattern for mars task ask', () => {
    expect(ASK_USER_DENIED_TOOL).toBe('Bash(mars task ask*)')
  })

  it('ASK_USER_DENIED_TOOL is included in READ_ONLY_DENIED_TOOLS', () => {
    expect(READ_ONLY_DENIED_TOOLS).toContain(ASK_USER_DENIED_TOOL)
  })

  it('read-only workers (Planner, Slicer, Triager, BehaviourVerifier, Scorer) deny the ask-user path', () => {
    const readOnlyRoles: WorkerName[] = ['Planner', 'Slicer', 'Triager', 'BehaviourVerifier', 'Scorer']
    for (const name of readOnlyRoles) {
      expect(
        WORKER_CONFIGS[name].disallowedTools,
        `${name} must deny the ask-user path`,
      ).toContain(ASK_USER_DENIED_TOOL)
    }
  })

  it('Coder does NOT deny the ask-user path — it may surface blockers to the operator', () => {
    expect(WORKER_CONFIGS.Coder.disallowedTools).not.toContain(ASK_USER_DENIED_TOOL)
  })

  it('Fixer does NOT deny the ask-user path — recovery workers may also need operator input', () => {
    expect(WORKER_CONFIGS.Fixer.disallowedTools).not.toContain(ASK_USER_DENIED_TOOL)
  })

  it('the ask-user denial appears in read-only argv via claudeStreamArgs', () => {
    // Verify the denial propagates end-to-end through the argv builder so
    // the running claude subprocess actually has it in its disallowedTools list.
    for (const name of ['Planner', 'Slicer', 'Triager', 'BehaviourVerifier', 'Scorer'] as WorkerName[]) {
      const denied = (valueAfter(argvFor(name), '--disallowedTools') ?? '').split(',')
      expect(denied, `${name} argv must deny ask-user`).toContain(ASK_USER_DENIED_TOOL)
    }
  })

  it('the ask-user path is NOT in Coder or Fixer argv', () => {
    for (const name of ['Coder', 'Fixer'] as WorkerName[]) {
      const denied = (valueAfter(argvFor(name), '--disallowedTools') ?? '').split(',')
      expect(denied, `${name} must NOT deny ask-user`).not.toContain(ASK_USER_DENIED_TOOL)
    }
  })
})
