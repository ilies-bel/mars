/**
 * `mars init` step that writes one consumer-owned markdown file per
 * built-in recovery recipe into `.mars/recipes/`.
 *
 * Semantics:
 *  - No-overwrite. If the target file already exists, leave it untouched —
 *    the consumer owns the file once it lands. A future binary that ships
 *    new built-in recipes will land only the missing files on re-`init`.
 *  - The file body is the built-in markdown verbatim (frontmatter + body
 *    bytes), copied straight from the shipped seed. We do NOT round-trip
 *    through Zod here — the consumer's first edit should see exactly what
 *    the binary shipped.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  listBuiltInRecipeFiles,
  recipesDir,
} from '../mastra/lib/recipes'

/** Result of seeding the override directory. */
export interface RecipesSeedResult {
  /** Absolute path of the override directory. */
  dir: string
  /** Filenames written on this run (consumer-owned thereafter). */
  written: string[]
  /** Filenames that already existed — preserved as-is. */
  skipped: string[]
}

/**
 * Write seed markdown files for every shipped built-in recipe into
 * `<stateDir>/recipes/`. Idempotent: existing files are preserved, new
 * files are written. Returns the breakdown for the caller to log.
 */
export const writeRecipesSeed = (stateDir: string): RecipesSeedResult => {
  const dir = recipesDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const skipped: string[] = []
  for (const entry of listBuiltInRecipeFiles()) {
    const filename = `${entry.name}.md`
    const abs = resolve(dir, filename)
    if (existsSync(abs)) {
      skipped.push(filename)
      continue
    }
    writeFileSync(abs, entry.contents, 'utf8')
    written.push(filename)
  }
  return { dir, written, skipped }
}
