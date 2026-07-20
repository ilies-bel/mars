import { describe, expect, it } from 'vitest'
import { CODEGRAPH_NUDGE, WORKER_CONFIGS } from '..'
import type { WorkerName } from '..'

// Pin the codegraph nudge blast radius: exactly Coder, Planner, and Slicer
// carry appendSystemPrompt === CODEGRAPH_NUDGE. Writer does not exist in the
// registry (ADR 0019). Triager and Fixer must NOT carry the nudge — Triager
// is a lightweight read-only classifier (adding graph queries would bloat its
// 40-message budget); Fixer is a recovery agent that must focus on the broken
// code, not exploratory graph traversal.
//
// These tests exist so a future edit cannot silently add or drop the nudge
// from a worker without the test suite catching it.

describe('CODEGRAPH_NUDGE blast radius', () => {
  const nudgedWorkers: WorkerName[] = ['Coder', 'Planner', 'Slicer']
  const unNudgedWorkers: WorkerName[] = ['Triager', 'Fixer', 'BehaviourVerifier', 'Scorer']

  for (const name of nudgedWorkers) {
    it(`${name} carries appendSystemPrompt === CODEGRAPH_NUDGE`, () => {
      expect(WORKER_CONFIGS[name].appendSystemPrompt).toBe(CODEGRAPH_NUDGE)
    })
  }

  for (const name of unNudgedWorkers) {
    it(`${name} does NOT carry the codegraph nudge in appendSystemPrompt`, () => {
      expect(WORKER_CONFIGS[name].appendSystemPrompt).not.toBe(CODEGRAPH_NUDGE)
    })
  }

  it('CODEGRAPH_NUDGE is a non-empty string that references codegraph CLI commands', () => {
    expect(typeof CODEGRAPH_NUDGE).toBe('string')
    expect(CODEGRAPH_NUDGE.length).toBeGreaterThan(0)
    expect(CODEGRAPH_NUDGE).toMatch(/codegraph query/)
    expect(CODEGRAPH_NUDGE).toMatch(/codegraph callers/)
  })

  it('exactly 3 workers carry the nudge — no silent additions', () => {
    const allNames = Object.keys(WORKER_CONFIGS) as WorkerName[]
    const carrying = allNames.filter(
      (n) => WORKER_CONFIGS[n].appendSystemPrompt === CODEGRAPH_NUDGE,
    )
    // The intended set is Coder + Planner + Slicer.
    // If this count changes, someone intentionally expanded or contracted the
    // blast radius and must update this test deliberately.
    expect(carrying).toHaveLength(3)
    expect(carrying).toContain('Coder')
    expect(carrying).toContain('Planner')
    expect(carrying).toContain('Slicer')
  })
})
