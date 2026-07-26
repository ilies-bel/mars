/**
 * Static safety lint for agent-authored workflow bodies (ADR-0068).
 *
 * The lint is the pre-execution screen: it must run BEFORE the validate
 * dry-run (which executes the author's `fn`), so everything here is purely
 * textual. These tests pin the contract: imports restricted to
 * `'mars/workflow'` with named bindings from the allowed set, no banned
 * escape hatches, exactly one `export default` of the two legal shapes, and
 * no top-level statements besides imports and that export.
 */

import { describe, expect, it } from 'vitest'
import { lintAgentWorkflowBody } from '../workflow-lint'
import { stampAgentDraft } from '../agent-draft'

const VALID_DEFINE_BODY = [
  "import { defineWorkflow, setupWorktree, runAgent, review, merge } from 'mars/workflow'",
  '',
  'export default defineWorkflow({',
  "  id: 'qa-loop',",
  '  async fn(ctx) {',
  "    await ctx.step('setup', () => setupWorktree(ctx))",
  "    await ctx.step('code', () => runAgent(ctx))",
  "    await ctx.step('review', () => review(ctx, { reviewType: 'auto' }))",
  "    return ctx.step('merge', () => merge(ctx))",
  '  },',
  '})',
  '',
].join('\n')

const VALID_OBJECT_BODY = [
  'export default {',
  "  id: 'qa-loop',",
  '  async fn(ctx) {',
  "    await ctx.step('plan', async () => ({ ok: true }))",
  "    return ctx.step('wrap', async () => ({ done: true }))",
  '  },',
  '}',
  '',
].join('\n')

describe('lintAgentWorkflowBody — accepted shapes', () => {
  it('accepts a defineWorkflow body importing only from mars/workflow', () => {
    const r = lintAgentWorkflowBody(VALID_DEFINE_BODY)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('accepts a plain { id, fn } object export with no imports', () => {
    const r = lintAgentWorkflowBody(VALID_OBJECT_BODY)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('accepts the stamped agent-draft form (markers are comments)', () => {
    const r = lintAgentWorkflowBody(stampAgentDraft(VALID_DEFINE_BODY, 'agent:test'))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('ignores banned-looking words inside strings, comments, and templates', () => {
    const body = [
      "// this comment mentions require and process — that's fine",
      'export default {',
      "  id: 'wordy',",
      '  async fn(ctx) {',
      "    await ctx.step('s', async () => ({ note: 'the process requires evaluation' }))",
      '    return { msg: `a template mentioning require` }',
      '  },',
      '}',
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.errors).toEqual([])
  })
})

describe('lintAgentWorkflowBody — rejected bodies', () => {
  it('rejects any import that is not mars/workflow', () => {
    const body = [
      "import { readFileSync } from 'node:fs'",
      'export default {',
      "  id: 'evil',",
      '  async fn(ctx) {',
      "    await ctx.step('x', async () => ({}))",
      '  },',
      '}',
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain("'node:fs' is not allowed")
  })

  it('rejects bindings outside the allowed primitive set', () => {
    const body = [
      "import { defineWorkflow, somethingElse } from 'mars/workflow'",
      "export default defineWorkflow({ id: 'x', async fn(ctx) { await ctx.step('s', async () => ({})) } })",
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain("'somethingElse' is not an allowed import")
  })

  it('rejects dynamic import()', () => {
    const body = [
      'export default {',
      "  id: 'dyn',",
      '  async fn(ctx) {',
      "    await ctx.step('s', async () => { await import('node:fs'); return {} })",
      '  },',
      '}',
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain('dynamic import() is not allowed')
  })

  it('rejects require / eval / Function / process / globalThis anywhere', () => {
    const body = [
      'export default {',
      "  id: 'escape',",
      '  async fn(ctx) {',
      "    await ctx.step('s', async () => {",
      "      const fs = require('fs')",
      "      eval('1')",
      "      new Function('return 1')()",
      '      process.exit(1)',
      '      globalThis.leak = true',
      '      return {}',
      '    })',
      '  },',
      '}',
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    const all = r.errors.join('\n')
    for (const banned of ['require', 'eval', 'Function', 'process', 'globalThis']) {
      expect(all).toContain(`'${banned}' is not allowed`)
    }
  })

  it('rejects a banned identifier inside a template interpolation', () => {
    const body = [
      'export default {',
      "  id: 'interp',",
      '  async fn(ctx) {',
      "    return ctx.step('s', async () => ({ p: `home is ${process.env.HOME}` }))",
      '  },',
      '}',
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain("'process' is not allowed")
  })

  it('rejects top-level statements outside imports and the default export', () => {
    const body = [
      VALID_OBJECT_BODY,
      "console.log('side effect at module load')",
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain('top-level code outside imports and the default export')
  })

  it('rejects a body with no export default', () => {
    const r = lintAgentWorkflowBody("const x = 1\n")
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain("exactly one 'export default'")
  })

  it('rejects named exports', () => {
    const body = [
      "export const helper = 1",
      VALID_OBJECT_BODY,
    ].join('\n')
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain("only 'export default' is allowed")
  })

  it('rejects an export default that is neither defineWorkflow(...) nor an object literal', () => {
    const body = "export default 42\n"
    const r = lintAgentWorkflowBody(body)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain('must be defineWorkflow({...}) or a { id, fn } object literal')
  })
})
