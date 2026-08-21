import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveCodeIndex } from '../core/ports/code-index/registry'
import type { CodeIndex } from '../core/ports/code-index/types'
import type { SliceSpec } from '../core/slice-spec'

export type SliceReferenceValidationResult = {
  missingSymbols: string[]
  missingReadFirstPaths: string[]
}

/**
 * Validates that every backtick-cited identifier in `prescriptiveAction` is
 * exported somewhere under the repo tree, and that every path listed in
 * `readFirst` exists on disk relative to `repoRoot`.
 *
 * Symbol extraction uses the same regex as `dropAlreadySatisfiedSlices` in
 * slice-workflow.ts so results stay consistent.
 *
 * Symbol resolution asks the `CodeIndex` Port first — resolved here, at this
 * call boundary, via `resolveCodeIndex` in
 * `../core/ports/code-index/registry.ts`, never by importing a concrete
 * implementation (e.g. `codegraph.ts`) directly. A symbol the index confirms
 * is real symbol data, so it skips the `rg` shell-out entirely. Symbols the
 * index does not know fall through to the `rg` existence check, which is the
 * validator's own file discovery.
 *
 * With the default `none` implementation — which always returns zero hits —
 * every symbol falls through to that `rg` check, so results are identical to
 * the pre-CodeIndex behaviour.
 *
 * @param codeIndex - Defaults to `resolveCodeIndex()` (the env-selected
 *   implementation); tests inject a stub directly.
 */
export async function validateSliceReferences(
  slice: Pick<SliceSpec, 'prescriptiveAction' | 'readFirst'>,
  repoRoot: string,
  codeIndex: CodeIndex = resolveCodeIndex(),
): Promise<SliceReferenceValidationResult> {
  // Extract backtick-delimited leading identifiers from prescriptiveAction.
  // Identical regex to dropAlreadySatisfiedSlices (slice-workflow.ts:829).
  const symbols = [
    ...new Set(
      [
        ...slice.prescriptiveAction.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]*)/g),
      ].map((m) => m[1]),
    ),
  ]

  const missingSymbols: string[] = []
  for (const sym of symbols) {
    // Real symbol data from the Port short-circuits the heuristic below.
    if ((await codeIndex.symbols({ term: sym, cwd: repoRoot })).length > 0) continue

    let found = false
    try {
      const result = spawnSync(
        'rg',
        ['-l', '--max-count', '1', `\\bexport\\b[^\\n]*\\b${sym}\\b`, repoRoot],
        { encoding: 'utf-8' },
      )
      found = result.status === 0 && result.stdout.trim() !== ''
    } catch {
      // swallow errors; treat as unresolved
    }
    if (!found) {
      missingSymbols.push(sym)
    }
  }

  const missingReadFirstPaths: string[] = []
  for (const p of slice.readFirst) {
    try {
      if (!existsSync(resolve(repoRoot, p))) {
        missingReadFirstPaths.push(p)
      }
    } catch {
      missingReadFirstPaths.push(p)
    }
  }

  return { missingSymbols, missingReadFirstPaths }
}
