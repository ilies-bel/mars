import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screenChecklist } from './checklist.js'
import type { ReflectorChecklistItem } from './checklist.js'

describe('screenChecklist', () => {
  it('keeps an item that has no probe (no probe → always suggest)', async () => {
    const items: ReflectorChecklistItem[] = [{ id: 'no-probe', suggest: 'Do something' }]
    const result = await screenChecklist(items)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('no-probe')
  })

  it('drops an item whose probe returns true (already satisfied → skip suggestion)', async () => {
    const items: ReflectorChecklistItem[] = [
      { id: 'already-done', suggest: 'Already installed', probe: async () => true },
    ]
    const result = await screenChecklist(items)
    expect(result).toHaveLength(0)
  })

  it('keeps an item whose probe returns false (not satisfied → surface suggestion)', async () => {
    const items: ReflectorChecklistItem[] = [
      { id: 'not-done', suggest: 'Install something', probe: async () => false },
    ]
    const result = await screenChecklist(items)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('not-done')
  })

  it('two stub items — probe true dropped, probe false kept — only the false-probe item becomes a suggestion', async () => {
    const items: ReflectorChecklistItem[] = [
      { id: 'satisfied', suggest: 'Already done', probe: async () => true },
      { id: 'needed', suggest: 'Needs doing', probe: async () => false },
    ]
    const result = await screenChecklist(items)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('needed')
  })

  describe('probe timeout behaviour', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps an item whose probe hangs past the 2 s timeout (timeout → not confirmed satisfied → keep)', async () => {
      let resolveProbe!: (v: boolean) => void
      const hangingProbe = new Promise<boolean>((resolve) => {
        resolveProbe = resolve
      })

      const items: ReflectorChecklistItem[] = [
        { id: 'slow-probe', suggest: 'Slow check', probe: () => hangingProbe },
      ]

      const screenPromise = screenChecklist(items)
      // Advance past the 2 s timeout so the race resolves via the timeout arm.
      await vi.runAllTimersAsync()
      const result = await screenPromise

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('slow-probe')

      // Resolve the hanging probe to clean up (after result already captured).
      resolveProbe(true)
    })
  })
})
