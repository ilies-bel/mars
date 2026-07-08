import type { KpiBand } from '@/entities/kpi/bands'

/**
 * %-of-threshold banding for the Spend meter. The meter is explicitly NOT a
 * fifth KPI (no KpiKey, no kpi_snapshots rows) — it only reuses the KpiBand
 * cue vocabulary (glyph/label/colorClass via kpiBandCue) for rendering.
 *
 * ratio = spend / threshold:
 *   < 0.70  → good  (comfortably under budget)
 *   0.70–1  → warn  (approaching the threshold)
 *   >= 1    → bad   (at or over the threshold — a budget row is open)
 */
export function spendMeterBand(ratio: number): KpiBand {
  if (ratio >= 1) return 'bad'
  if (ratio >= 0.7) return 'warn'
  return 'good'
}
