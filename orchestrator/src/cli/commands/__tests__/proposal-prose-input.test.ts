/**
 * Tests that `proposal set` and `proposal add-user-story` honour all three
 * input shapes for their prose-body arguments:
 *
 *   - "<text>"  — inline positional, stored verbatim
 *   - @<file>   — reads the file (one trailing newline stripped)
 *   - -         — reads stdin (one trailing newline stripped; never stores "-")
 *
 * The stdin shape is tested at the resolvePromptSource level to avoid blocking
 * on real fd 0; inline and @<file> exercise the full command path via
 * runCommandInProcess. This mirrors the pattern used in prose-input.test.ts
 * for `task note`, `proposal add`, and `glossary set`.
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
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-set-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(join(dir, '.mars'), { recursive: true })
  return dir
}

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

// ── proposal set — inline text ────────────────────────────────────────────────

describe('proposal set — inline "<text>"', () => {
  it('sends a multi-word inline value verbatim to the daemon', async () => {
    // After daemon routing: verify the value bytes arrive at daemon intact.
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const result = await runCommandInProcess(
      ['proposal', 'set', 'prop-set-01', 'notes', 'plain inline notes text'],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      op: 'proposal.setField',
      proposalId: 'prop-set-01',
      field: 'notes',
      value: 'plain inline notes text',
    })
  })

  it('sends content containing backticks verbatim to the daemon', async () => {
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const result = await runCommandInProcess(
      ['proposal', 'set', 'prop-set-02', 'notes', 'use `mars proposal set` to update'],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { value?: string }).value).toBe('use `mars proposal set` to update')
  })

  it('exits non-zero when no value is supplied', async () => {
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const result = await runCommandInProcess(
      ['proposal', 'set', 'prop-set-03', 'notes'],
      { store, ctx, daemon: fake },
    )
    expect(result.code).not.toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})

// ── proposal set — @<file> input ──────────────────────────────────────────────

describe('proposal set — @<file>', () => {
  it('reads the file and sends its contents to the daemon (one trailing newline stripped)', async () => {
    // After daemon routing: the CLI reads the file via resolvePromptSource and
    // forwards the content as `value` in the daemon request — verify the bytes.
    const fake = makeFakeDaemon(() => ({}))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const body = 'multi-line notes\nwith `backticks` and $(expansions)\nthird line'
    const filePath = join(repo, 'notes.txt')
    writeFileSync(filePath, body + '\n') // trailing newline stripped by resolvePromptSource

    const result = await runCommandInProcess(
      ['proposal', 'set', 'prop-set-04', 'notes', `@${filePath}`],
      { store, ctx, daemon: fake },
    )

    expect(result.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { value?: string }).value).toBe(body)
  })

  it('stores the @<path> reference verbatim in the NOT-file-expanded status field', async () => {
    // status is never file-expanded; passing an @path as status hits LOCAL
    // validation before the daemon is called (PROPOSAL_STATUSES check).
    const fake = makeFakeDaemon()
    const { store, ctx, runCommandInProcess } = await freshModules()
    const result = await runCommandInProcess(
      ['proposal', 'set', 'prop-set-05', 'status', '@/nonexistent/path.txt'],
      { store, ctx, daemon: fake },
    )
    // Local validation rejects '@/nonexistent/path.txt' as an invalid status —
    // no file read was attempted and the daemon was never called.
    expect(result.code).toBe(1)
    expect(fake.calls).toHaveLength(0)
    expect(result.err.join('\n')).toMatch(/invalid.*status/i)
  })
})

// ── proposal set — stdin (-) input ────────────────────────────────────────────

describe('proposal set — stdin (-)', () => {
  it('reads stdin content when - is passed, not the literal string -', () => {
    // runCommandInProcess cannot inject a custom stdin reader, so this is tested
    // at the resolvePromptSource level — the same approach prose-input.test.ts
    // uses for task note, proposal add, and glossary set.
    const body = 'stdin notes with `backticks` and $(expansions)\nsecond line'
    const result = resolvePromptSource(['-'], {}, () => body + '\n')
    expect(result).toEqual({ ok: true, value: body })
  })

  it('never stores the bare sentinel string "-" as field content', () => {
    // A bare '-' always triggers stdin reading; the literal "-" is unreachable
    // as a stored value. Verify that the contract holds at the integration point.
    const result = resolvePromptSource(['-'], {}, () => 'stdin notes\n')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe('stdin notes')
      expect(result.value).not.toBe('-')
    }
  })
})

// ── proposal add-user-story — input shapes ────────────────────────────────────

describe('proposal add-user-story — inline "<text>"', () => {
  it('sends a multi-word inline story verbatim to the daemon', async () => {
    // After daemon routing: verify story bytes reach the daemon intact.
    const fake = makeFakeDaemon(() => ({ userStories: ['As a user I can save my work'] }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const result = await runCommandInProcess(
      ['proposal', 'add-user-story', 'prop-story-01', 'As a user I can save my work'],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      op: 'proposal.addUserStory',
      proposalId: 'prop-story-01',
      story: 'As a user I can save my work',
    })
  })
})

describe('proposal add-user-story — @<file>', () => {
  it('reads the file and sends its contents as the story to the daemon (trailing newline stripped)', async () => {
    const storyText = 'As a user, I can `export` my $(data) without shell expansion'
    const filePath = join(repo, 'story.txt')
    writeFileSync(filePath, storyText + '\n') // trailing newline stripped by resolvePromptSource
    const fake = makeFakeDaemon(() => ({ userStories: [storyText] }))
    const { store, ctx, runCommandInProcess } = await freshModules()
    const result = await runCommandInProcess(
      ['proposal', 'add-user-story', 'prop-story-02', `@${filePath}`],
      { store, ctx, daemon: fake },
    )
    expect(result.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { story?: string }).story).toBe(storyText)
  })
})

describe('proposal add-user-story — stdin (-)', () => {
  it('reads stdin content when - is passed, not the literal string -', () => {
    const story = 'As a user, I can pass stdin content\nwith multiple lines'
    const result = resolvePromptSource(['-'], {}, () => story + '\n')
    expect(result).toEqual({ ok: true, value: story })
    if (result.ok) expect(result.value).not.toBe('-')
  })
})
