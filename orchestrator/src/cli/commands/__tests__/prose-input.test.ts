/**
 * Tests that `task note`, `proposal add`, and `glossary set` accept `@<file>`
 * and `-` (stdin) in addition to inline text, and that a body containing
 * shell-special characters (backticks, `$(...)`, newlines) round-trips
 * byte-identically through the file path.
 *
 * These three commands previously accepted an inline string only, which made
 * them susceptible to silent shell corruption (backtick command-substitution
 * strips content before the CLI ever starts). The fix: the body argument now
 * honours the same `@<path>` / `-` convention as `task add` and `adr add`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolvePromptSource } from '../../args'
import { makeFakeDaemon } from '../../test-adapter'
import type { InProcessOptions } from '../../test-adapter'

let repo: string
let dbModule: typeof import('../../../core/lib/db') | null = null

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-prose-input-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(join(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Resets modules and re-imports everything fresh.
 * Returns a fresh store, ctx, and the runCommandInProcess function bound to
 * the same module graph (so commands, DB client, and store all share state).
 */
const freshModules = async () => {
  if (dbModule) {
    await dbModule.__resetDbRegistryForTests()
    dbModule = null
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  dbModule = await import('../../../core/lib/db')
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const { initProposals } = await import('../../../core/proposals')
  await initProposals()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  const store = storeModule.createTaskStore(queueModule.resolveQueueClient())
  const ctx = contextModule.resolveContext(repo)
  // Import test-adapter AFTER vi.resetModules so it picks up the fresh
  // command registry (which in turn picks up the fresh proposals module).
  const { runCommandInProcess } = await import('../../test-adapter')
  return { store, ctx, runCommandInProcess }
}

beforeEach(() => {
  repo = setupRepo()
})

afterEach(async () => {
  if (dbModule) {
    await dbModule.__resetDbRegistryForTests()
    dbModule = null
  }
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ── task note ────────────────────────────────────────────────────────────────

describe('task note — @file body input', () => {
  it('round-trips backticks, $(...), and newlines byte-identically via @file', async () => {
    const body = 'fix `task add` and $(cmd) expansion\nsecond line of note'
    const filePath = join(repo, 'note.txt')
    writeFileSync(filePath, body)
    const fake = makeFakeDaemon(() => ({ id: 'note-abc' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['task', 'note', 'mars-task-1234', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { body?: string }).body).toBe(body)
  })

  it('round-trips content via stdin (-) without shell expansion', () => {
    // Tested at the resolvePromptSource level to avoid blocking on real fd 0.
    const body = 'fix `task add` and $(cmd) expansion\nsecond line'
    const result = resolvePromptSource(['-'], {}, () => body + '\n')
    expect(result).toEqual({ ok: true, value: body })
  })

  it('inline short value still works unchanged', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'note-abc' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['task', 'note', 'mars-task-1234', 'short progress note'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { body?: string }).body).toBe('short progress note')
  })

  it('exits non-zero with no body supplied', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'note-abc' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['task', 'note', 'mars-task-1234'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects an unrecognised flag instead of folding it into the body', async () => {
    const filePath = join(repo, 'note.txt')
    writeFileSync(filePath, 'note body')
    const fake = makeFakeDaemon(() => ({ id: 'note-abc' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['task', 'note', 'mars-task-1234', `@${filePath}`, '--title', 'x'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join(' ')).toContain('--title')
  })
})

// ── proposal add ─────────────────────────────────────────────────────────────

describe('proposal add — @file goal input', () => {
  it('round-trips backticks, $(...), and newlines byte-identically via @file', async () => {
    const goal = 'support `mars task add` for $(cmd)\nmulti-line proposal title'
    const filePath = join(repo, 'goal.txt')
    writeFileSync(filePath, goal + '\n') // trailing newline stripped by resolvePromptSource
    const { store, ctx, runCommandInProcess } = await freshModules()
    const { getProposal } = await import('../../../core/proposals')
    const r = await runCommandInProcess(
      ['proposal', 'add', `@${filePath}`],
      { store, ctx, daemon: makeFakeDaemon() },
    )
    expect(r.code).toBe(0)
    // Output format: "<id> (author: ...)" — extract the id to verify DB content.
    const proposalId = r.out[0]?.split(' ')[0]
    expect(proposalId).toBeTruthy()
    const proposal = await getProposal(proposalId!)
    // `createProposal` splits incoming prose into a short title + body, so the
    // goal no longer lands wholesale in `title`. What this test guards is
    // unchanged: nothing is shell-expanded and nothing is lost — the backticks
    // and `$(...)` survive verbatim and the two halves recombine into the
    // original bytes.
    expect(proposal?.title).toBe('support `mars task add` for $(cmd)')
    expect(proposal?.problem).toBe('multi-line proposal title')
    expect(`${proposal?.title}\n${proposal?.problem}`).toBe(goal)
  })

  it('round-trips content via stdin (-) without shell expansion', () => {
    const goal = 'support `proposal add` with $(stdin) input\nline two'
    const result = resolvePromptSource(['-'], {}, () => goal + '\n')
    expect(result).toEqual({ ok: true, value: goal })
  })

  it('inline short value still works unchanged', async () => {
    const { store, ctx, runCommandInProcess } = await freshModules()
    const { getProposal } = await import('../../../core/proposals')
    const r = await runCommandInProcess(
      ['proposal', 'add', 'short inline goal'],
      { store, ctx, daemon: makeFakeDaemon() },
    )
    expect(r.code).toBe(0)
    const proposalId = r.out[0]?.split(' ')[0]
    const proposal = await getProposal(proposalId!)
    expect(proposal?.title).toBe('short inline goal')
  })

  it('exits non-zero with no goal supplied', async () => {
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add'],
      { store, ctx, daemon: makeFakeDaemon() },
    )
    expect(r.code).not.toBe(0)
  })

  it('rejects an unrecognised flag instead of folding it into the goal', async () => {
    const filePath = join(repo, 'goal.txt')
    writeFileSync(filePath, 'goal from file')
    const { store, ctx, runCommandInProcess } = await freshModules()
    const { listProposals } = await import('../../../core/proposals')
    const r = await runCommandInProcess(
      ['proposal', 'add', `@${filePath}`, '--title', 'x'],
      { store, ctx, daemon: makeFakeDaemon() },
    )
    expect(r.code).not.toBe(0)
    expect(r.err.join(' ')).toContain('--title')
    expect(await listProposals()).toHaveLength(0)
  })
})

// ── glossary set ─────────────────────────────────────────────────────────────

describe('glossary set — @file definition input', () => {
  it('round-trips backticks, $(...), and newlines byte-identically via @file', async () => {
    const definition =
      'the `glossary set` command writes to CONTEXT.md via $(daemon)\ncontinued on next line'
    const filePath = join(repo, 'def.txt')
    writeFileSync(filePath, definition + '\n')
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['glossary', 'set', 'myterm', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { definition?: string }).definition).toBe(definition)
  })

  it('round-trips content via stdin (-) without shell expansion', () => {
    const definition = 'the `term` is $(special)\nwith newlines'
    const result = resolvePromptSource(['-'], {}, () => definition + '\n')
    expect(result).toEqual({ ok: true, value: definition })
  })

  it('inline short definition still works unchanged', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['glossary', 'set', 'myterm', 'short inline definition'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect((fake.calls[0] as { definition?: string }).definition).toBe('short inline definition')
  })

  it('exits non-zero with no definition supplied', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['glossary', 'set', 'myterm'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects an unrecognised flag instead of folding it into the definition', async () => {
    const filePath = join(repo, 'def.txt')
    writeFileSync(filePath, 'definition from file')
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['glossary', 'set', 'myterm', `@${filePath}`, '--title', 'x'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join(' ')).toContain('--title')
  })
})
