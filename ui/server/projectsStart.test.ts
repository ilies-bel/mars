/**
 * Tests for POST /api/projects/:id/start handler logic.
 *
 * Tests call handleProjectStart directly (no HTTP server spin-up needed)
 * with a mock spawner injected, and the project registry module mocked so
 * no filesystem access occurs.
 *
 * Acceptance criteria covered:
 *   - Unknown projectId → 404 {started:false,reason} without spawning
 *   - Successful spawn → 200 {started:true}
 *   - Failing spawn → 200 {started:false,reason} with the stderr message
 *   - Already-running daemon (idempotent no-op exit 0) → {started:true}
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the registry module before the handler module is imported so that
// findProject is a vi.fn() the tests can control.
vi.mock('../../orchestrator/src/registry/projects.ts', () => ({
  findProject: vi.fn(),
}))

import * as registry from '../../orchestrator/src/registry/projects.ts'
import { handleProjectStart, handleProjectRestart } from './spawnDaemon.ts'
import type { Spawner } from './spawnDaemon.ts'

const FAKE_ENTRY = {
  projectId: 'p_abc123456789',
  repoRoot: '/projects/myrepo',
  name: 'myrepo',
}

describe('handleProjectStart', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 404 and never calls the spawner for an unknown projectId', async () => {
    vi.mocked(registry.findProject).mockReturnValue(null)
    const spawner = vi.fn() as unknown as Spawner

    const result = await handleProjectStart('p_unknown', spawner)

    expect(result.status).toBe(404)
    expect(result.body).toEqual({
      started: false,
      reason: 'unknown project: p_unknown',
    })
    expect(spawner).not.toHaveBeenCalled()
  })

  it('returns 200 {started:true} when the spawner exits 0', async () => {
    vi.mocked(registry.findProject).mockReturnValue(FAKE_ENTRY)
    const spawner = vi.fn().mockResolvedValue({ started: true }) as unknown as Spawner

    const result = await handleProjectStart(FAKE_ENTRY.projectId, spawner)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ started: true })
    // Spawner receives the registered repoRoot — not anything from the request.
    expect(spawner).toHaveBeenCalledOnce()
    expect(spawner).toHaveBeenCalledWith(FAKE_ENTRY.repoRoot)
  })

  it('returns 200 {started:false, reason} when the spawner surfaces stderr', async () => {
    vi.mocked(registry.findProject).mockReturnValue(FAKE_ENTRY)
    const spawner = vi
      .fn()
      .mockResolvedValue({ started: false, reason: 'daemon start failed: port in use' }) as unknown as Spawner

    const result = await handleProjectStart(FAKE_ENTRY.projectId, spawner)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      started: false,
      reason: 'daemon start failed: port in use',
    })
  })

  it('returns 200 {started:true} when the daemon is already running (idempotent no-op)', async () => {
    // mars daemon start exits 0 even when the daemon is already up — that
    // means a double-click is harmless and the client sees {started:true}.
    vi.mocked(registry.findProject).mockReturnValue(FAKE_ENTRY)
    const spawner = vi.fn().mockResolvedValue({ started: true }) as unknown as Spawner

    const first = await handleProjectStart(FAKE_ENTRY.projectId, spawner)
    const second = await handleProjectStart(FAKE_ENTRY.projectId, spawner)

    expect(first.body).toEqual({ started: true })
    expect(second.body).toEqual({ started: true })
  })
})

// ---------------------------------------------------------------------------
// handleProjectRestart — POST /api/projects/:id/restart
//
// Mirrors the handleProjectStart tests; the only difference is that the
// spawner runs `mars daemon restart` instead of `mars daemon start`, so it
// works even when the daemon is dead.
// ---------------------------------------------------------------------------

describe('handleProjectRestart', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 404 and never calls the spawner for an unknown projectId', async () => {
    vi.mocked(registry.findProject).mockReturnValue(null)
    const spawner = vi.fn() as unknown as Spawner

    const result = await handleProjectRestart('p_unknown', spawner)

    expect(result.status).toBe(404)
    expect(result.body).toEqual({
      started: false,
      reason: 'unknown project: p_unknown',
    })
    expect(spawner).not.toHaveBeenCalled()
  })

  it('returns 200 {started:true} when the spawner exits 0', async () => {
    vi.mocked(registry.findProject).mockReturnValue(FAKE_ENTRY)
    const spawner = vi.fn().mockResolvedValue({ started: true }) as unknown as Spawner

    const result = await handleProjectRestart(FAKE_ENTRY.projectId, spawner)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ started: true })
    // Spawner receives the registered repoRoot — not anything from the request.
    expect(spawner).toHaveBeenCalledOnce()
    expect(spawner).toHaveBeenCalledWith(FAKE_ENTRY.repoRoot)
  })

  it('returns 200 {started:false, reason} when the spawner surfaces stderr', async () => {
    vi.mocked(registry.findProject).mockReturnValue(FAKE_ENTRY)
    const spawner = vi
      .fn()
      .mockResolvedValue({ started: false, reason: 'daemon restart failed: permission denied' }) as unknown as Spawner

    const result = await handleProjectRestart(FAKE_ENTRY.projectId, spawner)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      started: false,
      reason: 'daemon restart failed: permission denied',
    })
  })

  it('returns 200 {started:true} when the daemon was dead (restart is idempotent w.r.t. liveness)', async () => {
    // mars daemon restart starts a fresh daemon even when none is running —
    // the client sees {started:true} regardless of prior daemon state.
    vi.mocked(registry.findProject).mockReturnValue(FAKE_ENTRY)
    const spawner = vi.fn().mockResolvedValue({ started: true }) as unknown as Spawner

    const result = await handleProjectRestart(FAKE_ENTRY.projectId, spawner)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ started: true })
  })
})
