/**
 * One-shot script: adds the Definition-of-Done vocabulary terms to CONTEXT.md
 * using the same upsertTerm + writeGlossaryFile path the `mars glossary set`
 * command uses internally.  Run once from the orchestrator/ directory:
 *
 *   npx tsx scripts/add-dod-glossary-terms.ts
 */
import { readGlossaryFile, writeGlossaryFile, upsertTerm } from '../src/core/lib/glossary.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CONTEXT_PATH = resolve(__dirname, '../../CONTEXT.md')

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

let doc = await readGlossaryFile(CONTEXT_PATH)
for (const t of terms) {
  const existing = doc.terms.find((e) => e.term.toLowerCase() === t.term.toLowerCase())
  if (existing) {
    console.log(`skip (already present): ${t.term}`)
    continue
  }
  doc = upsertTerm(doc, t)
  console.log(`added: ${t.term}`)
}
await writeGlossaryFile(CONTEXT_PATH, doc)
console.log('done')
