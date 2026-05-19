import { describe, expect, it } from 'vitest'
import { claudeStreamArgs } from '../../lib/git'
import {
  CODER_MODEL,
  FIXER_BACKLOG_DENIED_TOOLS,
  READ_ONLY_DENIED_TOOLS,
  WORKER_CONFIGS,
  WRITER_DENIED_TOOLS,
  Workers,
  getWorker,
  getWorkerForTag,
  type WorkerName,
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

describe('Worker registry', () => {
  it('exposes Coder, Planner, Slicer, Triager, Fixer, and Writer as named Workers', () => {
    expect(Workers.Coder).toBeDefined()
    expect(Workers.Planner).toBeDefined()
    expect(Workers.Slicer).toBeDefined()
    expect(Workers.Triager).toBeDefined()
    expect(Workers.Fixer).toBeDefined()
    expect(Workers.Writer).toBeDefined()
  })

  it('returns the same instance from getWorker(name)', () => {
    expect(getWorker('Coder')).toBe(Workers.Coder)
    expect(getWorker('Fixer')).toBe(Workers.Fixer)
    expect(getWorker('Writer')).toBe(Workers.Writer)
  })

  it("pins Triager's message cap at 40 (tighter than the global default of 100)", () => {
    expect(WORKER_CONFIGS.Triager.maxMessages).toBe(40)
    expect(WORKER_CONFIGS.Coder.maxMessages).toBe(100)
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

describe('Writer pinned config', () => {
  const args = argvFor('Writer')

  it('runs haiku-4.5 on medium effort with permission-mode default (no bypass)', () => {
    expect(valueAfter(args, '--model')).toBe('claude-haiku-4-5-20251001')
    expect(valueAfter(args, '--effort')).toBe('medium')
    expect(valueAfter(args, '--permission-mode')).toBe('default')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('denies Edit/Write/NotebookEdit so the writer cannot bypass the structured-write daemon', () => {
    const denied = (valueAfter(args, '--disallowedTools') ?? '').split(',')
    for (const tool of WRITER_DENIED_TOOLS) {
      expect(denied).toContain(tool)
    }
  })
})

describe('getWorkerForTag', () => {
  it('routes "coder" to the Coder Worker and "writer" to the Writer Worker', () => {
    expect(getWorkerForTag('coder')).toBe(Workers.Coder)
    expect(getWorkerForTag('writer')).toBe(Workers.Writer)
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
      'Writer',
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
