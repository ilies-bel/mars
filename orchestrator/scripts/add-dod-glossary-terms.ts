/**
 * One-shot script: adds the Definition-of-Done vocabulary terms to the knowledge
 * surface using the same writeGlossaryTerm path the `mars glossary set`
 * command uses internally.  Run once from the orchestrator/ directory:
 *
 *   npx tsx scripts/add-dod-glossary-terms.ts
 */
import { readGlossaryTerm, writeGlossaryTerm } from '../src/core/lib/glossary.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '../..')

const terms = [
  {
    term: 'Criterion',
    definition:
      'A single free-text outcome the agent must validate or waive before verify can pass.',
    aliases: [] as string[],
  },
  {
    term: 'validate',
    definition: "The agent's verb for marking a Criterion satisfied.",
    aliases: [] as string[],
  },
  {
    term: 'waive',
    definition: "The agent's verb for skipping a Criterion with a recorded reason.",
    aliases: [] as string[],
  },
]

for (const t of terms) {
  const existing = await readGlossaryTerm(REPO_ROOT, t.term)
  if (existing) {
    console.log(`skip (already present): ${t.term}`)
    continue
  }
  await writeGlossaryTerm(REPO_ROOT, t)
  console.log(`added: ${t.term}`)
}
console.log('done')
