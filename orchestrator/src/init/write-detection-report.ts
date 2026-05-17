import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ManifestFinding } from './detect-stack'
import type { DepthCapWarning } from './walk-manifests'

/**
 * Input to {@link writeDetectionReport}. Mirrors the relevant subset of the
 * {@link import('./detect-stack').StackDetection} surface so the writer is
 * decoupled from the detector and easy to unit-test with fixed inputs.
 */
export interface WriteDetectionReportInput {
  /** Absolute path to the file to write. The parent directory is created. */
  reportPath: string
  manifests: ReadonlyArray<ManifestFinding>
  warnings: ReadonlyArray<DepthCapWarning>
}

/** Per-manifest entry persisted in the report. */
export interface DetectionReportManifestEntry {
  path: string
  techs: string[]
  supervisors: string[]
}

/** Top-level shape of the persisted report. */
export interface DetectionReport {
  manifests: DetectionReportManifestEntry[]
  warnings: DepthCapWarning[]
}

export type WriteDetectionReportResult =
  | { status: 'ok' }
  | { status: 'error'; error: string }

/**
 * Build the JSON-serializable detection report from detector output. Pure —
 * does not touch the filesystem. Renames the detector's `dir` to `path` for
 * the public contract and copies arrays so consumers cannot mutate the
 * detector's internal state.
 */
export const renderDetectionReport = (
  input: Pick<WriteDetectionReportInput, 'manifests' | 'warnings'>,
): DetectionReport => ({
  manifests: input.manifests.map((m) => ({
    path: m.dir,
    techs: [...m.techs],
    supervisors: [...m.supervisors],
  })),
  warnings: input.warnings.map((w) => ({ kind: w.kind, paths: [...w.paths] })),
})

/**
 * Persist the detection report to disk, overwriting any prior copy. Failures
 * are returned rather than thrown so callers (notably `mars init`) can
 * surface a warning without aborting initialization.
 */
export const writeDetectionReport = (
  input: WriteDetectionReportInput,
): WriteDetectionReportResult => {
  try {
    mkdirSync(dirname(input.reportPath), { recursive: true })
    const report = renderDetectionReport(input)
    writeFileSync(
      input.reportPath,
      JSON.stringify(report, null, 2) + '\n',
      'utf8',
    )
    return { status: 'ok' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: message }
  }
}
