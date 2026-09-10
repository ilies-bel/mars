import type { KpiKey } from './types'
import { Check, TriangleAlert, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Threshold-based band classifier for each KPI.
 *
 * Returns 'good' | 'warn' | 'bad' based on per-KPI thresholds on currentValue,
 * respecting KPI_IMPROVEMENT_DIRECTION (lower-is-better vs higher-is-better).
 *
 * Thresholds (documented below):
 *
 * failure_rate (lower-is-better):
 *   < 0.02  → good   (below 2% failure — healthy harness)
 *   0.02–0.05 → warn  (2–5% failure — worth watching)
 *   > 0.05  → bad    (above 5% failure — needs attention)
 *
 * autonomous_completion_rate (higher-is-better):
 *   > 0.85  → good   (85%+ tasks complete without human intervention)
 *   0.70–0.85 → warn  (70–85% — moderate intervention needed)
 *   < 0.70  → bad    (below 70% — high intervention rate)
 *
 * recovery_success_rate (higher-is-better):
 *   > 0.90  → good   (90%+ recoveries succeed — resilient)
 *   0.75–0.90 → warn  (75–90% — some recoveries failing)
 *   < 0.75  → bad    (below 75% — recovery mechanism struggling)
 *
 * cost_per_arc (lower-is-better, cache-weighted tokens):
 *   < 50_000  → good  (< 50k weighted tokens per arc — efficient)
 *   50k–150k  → warn  (50–150k — moderate cost, watch for growth)
 *   > 150_000 → bad   (> 150k — high cost per arc, investigate)
 *
 *   Rationale for cost thresholds: a typical short-context coder run uses
 *   ~20–40k tokens; a complex multi-step arc with cache hits lands ~50–100k
 *   weighted. 150k signals either context bloat or missing cache utilisation.
 */
export type KpiBand = 'good' | 'warn' | 'bad'

export interface KpiBandCue {
  /**
   * Shape cue — communicates the band without relying on hue alone.
   *
   * A Lucide component, not a "✓/⚠/✕" character: those render at whatever
   * metrics the font gives them (and "⚠" picks up emoji presentation in some
   * fonts), so they sat at a different optical size and weight from every
   * other icon in the app.
   */
  Icon: LucideIcon
  /** Text label — legible without colour (accessible to red/green-blind users). */
  label: string
  /** Semantic Tailwind token class from --color-* CSS vars; never a raw palette colour. */
  colorClass: string
}

/**
 * The labels were the enum names with a capital letter: "Good", "Warn",
 * "Bad". Two of those are adjectives and the middle one is a verb, so the row
 * read "Good · last 7d", "Warn · last 7d", "Bad · last 7d" — and "Warn"
 * described what the DASHBOARD was doing, not what the metric was doing.
 * These three say where the value sits relative to its threshold, which is
 * what the band actually encodes, and they are parallel to each other.
 */
const BAND_CUES: Record<KpiBand, KpiBandCue> = {
  good: { Icon: Check,         label: 'On target', colorClass: 'text-success' },
  warn: { Icon: TriangleAlert, label: 'Near limit', colorClass: 'text-warn' },
  bad:  { Icon: X,             label: 'Off target', colorClass: 'text-error' },
}

/**
 * Returns a display cue for a KPI band: an icon + text label (non-color cue)
 * and a semantic color token class (no raw Tailwind palette colors).
 *
 * Both the shape (icon) and the label are color-independent so the band is
 * legible without relying on hue (red/green-colorblind accessibility).
 */
export function kpiBandCue(band: KpiBand): KpiBandCue {
  return BAND_CUES[band]
}

export function kpiBand(key: KpiKey, value: number): KpiBand {
  switch (key) {
    case 'failure_rate':
      // lower-is-better
      if (value < 0.02) return 'good'
      if (value <= 0.05) return 'warn'
      return 'bad'

    case 'autonomous_completion_rate':
      // higher-is-better
      if (value > 0.85) return 'good'
      if (value >= 0.70) return 'warn'
      return 'bad'

    case 'recovery_success_rate':
      // higher-is-better
      if (value > 0.90) return 'good'
      if (value >= 0.75) return 'warn'
      return 'bad'

    case 'cost_per_arc':
      // lower-is-better (cache-weighted tokens)
      if (value < 50_000) return 'good'
      if (value <= 150_000) return 'warn'
      return 'bad'

    case 'cost-per-merged-task':
      // lower-is-better (USD per merged task)
      if (value < 1.0) return 'good'
      if (value <= 5.0) return 'warn'
      return 'bad'
  }
}
