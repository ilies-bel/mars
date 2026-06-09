// PRD 948691d0 — slice 4/8: migrated stages dispatch through named Workers.
//
// These are structural guardrails. They pin the binding between each
// dispatching stage and its role-pinned Worker, and they assert that the
// migrated stages do NOT reach for the lower-level `runClaudeCode` wrapper
// any more — every dispatching stage now routes through the role registry,
// with no carve-outs.
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
    // ADR-0056: the agent dispatch was promoted out of the inline `code` step
    // body into the exported `runAgent` git step-primitive. The bundled
    // implement-workflow now COMPOSES it; the Worker-routing binding lives in
    // the primitive. Assert the binding at its new home (the primitive surface)
    // and that the bundled workflow composes it.
    const primitive = read('primitives/index.ts')
    // Fixer for kind='fix', everything else via pickWorkerForTags — intersects
    // the task's tag list against each registered Worker's tag set; falls back
    // to the default headless Worker (Coder) when no Worker claims a tag.
    // Both branches go through the role registry — not a raw `runClaudeCode` call.
    // Workers are passed to runWorkerWithSpan (PRD 436f14c7) rather than calling
    // .run() inline; the binding to named Workers is preserved.
    expect(primitive).toMatch(/Workers\.Fixer/)
    expect(primitive).toMatch(/pickWorkerForTags/)
    expect(primitive).toMatch(/runWorkerWithSpan/)
    // The bundled workflow composes the primitive rather than re-implementing it.
    const workflow = read('implement-workflow.ts')
    expect(workflow).toMatch(/runAgent/)
  })

  it('plan workflow dispatches Workers.Planner through runWorkerWithSpan', () => {
    const src = read('plan-workflow.ts')
    // Previously Workers.Planner.run() — now passed to runWorkerWithSpan so a
    // step span is recorded around each Planner session (PRD 436f14c7).
    expect(src).toMatch(/Workers\.Planner/)
    expect(src).toMatch(/runWorkerWithSpan/)
  })

  it('slice workflow dispatches Workers.Slicer through runWorkerWithSpan', () => {
    const src = read('slice-workflow.ts')
    // Previously Workers.Slicer.run() — now passed to runWorkerWithSpan so a
    // step span is recorded around each Slicer session (PRD 436f14c7).
    expect(src).toMatch(/Workers\.Slicer/)
    expect(src).toMatch(/runWorkerWithSpan/)
  })

  it('triage workflow dispatches Workers.Triager through runWorkerWithSpan', () => {
    const src = read('triage-workflow.ts')
    // Previously Workers.Triager.run() — now passed to runWorkerWithSpan so a
    // step span is recorded around each Triager session (PRD 436f14c7).
    expect(src).toMatch(/Workers\.Triager/)
    expect(src).toMatch(/runWorkerWithSpan/)
  })

  it('migrated stages do not assemble dispatch flags ad-hoc', () => {
    // None of the four migrated stage source files should import
    // `runClaudeCode` — that is the wrapper Workers.run delegates to, and
    // a stage that imports it directly is the symptom of the regression
    // this slice was built to prevent.
    for (const name of [
      'implement-workflow.ts',
      'primitives/index.ts',
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
