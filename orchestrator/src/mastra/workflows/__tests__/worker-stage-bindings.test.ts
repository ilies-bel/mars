// PRD 948691d0 — slice 4/8: migrated stages dispatch through named Workers.
//
// These are structural guardrails. They pin the binding between each
// dispatching stage and its role-pinned Worker, and they assert that the
// migrated stages do NOT reach for the lower-level `runClaudeCode` wrapper
// any more — only the A/B experiment workflow keeps that direct call,
// because A/B variants intentionally configure their own per-variant
// `claude -p` flags (model, system prompt) outside the role registry.
//
// A test that loads the workflow source files and greps for the Worker
// names is intentionally coarse: it documents the binding without
// snapshotting unrelated workflow behaviour, so it survives every
// refactor short of moving the dispatch call itself.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflowsDir = resolve(__dirname, '..')
const read = (name: string): string =>
  readFileSync(resolve(workflowsDir, name), 'utf-8')

describe('PRD 948691d0 slice 4 — stages route through named Workers', () => {
  it('implement workflow dispatches through Coder/Fixer via the Workers registry', () => {
    const src = read('implement-workflow.ts')
    // Fixer for kind='fix', Worker-by-tag for everything else (Coder is the
    // 'coder' tag, Writer is the 'writer' tag). Both branches go through the
    // role registry — not a raw `runClaudeCode` call.
    expect(src).toMatch(/Workers\.Fixer/)
    expect(src).toMatch(/getWorkerForTag/)
    expect(src).toMatch(/worker\.run\(/)
  })

  it('plan workflow dispatches through Workers.Planner.run', () => {
    const src = read('plan-workflow.ts')
    expect(src).toMatch(/Workers\.Planner\.run\(/)
  })

  it('slice workflow dispatches through Workers.Slicer.run', () => {
    const src = read('slice-workflow.ts')
    expect(src).toMatch(/Workers\.Slicer\.run\(/)
  })

  it('triage workflow dispatches through Workers.Triager.run', () => {
    const src = read('triage-workflow.ts')
    expect(src).toMatch(/Workers\.Triager\.run\(/)
  })

  it('A/B experiment workflow keeps calling runClaudeCode directly', () => {
    const src = read('ab-experiment-workflow.ts')
    // A/B is the documented carve-out: each variant pins its own model /
    // systemPrompt, so it does not fit the role registry.
    expect(src).toMatch(/runClaudeCode\(/)
  })

  it('migrated stages do not assemble dispatch flags ad-hoc', () => {
    // None of the four migrated stage source files should import
    // `runClaudeCode` — that is the wrapper Workers.run delegates to, and
    // a stage that imports it directly is the symptom of the regression
    // this slice was built to prevent.
    for (const name of [
      'implement-workflow.ts',
      'plan-workflow.ts',
      'slice-workflow.ts',
      'triage-workflow.ts',
    ]) {
      const src = read(name)
      expect(src).not.toMatch(/from ['"][^'"]*\/lib\/git['"][^]*runClaudeCode/)
      expect(src).not.toMatch(/import\s*\{[^}]*runClaudeCode[^}]*\}\s*from/)
    }
  })
})
