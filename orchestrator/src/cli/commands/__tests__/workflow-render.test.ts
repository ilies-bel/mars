/**
 * Tests for `mars workflow render <kind>` (slice mars-d93596ad).
 *
 * Covers the three required behaviours:
 *   1. (a) Text output — numbered steps with mode label in declaration order.
 *   2. (b) JSON output — parseable `{ kind, steps: [{ name, mode, guide? }] }`.
 *   3. (c) Missing workflow — non-zero exit with validator error in stderr.
 *
 * Uses the in-process command seam (ADR-0023) so tests assert on CLI
 * behaviour without spawning a real daemon or process. Workflow files are
 * plain-JS minimal objects with no external imports — this avoids module
 * resolution issues when loading files from temp directories, and the
 * existing dryRunWorkflow tests (validate-workflow.test.ts) cover the
 * manual-step / guide recording path with in-memory primitives.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCommandInProcess, makeFakeDaemon } from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mars-render-test-'))
  mkdirSync(join(repoRoot, '.mars'), { recursive: true })
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

/** Write a workflow JS file into the temp repo's `.mars/workflows/` dir. */
const writeWorkflow = (name: string, source: string): void => {
  const dir = join(repoRoot, '.mars', 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}-workflow.js`), source)
}

/**
 * Minimal workflow JS with two custom steps and no external imports.
 * Both steps are `(custom)` — mode='auto', guide=null — because they
 * don't call any Mars primitive inside the step body. The
 * dryRunWorkflow tests (validate-workflow.test.ts) cover the manual /
 * guide path with in-memory workflow objects.
 */
const SIMPLE_WORKFLOW = [
  "export default {",
  "  id: 'simple',",
  "  async fn(ctx) {",
  "    await ctx.step('setup', async () => ({ ok: true }))",
  "    await ctx.step('code',  async () => ({ ok: true }))",
  "    return null",
  "  },",
  "}",
  "",
].join('\n')

/**
 * Build a minimal but fully typed OrchestratorContext pointing at `repoRoot`.
 * Constructed inline to avoid the process-level cache inside `resolveContext`.
 */
const makeCtx = (): OrchestratorContext => ({
  repoRoot,
  stateDir: join(repoRoot, '.mars'),
  queueDbPath: join(repoRoot, '.mars', 'mars.db'),
  observabilityDbPath: join(repoRoot, '.mars', 'observability.duckdb'),
  stateDbPath: join(repoRoot, '.mars', 'mars.db'),
  supervisorsDir: join(repoRoot, '.mars', 'supervisors'),
  supervisorsManifest: join(repoRoot, '.mars', 'supervisors', 'manifest.json'),
})

/**
 * Minimal fake store — workflowRender does not query the task database.
 * The `as unknown as DomainTaskStore` cast is the same pattern used in
 * validate-workflow.ts's `inertTaskStore()`.
 */
const fakeStore = {
  query: async () => ({ rows: [] }),
  execute: async () => ({ rows: [] }),
  batch: async () => [],
} as unknown as DomainTaskStore

/** Shared InProcessOptions builder. */
const opts = () => ({
  store: fakeStore,
  daemon: makeFakeDaemon(),
  ctx: makeCtx(),
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow render', () => {
  it('(a) prints numbered steps with mode label in declaration order', async () => {
    writeWorkflow('simple', SIMPLE_WORKFLOW)

    const r = await runCommandInProcess(['workflow', 'render', 'simple'], opts())

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('1. setup  [auto]')
    expect(out).toContain('2. code  [auto]')
    // Declaration order: setup precedes code.
    expect(out.indexOf('1. setup')).toBeLessThan(out.indexOf('2. code'))
  })

  it('(b) --json emits a stable { kind, steps } schema', async () => {
    writeWorkflow('simple', SIMPLE_WORKFLOW)

    const r = await runCommandInProcess(
      ['workflow', 'render', 'simple', '--json'],
      opts(),
    )

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)

    const parsed = JSON.parse(r.out[0]!) as unknown
    expect(parsed).toMatchObject({
      kind: 'simple',
      steps: [
        { name: 'setup', mode: 'auto' },
        { name: 'code', mode: 'auto' },
      ],
    })
    // guide must be absent (not null) when there is no guide.
    const steps = (parsed as { steps: Array<Record<string, unknown>> }).steps
    expect(steps[0]).not.toHaveProperty('guide')
    expect(steps[1]).not.toHaveProperty('guide')
  })

  it('(c) missing workflow exits non-zero with validator error in stderr', async () => {
    // No workflow file written — 'no-such-kind-workflow.js' does not exist.
    const r = await runCommandInProcess(
      ['workflow', 'render', 'no-such-kind'],
      opts(),
    )

    expect(r.code).toBe(1)
    const stderr = r.err.join('\n')
    expect(stderr.length).toBeGreaterThan(0)
    // The validator message names the missing kind.
    expect(stderr).toContain('no-such-kind')
  })
})
