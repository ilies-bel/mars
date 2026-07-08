/**
 * Tests for the self-authored-workflow write path (ADR-0068):
 *
 *   `mars workflow author <name> --from <path>`  →  agent draft on disk
 *   `mars workflow approve <name>`               →  operator-privileged custom
 *
 * Pinned behaviours:
 *   1. author is create-only — refuses existing files AND reserved bundled kinds;
 *   2. a landed draft is NOT dispatch-eligible: `loadWorkflowByName` throws a
 *      pending-approval WorkflowLoadError (ADR-0067 no-fallback preserved);
 *   3. the static lint rejects a malformed body BEFORE anything executes, and
 *      nothing lands on disk;
 *   4. a lint-clean body that fails the validate dry-run also never lands;
 *   5. approve strips the draft marker (author marker preserved), flips the
 *      `workflow list` provenance agent-draft → custom, makes the name
 *      dispatchable, and supersedes the action-queue review row.
 *
 * Uses the in-process command seam (ADR-0023). The action-queue state DB is
 * pointed at the temp repo via MARS_REPO + vi.resetModules(), mirroring
 * core/lib/action-queue.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import {
  WORKFLOW_AUTHOR_MARKER_PREFIX,
  WORKFLOW_DRAFT_MARKER,
} from '../../workflows/agent-draft'

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
 * A lint-clean, engine-runnable body. Deliberately import-free (the plain
 * `{ id, fn }` shape) so the dry-run needs no `mars/workflow` resolution
 * inside the temp repo — the same trick reload-workflow.test.ts uses.
 */
const VALID_BODY = [
  'export default {',
  "  id: 'qa-loop',",
  '  async fn(ctx) {',
  "    await ctx.step('plan', async () => ({ ok: true }))",
  "    return ctx.step('wrap', async () => ({ done: true }))",
  '  },',
  '}',
  '',
].join('\n')

/** Fails the static lint: imports outside mars/workflow. */
const LINT_REJECTED_BODY = [
  "import { readFileSync } from 'node:fs'",
  'export default {',
  "  id: 'evil',",
  '  async fn(ctx) {',
  "    await ctx.step('x', async () => ({}))",
  '  },',
  '}',
  '',
].join('\n')

/** Lint-clean but fails the dry-run: the fn declares no steps. */
const NO_STEPS_BODY = "export default { id: 'nosteps', async fn() { return {} } }\n"

const writeBodyFile = (repoRoot: string, body: string): string => {
  const p = resolve(repoRoot, 'body.js.txt')
  writeFileSync(p, body)
  return p
}

const workflowFilePath = (repoRoot: string, name: string): string =>
  resolve(repoRoot, '.mars', 'workflows', `${name}-workflow.js`)

const author = async (
  repoRoot: string,
  opts: InProcessOptions,
  name: string,
  body: string,
): Promise<ReturnType<typeof runCommandInProcess>> =>
  runCommandInProcess(
    ['workflow', 'author', name, '--from', writeBodyFile(repoRoot, body), '--author', 'agent:test'],
    opts,
  )

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-wf-author-'))
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
// 1. Create-only
// ---------------------------------------------------------------------------

