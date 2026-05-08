import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface IdeasModule {
  createIdea: typeof import('./ideas').createIdea
  getIdea: typeof import('./ideas').getIdea
  resolveIdeaId: typeof import('./ideas').resolveIdeaId
  initIdeas: typeof import('./ideas').initIdeas
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ideas-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<IdeasModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./ideas')) as unknown as IdeasModule
}

const insertIdea = async (
  ideas: IdeasModule,
  id: string,
  goal: string,
): Promise<void> => {
  await ideas.initIdeas()
  // The createIdea path generates random ids; we need deterministic ids that
  // share a prefix, so insert directly via a fresh client.
  const { createClient } = await import('@libsql/client')
  const c = createClient({ url: `file:${process.env.MARS_REPO}/.mars/state.db` })
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO ideas (id, goal, story, technical, status, origin, created_at, updated_at)
          VALUES (?, ?, '', '', 'draft', 'user', ?, ?)`,
    args: [id, goal, now, now],
  })
  c.close()
}

describe('resolveIdeaId', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('exact-id lookup returns unique', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo idea')
    await insertIdea(ideas, 'abcd5678-bar', 'bar idea')

    const r = await ideas.resolveIdeaId('abcd1234-foo')
    expect(r).toEqual({ kind: 'unique', id: 'abcd1234-foo' })
  })

  it('unique-prefix lookup returns the row', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo idea')
    await insertIdea(ideas, 'wxyz9999-bar', 'bar idea')

    const r = await ideas.resolveIdeaId('abcd1234')
    expect(r).toEqual({ kind: 'unique', id: 'abcd1234-foo' })

    const idea = await ideas.getIdea('abcd1234')
    expect(idea?.id).toBe('abcd1234-foo')
    expect(idea?.goal).toBe('foo idea')
  })

  it('ambiguous prefix returns ambiguous with count', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1111-one', 'one')
    await insertIdea(ideas, 'abcd2222-two', 'two')
    await insertIdea(ideas, 'abcd3333-three', 'three')

    const r = await ideas.resolveIdeaId('abcd')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') {
      expect(r.count).toBe(3)
    }

    const idea = await ideas.getIdea('abcd')
    expect(idea).toBeNull()
  })

  it('non-matching prefix returns none', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')

    const r = await ideas.resolveIdeaId('zzzz9999')
    expect(r).toEqual({ kind: 'none' })

    const idea = await ideas.getIdea('zzzz9999')
    expect(idea).toBeNull()
  })

  it('prefix shorter than 4 chars returns none even if it would match', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')

    const r = await ideas.resolveIdeaId('abc')
    expect(r).toEqual({ kind: 'none' })
  })

  it('exact match wins even when shorter than the 4-char threshold', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'xy', 'two-char id')

    const r = await ideas.resolveIdeaId('xy')
    expect(r).toEqual({ kind: 'unique', id: 'xy' })
  })
})
