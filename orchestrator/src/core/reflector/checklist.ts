/**
 * ReflectorChecklistItem — a suggestion the Reflector may surface.
 *
 * When `probe` is provided, the checklist runner calls it before surfacing
 * the suggestion. If the probe resolves `true` the item is considered already
 * satisfied and is silently dropped. A probe that rejects or times out is
 * treated as "not satisfied" so the suggestion is still surfaced.
 */
export type ReflectorChecklistItem = {
  id: string
  suggest: string
  probe?: () => Promise<boolean>
}

const PROBE_TIMEOUT_MS = 2000

/**
 * Run every item's probe (if present) with a 2 s timeout and drop any item
 * whose probe resolves `true`. Items with no probe, a probe that resolves
 * `false`, a probe that rejects, or a probe that times out are all kept.
 */
export async function screenChecklist(
  items: ReflectorChecklistItem[],
): Promise<ReflectorChecklistItem[]> {
  const settled = await Promise.all(
    items.map(async (item): Promise<ReflectorChecklistItem | null> => {
      if (!item.probe) return item

      const timeout = new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), PROBE_TIMEOUT_MS),
      )

      let satisfied: boolean
      try {
        satisfied = await Promise.race([item.probe(), timeout])
      } catch {
        satisfied = false
      }

      return satisfied ? null : item
    }),
  )

  return settled.filter((item): item is ReflectorChecklistItem => item !== null)
}