describe('mars workflow author — create-only', () => {
  it('refuses to overwrite an existing workflow file', async () => {
    const opts = makeOpts(repoRoot)
    const target = workflowFilePath(repoRoot, 'qa-loop')
    mkdirSync(resolve(repoRoot, '.mars', 'workflows'), { recursive: true })
    writeFileSync(target, '// operator-owned content\nexport default {}\n')

    const r = await author(repoRoot, opts, 'qa-loop', VALID_BODY)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('create-only')
    // The pre-existing file is untouched.
    expect(readFileSync(target, 'utf8')).toContain('operator-owned content')
  })

  it('refuses reserved bundled kinds even when no file is on disk (never rewire task/fix/live)', async () => {
    const opts = makeOpts(repoRoot)
    const r = await author(repoRoot, opts, 'task', VALID_BODY)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('reserved bundled workflow kind')
    expect(existsSync(workflowFilePath(repoRoot, 'task'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Static lint gate (pre-execution)
// ---------------------------------------------------------------------------

describe('mars workflow author — static lint gate', () => {
  it('rejects a malformed body and nothing lands on disk', async () => {
    const opts = makeOpts(repoRoot)
    const r = await author(repoRoot, opts, 'evil-flow', LINT_REJECTED_BODY)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('static lint failed')
    expect(r.err.join('\n')).toContain("'node:fs' is not allowed")
    expect(existsSync(workflowFilePath(repoRoot, 'evil-flow'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Dry-run gate
// ---------------------------------------------------------------------------

describe('mars workflow author — validate dry-run gate', () => {
  it('rejects a lint-clean body that declares no steps; nothing lands, no probe leaks', async () => {
    const opts = makeOpts(repoRoot)
    const r = await author(repoRoot, opts, 'nosteps', NO_STEPS_BODY)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('nothing was written')
    expect(r.err.join('\n')).toContain('declared no steps')
    expect(existsSync(workflowFilePath(repoRoot, 'nosteps'))).toBe(false)
    // The dry-run probe file must not survive.
    const leftover = readdirSync(resolve(repoRoot, '.mars', 'workflows'))
    expect(leftover.filter((f) => f.includes('author-probe'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Happy path: draft lands, provenance visible, NOT dispatchable
// ---------------------------------------------------------------------------

describe('mars workflow author — agent draft lifecycle', () => {
  it('lands a stamped draft, lists it as agent-draft (pending approval), and raises the review row', async () => {
    const opts = makeOpts(repoRoot)
    const r = await author(repoRoot, opts, 'qa-loop', VALID_BODY)
    expect(r.err).toEqual([])
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('agent draft created')
    expect(r.out.join('\n')).toContain('mars workflow approve qa-loop')

    // Stamped provenance header on disk.
    const source = readFileSync(workflowFilePath(repoRoot, 'qa-loop'), 'utf8')
    expect(source).toContain(`${WORKFLOW_AUTHOR_MARKER_PREFIX} agent:test`)
    expect(source).toContain(WORKFLOW_DRAFT_MARKER)

    // `workflow list` shows the new provenance source.
    const list = await runCommandInProcess(['workflow', 'list'], opts)
    expect(list.code).toBe(0)
    expect(list.out.join('\n')).toContain('agent-draft (pending approval)')

    // The level-triggered action-queue review row exists (ADR-0048).
    const aq = await import('../../core/lib/action-queue')
    const open = await aq.listActionQueueItems('open')
    const row = open.find((i) => i.kind === 'workflow-draft-pending')
    expect(row).toBeDefined()
    expect(row!.signature).toBe('qa-loop')
    expect(row!.body).toContain('Declared runbook')
    expect(row!.body).toContain('Raw JS')
  })

  it('a pending draft is NOT dispatch-eligible: loadWorkflowByName throws pending-approval (no fallback)', async () => {
    const opts = makeOpts(repoRoot)
    const r = await author(repoRoot, opts, 'qa-loop', VALID_BODY)
    expect(r.code).toBe(0)

    const { loadWorkflowByName, isWorkflowLoadError } = await import(
      '../../workflows/queue-workflow-store'
    )
    let thrown: unknown = null
    try {
      await loadWorkflowByName('qa-loop', repoRoot)
    } catch (err) {
      thrown = err
    }
    expect(thrown).not.toBeNull()
    expect(isWorkflowLoadError(thrown)).toBe(true)
    expect((thrown as Error).message).toContain('pending approval')
    expect((thrown as Error).message).toContain('mars workflow approve qa-loop')
  })
})

// ---------------------------------------------------------------------------
// 5. Approve: provenance flips, dispatchable, review row superseded
// ---------------------------------------------------------------------------

describe('mars workflow approve', () => {
  it('flips agent-draft → custom, preserves the author marker, and makes the name dispatchable', async () => {
    const opts = makeOpts(repoRoot)
    expect((await author(repoRoot, opts, 'qa-loop', VALID_BODY)).code).toBe(0)

    const approve = await runCommandInProcess(['workflow', 'approve', 'qa-loop'], opts)
    expect(approve.err).toEqual([])
    expect(approve.code).toBe(0)
    expect(approve.out.join('\n')).toContain('approved:')

    // Draft marker gone; author marker preserved for audit.
    const source = readFileSync(workflowFilePath(repoRoot, 'qa-loop'), 'utf8')
    expect(source).not.toContain(WORKFLOW_DRAFT_MARKER)
    expect(source).toContain(`${WORKFLOW_AUTHOR_MARKER_PREFIX} agent:test`)

    // Provenance now reads as an ordinary user-owned custom workflow.
    const list = await runCommandInProcess(['workflow', 'list'], opts)
    expect(list.out.join('\n')).not.toContain('agent-draft')
    expect(list.out.join('\n')).toContain('custom')

    // Dispatch loader accepts it now.
    const { loadWorkflowByName } = await import('../../workflows/queue-workflow-store')
    const wf = await loadWorkflowByName('qa-loop', repoRoot)
    expect(wf.id).toBe('qa-loop')

    // The review row was superseded (level cleared).
    const aq = await import('../../core/lib/action-queue')
    const open = await aq.listActionQueueItems('open')
    expect(open.filter((i) => i.kind === 'workflow-draft-pending')).toEqual([])
    const all = await aq.listActionQueueItems('all')
    const resolved = all.find((i) => i.kind === 'workflow-draft-pending')
    expect(resolved).toBeDefined()
    expect(resolved!.state).toBe('resolved')
    expect(resolved!.resolutionNote).toContain('workflow-approved')
  })

  it('refuses to approve a file that is not a pending agent draft', async () => {
    const opts = makeOpts(repoRoot)
    mkdirSync(resolve(repoRoot, '.mars', 'workflows'), { recursive: true })
    writeFileSync(workflowFilePath(repoRoot, 'handmade'), VALID_BODY)

    const r = await runCommandInProcess(['workflow', 'approve', 'handmade'], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not a pending agent draft')
  })

  it('refuses to approve a name with no workflow file', async () => {
    const opts = makeOpts(repoRoot)
    const r = await runCommandInProcess(['workflow', 'approve', 'ghost'], opts)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain("no workflow file for 'ghost'")
  })
})
