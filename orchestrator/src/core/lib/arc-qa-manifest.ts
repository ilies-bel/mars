/**
 * Per-Arc QA manifest — write and load the JSON file that records every
 * behaviour-verification criterion's screenshot evidence after an E2E browser
 * check completes.
 *
 * Layout on disk:
 *   .mars/arc-qa/<originId>/manifest.json
 *
 * Screenshot paths stored inside the manifest are relative to the same
 * `.mars/arc-qa/<originId>/` directory so the whole artefact tree remains
 * portable if the `.mars/` root is relocated.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-Arc QA manifest.  Written once after a browser-check pass completes;
 * never mutated in place.
 */
export interface ArcQaManifest {
  /** The arc's origin task id. */
  originId: string
  /** Unix epoch milliseconds when the manifest was written. */
  generatedAt: number
  /** One record per done criterion the verifier walked. */
  criteria: Array<{
    /** The DoD criterion text, verbatim. */
    criterion: string
    /**
     * Per-step evidence captured during the walk.
     * Screenshot paths are relative to `.mars/arc-qa/<originId>/`.
     * Empty when no steps were walked.
     */
    steps: Array<{
      /** 1-based (or zero-based sentinel) step index matching the walk sequence. */
      index: number
      /** Plain-language step description authored by the verifier. */
      text: string
      /** Screenshot path for this step, relative to `.mars/arc-qa/<originId>/`. Null when not captured. */
      screenshotPath: string | null
    }>
    /**
     * Step index at which the walk stopped, or null when all steps completed or
     * no walk was attempted.
     */
    stoppedAtStep: number | null
    /** Reason the walk stopped, or null when no walk was attempted. */
    stopReason: string | null
  }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_FILENAME = 'manifest.json'

function arcQaDir(marsStateDir: string, originId: string): string {
  return join(marsStateDir, 'arc-qa', originId)
}

function manifestFilePath(marsStateDir: string, originId: string): string {
  return join(arcQaDir(marsStateDir, originId), MANIFEST_FILENAME)
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the QA manifest for the given arc to disk.
 *
 * Creates `.mars/arc-qa/<originId>/` if it does not already exist.
 * An existing manifest for the same arc is overwritten.
 *
 * Throws on filesystem errors — callers that want best-effort semantics must
 * wrap in their own try/catch.
 */
export async function writeArcQaManifest(
  originId: string,
  marsStateDir: string,
  manifest: ArcQaManifest,
): Promise<void> {
  const dir = arcQaDir(marsStateDir, originId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(manifestFilePath(marsStateDir, originId), JSON.stringify(manifest, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────────
// Load
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the QA manifest for the given arc from disk.
 *
 * Returns `null` when:
 *   - the manifest file does not exist (no pass has run yet), or
 *   - the file content cannot be parsed as valid JSON, or
 *   - the parsed value does not satisfy the `ArcQaManifest` shape.
 *
 * Never throws.
 */
export async function loadArcQaManifest(
  originId: string,
  marsStateDir: string,
): Promise<ArcQaManifest | null> {
  try {
    const raw = await readFile(manifestFilePath(marsStateDir, originId), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isArcQaManifest(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guard
// ─────────────────────────────────────────────────────────────────────────────

function isArcQaManifest(value: unknown): value is ArcQaManifest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['originId'] === 'string' &&
    typeof v['generatedAt'] === 'number' &&
    Array.isArray(v['criteria'])
  )
}
