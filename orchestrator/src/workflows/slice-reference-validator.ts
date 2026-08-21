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
 * Extract backtick-delimited leading identifiers from `prescriptiveAction`.
 * Identical regex to `dropAlreadySatisfiedSlices` in slice-workflow.ts, so
 * results stay consistent between the two.
 */
function extractCitedSymbols(prescriptiveAction: string): string[] {
  return [
    ...new Set(
      [...prescriptiveAction.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]*)/g)].map((m) => m[1]),
    ),
  ]
}

/** `rg`-based existence check: does any file under `repoRoot` export `sym`? */
function checkSymbolViaRg(sym: string, repoRoot: string): boolean {
  try {
    const result = spawnSync(
      'rg',
      ['-l', '--max-count', '1', `\\bexport\\b[^\\n]*\\b${sym}\\b`, repoRoot],
      { encoding: 'utf-8' },
    )
    return result.status === 0 && result.stdout.trim() !== ''
  } catch {
    // swallow errors; treat as unresolved
    return false
  }
}

/** Paths in `readFirst` that don't exist on disk relative to `repoRoot`. */
function checkReadFirstPaths(readFirst: readonly string[], repoRoot: string): string[] {
  const missing: string[] = []
  for (const p of readFirst) {
    try {
      if (!existsSync(resolve(repoRoot, p))) missing.push(p)
    } catch {
      missing.push(p)
    }
  }
  return missing
}

/**
 * Validates that every backtick-cited identifier in `prescriptiveAction` is
 * exported somewhere under the repo tree, and that every path listed in
 * `readFirst` exists on disk relative to `repoRoot`.
 */
export function validateSliceReferences(
  slice: Pick<SliceSpec, 'prescriptiveAction' | 'readFirst'>,
  repoRoot: string,
): SliceReferenceValidationResult {
  const symbols = extractCitedSymbols(slice.prescriptiveAction)
  const missingSymbols = symbols.filter((sym) => !checkSymbolViaRg(sym, repoRoot))
  const missingReadFirstPaths = checkReadFirstPaths(slice.readFirst, repoRoot)
  return { missingSymbols, missingReadFirstPaths }
}

/**
 * CodeIndex-aware sibling of {@link validateSliceReferences}. Resolves the
 * active `CodeIndex` implementation at this call boundary — via
 * `resolveCodeIndex` in `../core/ports/code-index/registry.ts`, never
 * importing a concrete implementation (e.g. `codegraph.ts`) directly — and
 * checks each cited symbol against it BEFORE falling back to the `rg`-based
 * existence check: a symbol the port confirms exists (real symbol data)
 * skips the shell-out entirely, replacing the pure-heuristic path this
 * validator otherwise does its own file discovery through.
 *
 * With the default `none` implementation — which always returns zero hits —
 * every symbol falls through to the same `rg` check `validateSliceReferences`
 * performs, so this produces output identical to
 * `validateSliceReferences(slice, repoRoot)` when no code index is configured.
 *
 * @param codeIndex - Defaults to `resolveCodeIndex()` (real env-selected
 *   implementation); tests inject a stub directly.
 */
export async function validateSliceReferencesWithCodeIndex(
  slice: Pick<SliceSpec, 'prescriptiveAction' | 'readFirst'>,
  repoRoot: string,
  codeIndex: CodeIndex = resolveCodeIndex(),
): Promise<SliceReferenceValidationResult> {
  const symbols = extractCitedSymbols(slice.prescriptiveAction)

  const missingSymbols: string[] = []
  for (const sym of symbols) {
    const hits = await codeIndex.symbols({ term: sym, cwd: repoRoot })
    if (hits.length > 0) continue
    if (!checkSymbolViaRg(sym, repoRoot)) missingSymbols.push(sym)
  }

  const missingReadFirstPaths = checkReadFirstPaths(slice.readFirst, repoRoot)
  return { missingSymbols, missingReadFirstPaths }
}
