/**
 * Clamp a numeric value between a minimum and maximum bound (inclusive).
 *
 * Returns `min` when value < min, `max` when value > max, or value unchanged
 * when already within [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
