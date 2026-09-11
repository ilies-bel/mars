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
      ['task', 'note', 'mars-task-1234', `@${filePath}`, '--not-a-real-flag', 'x'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join(' ')).toContain('--not-a-real-flag')
  })
})

// ── proposal add ─────────────────────────────────────────────────────────────

describe('proposal add — @file goal input', () => {
  it('round-trips backticks, $(...), and newlines byte-identically via @file', async () => {
    // After daemon routing, the CLI's job is to pass the goal bytes to the
    // daemon intact — verify via daemon call params (no DB write in tests).
    const goal = 'support `mars task add` for $(cmd)\nmulti-line proposal title'
    const filePath = join(repo, 'goal.txt')
    writeFileSync(filePath, goal + '\n') // trailing newline stripped by resolvePromptSource
    const fake = makeFakeDaemon(() => ({ id: 'prop-prose-01' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    // The goal bytes — including backticks and $(...) — must arrive at the
    // daemon verbatim; no shell expansion should have occurred.
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { goal?: string }).goal).toBe(goal)
    expect(r.out.join('\n')).toContain('prop-prose-01')
  })

  it('round-trips content via stdin (-) without shell expansion', () => {
    const goal = 'support `proposal add` with $(stdin) input\nline two'
    const result = resolvePromptSource(['-'], {}, () => goal + '\n')
    expect(result).toEqual({ ok: true, value: goal })
  })

  it('inline short value still works unchanged', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'prop-prose-02' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add', 'short inline goal'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { goal?: string }).goal).toBe('short inline goal')
  })

  it('exits non-zero with no goal supplied', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('rejects an unrecognised flag instead of folding it into the goal', async () => {
    const filePath = join(repo, 'goal.txt')
    writeFileSync(filePath, 'goal from file')
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add', `@${filePath}`, '--not-a-real-flag', 'x'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(r.err.join(' ')).toContain('--not-a-real-flag')
    expect(fake.calls).toHaveLength(0)
  })

  it('accepts --title and forwards it as explicitTitle to the daemon', async () => {
    const fake = makeFakeDaemon(() => ({ id: 'prop-prose-03' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      [
        'proposal',
        'add',
        'this first line would normally become the title',
        '--title',
        'A deliberate title',
      ],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { explicitTitle?: string }).explicitTitle).toBe('A deliberate title')
    expect((fake.calls[0] as { goal?: string }).goal).toBe(
      'this first line would normally become the title',
    )
  })

  it('passes a leading # heading goal to the daemon verbatim (title extraction is daemon-side)', async () => {
    // The CLI no longer extracts headings — it forwards the raw goal bytes to
    // createProposal (via the daemon), which handles heading-based title parsing.
    const filePath = join(repo, 'heading-goal.txt')
    writeFileSync(filePath, '# Heading title\n\nbody text')
    const fake = makeFakeDaemon(() => ({ id: 'prop-prose-04' }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { goal?: string }).goal).toBe('# Heading title\n\nbody text')
  })

  it('rejects a leading @file followed by stray prose rather than folding it', async () => {
    const filePath = join(repo, 'goal.txt')
    writeFileSync(filePath, 'goal from file')
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const r = await runCommandInProcess(
      ['proposal', 'add', `@${filePath}`, 'stray', 'prose'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})

// ── resolvePromptSource — leading file/stdin token guard ─────────────────────

describe('resolvePromptSource — leading @file / - token guard', () => {
  it('rejects a leading @file token when further positionals follow', () => {
    const result = resolvePromptSource(['@/tmp/body.md', 'stray', 'words'], {})
    expect(result.ok).toBe(false)
  })

  it('rejects a leading - token when further positionals follow', () => {
    const result = resolvePromptSource(['-', 'stray'], {}, () => 'stdin body')
    expect(result.ok).toBe(false)
  })

  it('treats a mid-prose @mention as ordinary inline text', () => {
    const result = resolvePromptSource(['ping', '@alice', 'about', 'this'], {})
    expect(result).toEqual({ ok: true, value: 'ping @alice about this' })
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
      ['glossary', 'set', 'myterm', `@${filePath}`, '--not-a-real-flag', 'x'],
      { store, ctx, daemon: fake },
    )
    expect(r.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
    expect(r.err.join(' ')).toContain('--not-a-real-flag')
  })
})
