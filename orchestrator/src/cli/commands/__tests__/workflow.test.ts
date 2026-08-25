/**
 * Tests for the built-in pipeline guard in `mars workflow author`.
 *
 * `implement`, `triage`, `plan`, and `slice` are compiled TypeScript pipelines
 * bundled inside the orchestrator binary. Authoring a user-owned
 * .mars/workflows/<name>-workflow.js file would shadow the entire pipeline via
 * the loader's user-owned-first fallback, so `workflow author` must refuse
 * these names unconditionally with a clear error.
 *
 * Uses the in-process command seam (ADR-0023).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeNullStore = (): DomainTaskStore =>
  ({
    query: async () => ({ rows: [], columns: [] }),
    execute: async () => ({ rows: [], columns: [] }),
  }) as unknown as DomainTaskStore

const makeOpts = (repoRoot: string): InProcessOptions => {
  const stateDir = resolve(repoRoot, '.mars')
  mkdirSync(stateDir, { recursive: true })
  const ctx: OrchestratorContext = {
    repoRoot,
    stateDir,
  } as OrchestratorContext
  return {
    store: makeNullStore(),
    daemon: makeFakeDaemon(),
    ctx,
  }
}

/**
 * A lint-clean, engine-runnable body. Deliberately import-free so the dry-run
 * needs no `mars/workflow` resolution inside the temp repo.
 */
const VALID_BODY = [
  'export default {',
  "  id: 'my-custom',",
  '  async fn(ctx) {',
  "    await ctx.step('plan', async () => ({ ok: true }))",
  "    return ctx.step('wrap', async () => ({ done: true }))",
  '  },',
  '}',
  '',
].join('\n')

const writeBodyFile = (repoRoot: string, body: string): string => {
  const p = resolve(repoRoot, 'body.js.txt')
  writeFileSync(p, body)
  return p
}

const authorCommand = (
  repoRoot: string,
  name: string,
  opts: InProcessOptions,
): ReturnType<typeof runCommandInProcess> =>
  runCommandInProcess(
    ['workflow', 'author', name, '--from', writeBodyFile(repoRoot, VALID_BODY), '--author', 'agent:test'],
    opts,
  )

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-wf-builtin-guard-'))
  execFileSync('git', ['init', '-q'], { cwd: repoRoot })
  mkdirSync(resolve(repoRoot, '.mars'), { recursive: true })
  process.env.MARS_REPO = repoRoot
  vi.resetModules()
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repoRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Built-in pipeline guard
// ---------------------------------------------------------------------------

describe('workflowAuthor -- built-in pipeline guard', () => {
  it('refuses implement with exit code 1 and a message naming the compiled built-in conflict', async () => {
    const opts = makeOpts(repoRoot)
    const r = await authorCommand(repoRoot, 'implement', opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('compiled built-in')
    expect(existsSync(resolve(repoRoot, '.mars', 'workflows', 'implement-workflow.js'))).toBe(false)
  })

  it('refuses triage with exit code 1 and a message naming the compiled built-in conflict', async () => {
    const opts = makeOpts(repoRoot)
    const r = await authorCommand(repoRoot, 'triage', opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('compiled built-in')
    expect(existsSync(resolve(repoRoot, '.mars', 'workflows', 'triage-workflow.js'))).toBe(false)
  })

  it('refuses plan with exit code 1 and a message naming the compiled built-in conflict', async () => {
    const opts = makeOpts(repoRoot)
    const r = await authorCommand(repoRoot, 'plan', opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('compiled built-in')
    expect(existsSync(resolve(repoRoot, '.mars', 'workflows', 'plan-workflow.js'))).toBe(false)
  })

  it('refuses slice with exit code 1 and a message naming the compiled built-in conflict', async () => {
    const opts = makeOpts(repoRoot)
    const r = await authorCommand(repoRoot, 'slice', opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('compiled built-in')
    expect(existsSync(resolve(repoRoot, '.mars', 'workflows', 'slice-workflow.js'))).toBe(false)
  })

  it('does NOT refuse a novel name like my-custom (guard does not fire)', async () => {
    const opts = makeOpts(repoRoot)
    const r = await authorCommand(repoRoot, 'my-custom', opts)
    // The guard must not fire — the command may succeed or fail for other
    // reasons (e.g. lint or dry-run), but it must not fail with the
    // 'compiled built-in' message.
    expect(r.err.join('\n')).not.toContain('compiled built-in')
  })
})
