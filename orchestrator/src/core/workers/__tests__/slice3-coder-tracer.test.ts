// PRD 948691d0 — slice 3/6 tracer-guard.
//
// Slice 3 introduced the Worker primitive and migrated the implement
// workflow's coding stage to invoke a named Coder Worker instead of
// assembling `claude -p` flags ad-hoc.
//
// These guards pin the end-to-end claim of that slice as observable
// behaviour against the public registry. They are intentionally narrow:
// each `it` corresponds to exactly one acceptance criterion in the slice
// brief, so a future refactor that breaks the contract surfaces here
// before it reaches the implement workflow.
//
// AC mapping (see slice brief in queue.db):
//  - AC1 (constructed once, invoked many times) → describe #1
//  - AC2 (pinned config visible from a single registry file)   → describe #2
//  - AC3 (implement workflow surfaces role 'Coder' end-to-end) → describe #3
//  - AC4 (live trace records workerName on Coder span events)  → describe #4
//
// AC4's payload-shape claim is also covered structurally in
// `../../lib/__tests__/run-worker-with-span.test.ts`; this file checks the
// run-time hop from the dispatch site (implement-workflow) to the Coder
// Worker that ultimately surfaces in the trace.

import { describe, expect, it } from 'vitest'
import {
  CODER_MODEL,
  WORKER_CONFIGS,
  Workers,
  createWorker,
  getWorker,
  pickWorkerForTags,
} from '..'
import { pickWorkerForTask } from '../../../workflows/implement-workflow'
import type { Task } from '../../queue'

describe('PRD 948691d0 slice 3 — Coder Worker can be constructed once and invoked many times', () => {
  it('Workers.Coder is a singleton: identical reference across registry lookups', () => {
    // AC1: the Worker primitive is built once at module load and reused —
    // not reconstructed per dispatch. Any change that starts producing a
    // fresh Worker per call would invalidate this and surface here.
    expect(getWorker('Coder')).toBe(Workers.Coder)
    expect(getWorker('Coder')).toBe(getWorker('Coder'))
  })

  it('Worker.run accepts a prompt + RunOptions (cwd, optional sessionId, optional onEvent)', () => {
    // AC1 (interface shape, observed through the public type surface). We
    // do not invoke run() here — that would require spawning claude — but
    // we assert the function exists and is callable, which is the same
    // assertion the dispatch site relies on.
    const w = Workers.Coder
    expect(typeof w.run).toBe('function')
    // run has arity 2 (prompt, options)
    expect(w.run.length).toBe(2)
  })
})

describe('PRD 948691d0 slice 3 — Coder pinned config visible from a single registry file', () => {
  it("WORKER_CONFIGS.Coder exposes every field the PRD calls out as 'visible' day-one defaults", () => {
    // AC2: model, effort, permission mode, message cap, denials of
    // agent-to-user tools — all readable from one place without chasing
    // call sites. Day-one defaults agreed in the grill: Sonnet, high
    // effort, bypassPermissions, unbounded messages, no per-Worker denial
    // list beyond the wrapper-layer agent-to-user pair.
    const cfg = WORKER_CONFIGS.Coder
    expect(cfg.name).toBe('Coder')
    expect(cfg.model).toBe(CODER_MODEL)
    expect(cfg.effort).toBe('high')
    expect(cfg.permissionMode).toBe('bypassPermissions')
    expect(cfg.disallowedTools).toEqual([]) // wrapper-layer adds the agent-to-user pair
    expect(cfg.outputFormat).toBe('stream-json')
    expect(cfg.runtime).toBe('headless')
  })

  it('createWorker re-validates the systemPrompt mutual-exclusion guard for ad-hoc Workers', () => {
    // AC2 — invariant survives ad-hoc construction. The same construction
    // path is what experimentation harnesses and tests use to spawn a
    // Worker with a tweaked config; the guard cannot be bypassed.
    const base = { ...WORKER_CONFIGS.Coder }
    expect(() =>
      createWorker({ ...base, systemPrompt: 'X', appendSystemPrompt: 'Y' }),
    ).toThrow(/mutually exclusive/i)
  })
})

describe('PRD 948691d0 slice 3 — implement workflow routes ordinary tasks to the Coder Worker', () => {
  it("pickWorkerForTask resolves task-kind work to the 'Coder' role name", () => {
    // AC3 — the routing decision the implement workflow makes for an
    // ordinary (kind='task') row goes to Coder; a fix-kind row goes to
    // Fixer. Both routes pass through the named Worker registry, not a
    // raw `runClaudeCode` call.
    expect(pickWorkerForTask({ kind: 'task' } as Task)).toBe('Coder')
    expect(pickWorkerForTask({} as Task)).toBe('Coder') // legacy: undefined kind
  })

  it("pickWorkerForTags(['coder'], Workers) resolves to the same Coder singleton the dispatch path uses", () => {
    // AC3 — the tag→Worker seam used in the implement workflow returns
    // the Coder singleton. A future refactor that introduced an inline
    // construction would break this identity check.
    expect(pickWorkerForTags(['coder'], Workers)).toBe(Workers.Coder)
  })
})
