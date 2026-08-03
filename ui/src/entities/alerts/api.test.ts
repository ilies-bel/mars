import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAlerts } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('fetchAlerts', () => {
  it('accepts a verify-uncovered alert from the daemon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        arcId: 'coverage:src/widgets',
        kind: 'verify-uncovered',
        goal: 'src/widgets',
        reason: "CAN'T-VERIFY: no task-tier verify gate covers the changed files",
        technical: 'changed paths:\n- src/widgets/BellMenu.tsx',
        fingerprint: 'coverage:src/widgets',
        recipe: 'add-verify-gate',
        chain: [],
      }],
    }))

    await expect(fetchAlerts()).resolves.toMatchObject([
      {
        kind: 'verify-uncovered',
        fingerprint: 'coverage:src/widgets',
        recipe: 'add-verify-gate',
      },
    ])
  })
})
