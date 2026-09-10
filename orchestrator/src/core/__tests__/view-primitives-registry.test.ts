/**
 * Tests that viewPrimitives() reads the live registry — a primitive registered
 * at runtime appears in the API output, which the closed PRIMITIVE_CATALOG made
 * impossible before this change.
 *
 * Each test registers a custom primitive under a unique id, calls viewPrimitives,
 * asserts the result, then disposes the registration so the global registry is
 * restored for subsequent tests. Vitest runs this file in a worker, so the
 * module-level registry state is isolated from other test files.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTraceEventStore, type TraceEventStore } from '../lib/trace-events-store'
import { createAppServices, type AppServices } from '../app-services'
import { registerPrimitive } from '../../workflows/primitives/registry'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-vp-registry-'))
  return join(dir, 'mars.db')
}

const makeServices = (traceStore: TraceEventStore): AppServices =>
  createAppServices({
    traceStore,
    buildAlertSources: async () => ({
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }),
    loadWorkerDeclarations: () => [],
    listAwaitingHumanParks: async () => [],
  })

describe('viewPrimitives — reads the live registry', () => {
  let dbPath: string
  let store: TraceEventStore
  let svc: AppServices

  beforeEach(async () => {
    dbPath = tmpDbPath()
    store = await openTraceEventStore(dbPath)
    svc = makeServices(store)
  })

  afterEach(async () => {
    await store.close()
  })

  it('includes a primitive registered at runtime', async () => {
    // Register a custom primitive and verify it appears in the listing.
    // This is the behaviour the closed PRIMITIVE_CATALOG made impossible.
    const dispose = registerPrimitive({
      id: 'custom-lint',
      executor: 'deterministic',
      description: 'Run the project linter as a verify gate.',
      phase: 'verify',
    })

    try {
      const { primitives } = await svc.viewPrimitives()
      const custom = primitives.find((p) => p.name === 'custom-lint')
      expect(custom).toBeDefined()
      expect(custom).toMatchObject({
        name: 'custom-lint',
        description: 'Run the project linter as a verify gate.',
        phase: 'verify',
        // 'deterministic' maps to 'shell' on the wire for backward-compat.
        executor: 'shell',
      })
    } finally {
      dispose()
    }
  })

  it('omits primitives registered without a description (internal steps)', async () => {
    // Internal steps (finalizeReport, finalizeMockup) have no description and
    // must not appear in the public listing.
    const dispose = registerPrimitive({
      id: 'internal-helper',
      executor: 'deterministic',
      // Deliberately no description — should not appear.
    })

    try {
      const { primitives } = await svc.viewPrimitives()
      expect(primitives.find((p) => p.name === 'internal-helper')).toBeUndefined()
    } finally {
      dispose()
    }
  })

  it('includes the six built-in public primitives with non-empty descriptions', async () => {
    const { primitives } = await svc.viewPrimitives()
    const byName = new Map(primitives.map((p) => [p.name, p]))

    for (const name of ['setupWorktree', 'runAgent', 'verify', 'behaviourVerify', 'merge', 'awaitHuman']) {
      const p = byName.get(name)
      expect(p, `expected built-in primitive '${name}' to be present`).toBeDefined()
      expect(p!.description.length, `'${name}' description should be non-empty`).toBeGreaterThan(0)
    }
  })

  it('disposes cleanly — a removed primitive no longer appears', async () => {
    const dispose = registerPrimitive({
      id: 'transient-gate',
      executor: 'deterministic',
      description: 'A gate that is removed after this test.',
      phase: 'verify',
    })

    // Present while registered.
    const before = await svc.viewPrimitives()
    expect(before.primitives.find((p) => p.name === 'transient-gate')).toBeDefined()

    dispose()

    // Gone after disposal.
    const after = await svc.viewPrimitives()
    expect(after.primitives.find((p) => p.name === 'transient-gate')).toBeUndefined()
  })
})
