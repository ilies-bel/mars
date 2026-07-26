/**
 * The workflow validation dry-run: enumerates the declared runbook (step
 * names, primitives, Execution modes, Step guides) with zero side effects.
 * Loader-level failures (missing/malformed files, no fallback) are covered in
 * scaffolded-workflow-runtime.test.ts; these tests exercise the engine-level
 * dry-run with in-memory workflow objects built on the REAL primitives.
 */
import { describe, expect, it } from 'vitest'
import { defineWorkflow, type WorkflowCtx } from '@mars/workflow'
import {
  setupWorktree,
  runAgent,
  review,
  merge,
  awaitHuman,
} from '../primitives'
import { dryRunWorkflow } from '../validate-workflow'

type Ctx = WorkflowCtx<never, never>

describe('dryRunWorkflow', () => {
  it('enumerates a live runbook with modes and guides, executing nothing', async () => {
    const wf = defineWorkflow({
      id: 'live',
      async fn(ctx: Ctx) {
        await ctx.step('setup', () => setupWorktree(ctx as never))
        await ctx.step('code', () => runAgent(ctx as never))
        await ctx.step('review', () => review(ctx as never))
        return ctx.step('merge', () => merge(ctx as never))
      },
    })

    const r = await dryRunWorkflow(wf as never, 'live')
    expect(r.errors).toEqual([])
    expect(r.steps).toEqual([
      { step: 'setup', primitive: 'setupWorktree', mode: 'auto', guide: null },
      { step: 'code', primitive: 'runAgent', mode: 'auto', guide: null },
      { step: 'review', primitive: 'review', mode: 'auto', guide: null },
      { step: 'merge', primitive: 'merge', mode: 'auto', guide: null },
    ])
  })

  it('records a bare awaitHuman gate as a manual step without parking', async () => {
    const wf = defineWorkflow({
      id: 'gated',
      async fn(ctx: Ctx) {
        await ctx.step('setup', () => setupWorktree(ctx as never))
        await ctx.step('qa-gate', () =>
          awaitHuman(ctx as never, { note: 'QA the preview' }),
        )
        return ctx.step('merge', () => merge(ctx as never))
      },
    })

    const r = await dryRunWorkflow(wf as never, 'gated')
    expect(r.errors).toEqual([])
    expect(r.steps[1]).toEqual({
      step: 'qa-gate',
      primitive: 'awaitHuman',
      mode: 'manual',
      guide: 'QA the preview',
    })
    // The dry-run walked PAST the gate — merge was still enumerated.
    expect(r.steps[2]?.step).toBe('merge')
  })

  it('renders hand-written step bodies as (custom) auto steps', async () => {
    const wf = defineWorkflow({
      id: 'diagnose',
      async fn(ctx: Ctx) {
        await ctx.step('walk-arc', async () => ({ ok: true }))
        await ctx.step('record-verdict', async () => ({ ok: true }))
        return null
      },
    })

    const r = await dryRunWorkflow(wf as never, 'diagnose')
    expect(r.errors).toEqual([])
    expect(r.steps).toEqual([
      { step: 'walk-arc', primitive: '(custom)', mode: 'auto', guide: null },
      { step: 'record-verdict', primitive: '(custom)', mode: 'auto', guide: null },
    ])
  })

  it('reports duplicate step names as a dry-run failure', async () => {
    const wf = defineWorkflow({
      id: 'dup',
      async fn(ctx: Ctx) {
        await ctx.step('code', async () => ({}))
        await ctx.step('code', async () => ({}))
        return null
      },
    })

    const r = await dryRunWorkflow(wf as never, 'dup')
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toMatch(/dry-run failed/)
    expect(r.errors[0]).toMatch(/Duplicate step name/)
  })

  it('rejects a workflow whose fn declares no steps at all', async () => {
    const wf = defineWorkflow({
      id: 'empty',
      async fn() {
        return null
      },
    })

    const r = await dryRunWorkflow(wf as never, 'empty')
    expect(r.errors).toEqual([
      'workflow fn ran but declared no steps — wrap work in ctx.step(name, fn)',
    ])
  })
})
