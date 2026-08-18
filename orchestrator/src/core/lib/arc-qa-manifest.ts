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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { raiseActionQueueItem } from './action-queue.js'

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
// Promote-step-list-to-docs suggestion
// ─────────────────────────────────────────────────────────────────────────────

/** Dedup signature for the one-per-project promote-step-list-to-docs suggestion. */
export const QA_STEP_LIST_PROMOTE_SUGGESTION_SIGNATURE = 'qa-step-list-promote-suggestion'

/**
 * Offer to promote the QA step list into the project's permanent documentation,
 * but only the first time per project.
 *
 * Checks `.mars/arc-qa/.promote-suggested`. When absent, raises a
 * `draft-proposal` action-queue item (deduped by the fixed signature
 * {@link QA_STEP_LIST_PROMOTE_SUGGESTION_SIGNATURE}) then writes the marker so
 * subsequent arcs skip the check entirely.
 *
 * Best-effort: callers must wrap this in their own try/catch so a failure here
 * never fails the Arc.
 */
export async function maybeSuggestPromotion(
  originId: string,
  marsStateDir: string,
): Promise<void> {
  const markerDir = join(marsStateDir, 'arc-qa')
  const markerPath = join(markerDir, '.promote-suggested')
  if (existsSync(markerPath)) return

  const manifestPath = join('arc-qa', originId, 'manifest.json')

  await raiseActionQueueItem({
    kind: 'draft-proposal',
    category: 'orchestrator',
    priority: 'normal',
    title: 'Promote QA step lists into project documentation?',
    body: [
      `Arc \`${originId}\` produced a QA step list. Preview it with:`,
      '',
      '```',
      `mars arc qa ${originId}`,
      '```',
      '',
      `The manifest is available at \`.mars/${manifestPath}\`.`,
      '',
      'Consider promoting this step list into the project\'s permanent documentation',
      'so future contributors can follow the same QA flow without running the Arc.',
    ].join('\n'),
    payload: { originId, manifestPath },
    context: {},
    raisedBy: 'arc-verifier',
    signature: QA_STEP_LIST_PROMOTE_SUGGESTION_SIGNATURE,
  })

  mkdirSync(markerDir, { recursive: true })
  writeFileSync(markerPath, '')
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
