/**
 * Tracer-bullet tests for the proposal scratchpad store.
 *
 * Proposal notes are stored with a bare hex primary key and a slug column.
 * Every user-facing surface emits 'mars-proposal-<hex>-<slug>' via the
 * MarsId value object — no call site outside the value object
 * constructs the prefix by string concatenation.
 *
 * Four input shapes are accepted by getProposalNote:
 *   1. Full rendered form   — mars-proposal-<hex>-<slug>
 *   2. Prefix without slug  — mars-proposal-<hex>
 *   3. Bare hex             — <hex> (8 chars)
 *   4. Hex prefix           — <hex-prefix> (e.g. 4 chars)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ProposalNoteStoreModule {
  addProposalNote: (text: string) => Promise<{ id: string; text: string; createdAt: number }>
  listProposalNotes: () => Promise<Array<{ id: string; text: string; createdAt: number }>>
  getProposalNote: (input: string) => Promise<{ id: string; text: string; createdAt: number } | null>
  initProposalNotes: () => Promise<void>
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-notes-store-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ProposalNoteStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const m = await import('./idea-store.js')
  await m.initProposalNotes()
  return m as unknown as ProposalNoteStoreModule
}

describe('proposal scratchpad store — add + list', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('a freshly added note appears in list output rendered as mars-proposal-<hex>-<slug>', async () => {
    const m = await loadModule(repo)
    await m.addProposalNote('My first proposal')
    const notes = await m.listProposalNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toMatch(/^mars-proposal-[0-9a-f]{8}-[a-z0-9][a-z0-9-]*$/)
  })

  it('the rendered id contains a slug derived from the text', async () => {
    const m = await loadModule(repo)
    await m.addProposalNote('Hello World Proposal')
    const notes = await m.listProposalNotes()
    expect(notes[0].id).toMatch(/^mars-proposal-[0-9a-f]{8}-hello-world-proposal$/)
  })

  it('list returns notes ordered newest-first', async () => {
    const m = await loadModule(repo)
    await m.addProposalNote('First')
    await m.addProposalNote('Second')
    const notes = await m.listProposalNotes()
    expect(notes).toHaveLength(2)
    // Newest first — the second note has a higher createdAt
    expect(notes[0].id).toMatch(/second/)
    expect(notes[1].id).toMatch(/first/)
  })

  it('list emits the rendered mars-proposal- form, not bare hex', async () => {
    const m = await loadModule(repo)
    await m.addProposalNote('Some proposal')
    const notes = await m.listProposalNotes()
    expect(notes[0].id).toMatch(/^mars-proposal-/)
    expect(notes[0].id).not.toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('proposal scratchpad store — getProposalNote across all four input shapes', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('resolves the note by its full rendered form (mars-proposal-<hex>-<slug>)', async () => {
    const m = await loadModule(repo)
    const added = await m.addProposalNote('Find me by full form')
    const found = await m.getProposalNote(added.id)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('resolves the note by the prefix-without-slug form (mars-proposal-<hex>)', async () => {
    const m = await loadModule(repo)
    const added = await m.addProposalNote('Find me by prefix no slug')
    // Extract the mars-proposal-<hex> part (first three segments)
    const withoutSlug = added.id.split('-').slice(0, 3).join('-')
    const found = await m.getProposalNote(withoutSlug)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('resolves the note by bare hex (8-char hex, kind unknown)', async () => {
    const m = await loadModule(repo)
    const added = await m.addProposalNote('Find me by bare hex')
    // Extract the hex part: mars-proposal-<hex>-<slug> → split → hex is index 2
    const hex = added.id.split('-')[2]
    expect(hex).toMatch(/^[0-9a-f]{8}$/)
    const found = await m.getProposalNote(hex)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('resolves the note by a 4-char hex prefix (short prefix lookup)', async () => {
    const m = await loadModule(repo)
    const added = await m.addProposalNote('Find me by short prefix')
    const hex = added.id.split('-')[2]
    const shortPrefix = hex.slice(0, 4)
    const found = await m.getProposalNote(shortPrefix)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(added.id)
  })

  it('returns null for an input that matches no note', async () => {
    const m = await loadModule(repo)
    await m.addProposalNote('Some proposal')
    const found = await m.getProposalNote('00000000')
    expect(found).toBeNull()
  })

  it('returns null for a malformed input', async () => {
    const m = await loadModule(repo)
    const found = await m.getProposalNote('not-a-valid-id-at-all-xyz')
    expect(found).toBeNull()
  })

  it('returned note has the rendered id form even when looked up by bare hex', async () => {
    const m = await loadModule(repo)
    const added = await m.addProposalNote('Render check')
    const hex = added.id.split('-')[2]
    const found = await m.getProposalNote(hex)
    expect(found?.id).toMatch(/^mars-proposal-[0-9a-f]{8}-/)
  })
})
