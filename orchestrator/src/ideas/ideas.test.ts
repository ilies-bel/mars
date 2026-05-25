/**
 * Tracer-bullet tests for the idea store.
 *
 * Ideas are stored with a bare hex primary key and a slug column.
 * Every user-facing surface emits 'mars-idea-<hex>-<slug>' via the
 * MarsId value object — no call site outside the value object
 * constructs the prefix by string concatenation.
 *
 * Four input shapes are accepted by getIdea:
 *   1. Full rendered form   — mars-idea-<hex>-<slug>
 *   2. Prefix without slug  — mars-idea-<hex>
 *   3. Bare hex             — <hex> (8 chars)
 *   4. Hex prefix           — <hex-prefix> (e.g. 4 chars)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface IdeaStoreModule {
  addIdea: (text: string) => Promise<{ id: string; text: string; createdAt: number }>
  listIdeas: () => Promise<Array<{ id: string; text: string; createdAt: number }>>
  getIdea: (input: string) => Promise<{ id: string; text: string; createdAt: number } | null>
  initIdeas: () => Promise<void>
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ideas-store-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<IdeaStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const m = await import('./idea-store.js')
  await m.initIdeas()
  return m as unknown as IdeaStoreModule
}

describe('idea store — add + list', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('a freshly added idea appears in list output rendered as mars-idea-<hex>-<slug>', async () => {
    const m = await loadModule(repo)
    await m.addIdea('My first idea')
    const ideas = await m.listIdeas()
    expect(ideas).toHaveLength(1)
    expect(ideas[0].id).toMatch(/^mars-idea-[0-9a-f]{8}-[a-z0-9][a-z0-9-]*$/)
  })

  it('the rendered id contains a slug derived from the text', async () => {
    const m = await loadModule(repo)
    await m.addIdea('Hello World Idea')
    const ideas = await m.listIdeas()
    expect(ideas[0].id).toMatch(/^mars-idea-[0-9a-f]{8}-hello-world-idea$/)
  })

  it('list returns ideas ordered newest-first', async () => {
    const m = await loadModule(repo)
    await m.addIdea('First')
    await m.addIdea('Second')
    const ideas = await m.listIdeas()
    expect(ideas).toHaveLength(2)
    // Newest first — the second idea has a higher createdAt
    expect(ideas[0].id).toMatch(/second/)
    expect(ideas[1].id).toMatch(/first/)
  })

  it('list emits the rendered mars-idea- form, not bare hex', async () => {
    const m = await loadModule(repo)
    await m.addIdea('Some idea')
    const ideas = await m.listIdeas()
    expect(ideas[0].id).toMatch(/^mars-idea-/)
    expect(ideas[0].id).not.toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('idea store — getIdea across all four input shapes', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('resolves the idea by its full rendered form (mars-idea-<hex>-<slug>)', async () => {
    const m = await loadModule(repo)
    const added = await m.addIdea('Find me by full form')
    const found = await m.getIdea(added.id)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('resolves the idea by the prefix-without-slug form (mars-idea-<hex>)', async () => {
    const m = await loadModule(repo)
    const added = await m.addIdea('Find me by prefix no slug')
    // Extract the mars-idea-<hex> part (first two segments after splitting off slug)
    const withoutSlug = added.id.split('-').slice(0, 3).join('-')
    const found = await m.getIdea(withoutSlug)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('resolves the idea by bare hex (8-char hex, kind unknown)', async () => {
    const m = await loadModule(repo)
    const added = await m.addIdea('Find me by bare hex')
    // Extract the hex part: mars-idea-<hex>-<slug> → split → hex is index 2
    const hex = added.id.split('-')[2]
    expect(hex).toMatch(/^[0-9a-f]{8}$/)
    const found = await m.getIdea(hex)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('resolves the idea by a 4-char hex prefix (short prefix lookup)', async () => {
    const m = await loadModule(repo)
    const added = await m.addIdea('Find me by short prefix')
    const hex = added.id.split('-')[2]
    const shortPrefix = hex.slice(0, 4)
    const found = await m.getIdea(shortPrefix)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('returns null for an input that matches no idea', async () => {
    const m = await loadModule(repo)
    await m.addIdea('Some idea')
    const found = await m.getIdea('00000000')
    expect(found).toBeNull()
  })

  it('returns null for a malformed input', async () => {
    const m = await loadModule(repo)
    const found = await m.getIdea('not-a-valid-id-at-all-xyz')
    expect(found).toBeNull()
  })

  it('returned idea has the rendered id form even when looked up by bare hex', async () => {
    const m = await loadModule(repo)
    const added = await m.addIdea('Render check')
    const hex = added.id.split('-')[2]
    const found = await m.getIdea(hex)
    expect(found?.id).toMatch(/^mars-idea-[0-9a-f]{8}-/)
  })
})
