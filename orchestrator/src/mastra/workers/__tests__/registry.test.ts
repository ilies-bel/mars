import { describe, expect, it } from 'vitest'
import { claudeStreamArgs } from '../../lib/git'
import {
  FIXER_BACKLOG_DENIED_TOOLS,
  READ_ONLY_DENIED_TOOLS,
  WORKER_CONFIGS,
  WRITER_DENIED_TOOLS,
  Workers,
  getWorker,
  getWorkerForTag,
  type WorkerName,
} from '..'

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

  it('runs opus on high effort with bypassPermissions and no read-only denials', () => {
    expect(valueAfter(args, '--model')).toBe('claude-opus-4-7')
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
    it(`${name}: runs bare with --permission-mode default and denies Edit/Write/NotebookEdit at the Worker layer`, () => {
      const args = argvFor(name)
      expect(valueAfter(args, '--permission-mode')).toBe('default')
      expect(args).not.toContain('--dangerously-skip-permissions')
      expect(args).toContain('--bare')
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
})

describe('Fixer pinned config', () => {
  const args = argvFor('Fixer')

  it('matches Coder model/effort/permission posture so it can land code', () => {
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
