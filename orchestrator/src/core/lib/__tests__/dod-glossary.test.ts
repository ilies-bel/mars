/**
 * Integration tests verifying that the Definition-of-Done vocabulary is
 * registered in the project knowledge-surface glossary.
 *
 * Each test reads the real glossary file through the same code path the
 * `mars glossary show` command uses, so the tests fail when a term is absent
 * and pass once it has been added via the glossary verb.
 */
import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readGlossaryTerm } from '../glossary'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '../../../../..')

describe('DoD vocabulary in project glossary', () => {
  it('glossary has a Tag entry describing an author-supplied label on a Task that materialises criteria', async () => {
    const term = await readGlossaryTerm(REPO_ROOT, 'tag')
    expect(term, 'Tag term should be registered in the knowledge surface').toBeDefined()
    expect(term!.definition.toLowerCase()).toMatch(/author.supplied label/)
    expect(term!.definition.toLowerCase()).toMatch(/criteria/)
  })

  it('glossary has a Definition of Done entry describing criteria a Task must satisfy before verify passes', async () => {
    const term = await readGlossaryTerm(REPO_ROOT, 'definition of done')
    expect(term, '"Definition of Done" term should be registered in the knowledge surface').toBeDefined()
    expect(term!.definition.toLowerCase()).toMatch(/criteria/)
    expect(term!.definition.toLowerCase()).toMatch(/verify/)
  })

  it('glossary has a Criterion entry describing a single free-text outcome the agent must validate or waive', async () => {
    const term = await readGlossaryTerm(REPO_ROOT, 'criterion')
    expect(term, 'Criterion term should be registered in the knowledge surface').toBeDefined()
    expect(term!.definition.toLowerCase()).toMatch(/single/)
    expect(term!.definition.toLowerCase()).toMatch(/validate|waive/)
  })

  it('glossary has a validate entry describing the agent verb for marking a criterion satisfied', async () => {
    const term = await readGlossaryTerm(REPO_ROOT, 'validate')
    expect(term, 'validate term should be registered in the knowledge surface').toBeDefined()
    expect(term!.definition.toLowerCase()).toMatch(/criterion/i)
    expect(term!.definition.toLowerCase()).toMatch(/satisfied/)
  })

  it('glossary has a waive entry describing the agent verb for skipping a criterion with a recorded reason', async () => {
    const term = await readGlossaryTerm(REPO_ROOT, 'waive')
    expect(term, 'waive term should be registered in the knowledge surface').toBeDefined()
    expect(term!.definition.toLowerCase()).toMatch(/criterion/i)
    expect(term!.definition.toLowerCase()).toMatch(/skip/)
    expect(term!.definition.toLowerCase()).toMatch(/reason/)
  })
})
