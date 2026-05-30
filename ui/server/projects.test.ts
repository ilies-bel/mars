/**
 * Tests for GET /api/projects handler logic.
 *
 * Mocks loadProjectRegistry and probeDaemonHealth so no filesystem or
 * network access occurs. Validates the response shape against
 * projectsResponseSchema.
 *
 * Acceptance criteria covered:
 *   - Happy path: each registry entry is enriched with health in parallel,
 *     and the combined payload satisfies projectsResponseSchema.
 *   - Empty registry: returns { projects: [] }.
 *   - Registry read failure: surfaces a 500 { error } response.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectsResponseSchema } from '../src/shared/schemas.ts'

// Mock both dependencies before any handler code is imported.
vi.mock('../../orchestrator/src/registry/projects.ts', () => ({
  loadProjectRegistry: vi.fn(),
}))

vi.mock('./projectHealth.ts', () => ({
  probeDaemonHealth: vi.fn(),
}))

import * as registry from '../../orchestrator/src/registry/projects.ts'
import * as healthMod from './projectHealth.ts'

// ---------------------------------------------------------------------------
// Handler — mirrors the inline logic in index.ts GET /api/projects.
// Tested here directly (same pattern as projectsStart.test.ts) because
// the Bun.serve HTTP server cannot be spun up under vitest/node.
// ---------------------------------------------------------------------------

async function runHandler(): Promise<{ status: number; body: unknown }> {
  try {
    const entries = registry.loadProjectRegistry()
    const projects = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        health: await healthMod.probeDaemonHealth(e.repoRoot),
      })),
    )
    return { status: 200, body: { projects } }
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } }
  }
}

// ---------------------------------------------------------------------------

const REGISTRY_ENTRIES = [
  { projectId: 'p_aaa', repoRoot: '/repos/a', name: 'project-a' },
  { projectId: 'p_bbb', repoRoot: '/repos/b', name: 'project-b' },
]

describe('GET /api/projects handler', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns projects enriched with health, valid against projectsResponseSchema', async () => {
    vi.mocked(registry.loadProjectRegistry).mockReturnValue(REGISTRY_ENTRIES)
    vi.mocked(healthMod.probeDaemonHealth)
      .mockResolvedValueOnce('live')
      .mockResolvedValueOnce('down')

    const { status, body } = await runHandler()

    expect(status).toBe(200)
    // Must parse without throwing — proves schema conformance.
    const parsed = projectsResponseSchema.parse(body)
    expect(parsed.projects).toHaveLength(2)
    expect(parsed.projects[0]).toEqual({
      projectId: 'p_aaa',
      repoRoot: '/repos/a',
      name: 'project-a',
      health: 'live',
    })
    expect(parsed.projects[1]).toEqual({
      projectId: 'p_bbb',
      repoRoot: '/repos/b',
      name: 'project-b',
      health: 'down',
    })
  })

  it('probes health for every entry in parallel via Promise.all', async () => {
    vi.mocked(registry.loadProjectRegistry).mockReturnValue(REGISTRY_ENTRIES)
    vi.mocked(healthMod.probeDaemonHealth).mockResolvedValue('live')

    await runHandler()

    expect(healthMod.probeDaemonHealth).toHaveBeenCalledTimes(2)
    expect(vi.mocked(healthMod.probeDaemonHealth)).toHaveBeenCalledWith('/repos/a')
    expect(vi.mocked(healthMod.probeDaemonHealth)).toHaveBeenCalledWith('/repos/b')
  })

  it('returns { projects: [] } with status 200 when the registry is empty', async () => {
    vi.mocked(registry.loadProjectRegistry).mockReturnValue([])

    const { status, body } = await runHandler()

    expect(status).toBe(200)
    const parsed = projectsResponseSchema.parse(body)
    expect(parsed.projects).toEqual([])
    // No health probe should fire when there are no entries.
    expect(healthMod.probeDaemonHealth).not.toHaveBeenCalled()
  })

  it('returns 500 { error } when loadProjectRegistry throws', async () => {
    vi.mocked(registry.loadProjectRegistry).mockImplementation(() => {
      throw new Error('registry corrupted')
    })

    const { status, body } = await runHandler()

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'registry corrupted' })
    expect(healthMod.probeDaemonHealth).not.toHaveBeenCalled()
  })
})
