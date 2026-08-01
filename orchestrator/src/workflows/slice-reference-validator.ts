import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
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
 */
export function validateSliceReferences(
  slice: Pick<SliceSpec, 'prescriptiveAction' | 'readFirst'>,
  repoRoot: string,
): SliceReferenceValidationResult {
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
