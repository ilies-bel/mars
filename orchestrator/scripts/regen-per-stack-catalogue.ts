/*
 * MAINTAINER-ONLY.
 *
 * Regenerate the per-stack CLAUDE.md catalogue at
 * `src/init/templates/per-stack/`. Writes one `<supervisor-name>.md` file
 * per entry in `CATALOGUE_ENTRIES`, byte-identical across runs given the
 * same inputs.
 *
 * `mars init` reads from the committed catalogue and never invokes this
 * script. Re-run after upstream specialist content changes or after
 * adding a new supervisor name to `detect-stack.ts`.
 *
 * Usage: `npx tsx orchestrator/scripts/regen-per-stack-catalogue.ts`
 *
 * TODO: wire this script to `fetch-specialist` so each entry incorporates
 *   the upstream specialist body. The current implementation emits the
 *   deterministic placeholder body from `per-stack-catalogue.ts` so the
 *   first commit can land a complete, loadable catalogue.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATALOGUE_ENTRIES,
  generateCatalogueEntries,
} from '../src/init/per-stack-catalogue'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const catalogueDir = resolve(
  scriptDir,
  '..',
  'src',
  'init',
  'templates',
  'per-stack',
)

mkdirSync(catalogueDir, { recursive: true })

const entries = generateCatalogueEntries()
const written: string[] = []
for (const name of CATALOGUE_ENTRIES) {
  const body = entries.get(name)
  if (body === undefined) {
    throw new Error(`generator did not emit entry for '${name}'`)
  }
  const dest = resolve(catalogueDir, `${name}.md`)
  writeFileSync(dest, body, 'utf8')
  written.push(`${name}.md`)
}

process.stdout.write(
  `wrote ${written.length} catalogue entries to ${catalogueDir}\n`,
)
