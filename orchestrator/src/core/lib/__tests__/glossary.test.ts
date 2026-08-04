import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeTermKey,
  generateDefaultSurfaceForms,
  glossaryTermFilename,
  listGlossaryTerms,
  readGlossaryTerm,
  removeGlossaryTerm,
  writeGlossaryTerm,
} from '../glossary'

const roots: string[] = []
const repo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'mars-glossary-'))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))) })

describe('sharded glossary', () => {
  it('stores and reads a term through its canonical key', async () => {
    const root = await repo()
    await writeGlossaryTerm(root, { term: 'Order', definition: 'A request to purchase.', aliases: ['Purchase'], surfaceForms: ['order', 'orders', 'ordering'] })
    await expect(readGlossaryTerm(root, ' order ')).resolves.toEqual({ term: 'Order', definition: 'A request to purchase.', aliases: ['Purchase'], surfaceForms: ['order', 'orders', 'ordering'] })
  })

  it('uses readable collision-resistant filenames for distinct normalised terms', () => {
    expect(canonicalizeTermKey('  ORDER ')).toBe('order')
    expect(glossaryTermFilename('Order')).toMatch(/^order-[a-f0-9]{12}\.md$/)
    expect(glossaryTermFilename('Order')).not.toBe(glossaryTermFilename('Order!'))
  })

  it('lists every term and retains avoid aliases and default surface forms', async () => {
    const root = await repo()
    await writeGlossaryTerm(root, { term: 'Task', definition: 'A unit of work.', aliases: [] })
    await writeGlossaryTerm(root, { term: 'Arc', definition: 'An origin tree.', aliases: ['Chain'] })
    await expect(listGlossaryTerms(root)).resolves.toEqual([
      { term: 'Arc', definition: 'An origin tree.', aliases: ['Chain'], surfaceForms: ['arc', 'arcs'] },
      { term: 'Task', definition: 'A unit of work.', aliases: [], surfaceForms: ['task', 'tasks'] },
    ])
  })

  it('replaces and removes only the selected term file', async () => {
    const root = await repo()
    await writeGlossaryTerm(root, { term: 'Task', definition: 'Old.', aliases: [] })
    await writeGlossaryTerm(root, { term: 'Arc', definition: 'Untouched.', aliases: [] })
    await writeGlossaryTerm(root, { term: 'task', definition: 'New.', aliases: ['Job'] })
    expect((await readGlossaryTerm(root, 'Task'))?.definition).toBe('New.')
    expect((await readGlossaryTerm(root, 'Arc'))?.definition).toBe('Untouched.')
    expect(await removeGlossaryTerm(root, 'Task')).toBe(true)
    expect(await removeGlossaryTerm(root, 'Task')).toBe(false)
    await expect(readGlossaryTerm(root, 'Arc')).resolves.toMatchObject({ definition: 'Untouched.' })
  })

  it('writes a human-readable markdown term atomically', async () => {
    const root = await repo()
    await writeGlossaryTerm(root, { term: 'Category', definition: 'A grouping.', aliases: ['Group'] })
    const filename = glossaryTermFilename('Category')
    const markdown = await readFile(join(root, 'docs/knowledge/glossary', filename), 'utf8')
    expect(markdown).toBe('# Category\n\nA grouping.\n\n_Avoid_: Group\n')
    expect(await readdir(join(root, 'docs/knowledge/glossary'))).toEqual([filename])
  })
})

describe('generateDefaultSurfaceForms', () => {
  it('produces expected regular and y-ending plurals', () => {
    expect(generateDefaultSurfaceForms('Order')).toEqual(['order', 'orders'])
    expect(generateDefaultSurfaceForms('Category')).toEqual(['category', 'categories'])
  })
})
