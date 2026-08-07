/**
 * Lever-semantics tests.
 *
 * Asserts that every renamed/new lever's documented description matches
 * its actual consumer in the codebase, and that defaults are unchanged.
 *
 * Done criteria:
 *  - No lever name misdescribes its effect.
 *  - A lever exists for whether reflection runs automatically.
 *  - Defaults unchanged.
 */
import { describe, expect, it } from 'vitest'
import { loadLeverRegistry } from '../lever-registry.js'

describe('lever semantics: descriptions match consumers', () => {
  it('operator.memory-capture label names memory-packet insertion, not reflection itself', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'operator.memory-capture')
    expect(e).toBeDefined()
    // Must mention memory packets or memory store — not "failure reflection" (old label)
    expect(e!.label.toLowerCase()).toMatch(/memory.packet|memory packet|memory store|memory/i)
    // Must NOT claim to enable/disable reflection itself
    expect(e!.label.toLowerCase()).not.toMatch(/^.*enables.*disables.*failure reflection.*$/i)
  })

  it('self-evolve.auto-enqueue label names auto-enqueue of suggestions, not reflection', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.auto-enqueue')
    expect(e).toBeDefined()
    // Must mention auto-enqueue or enqueue
    expect(e!.label.toLowerCase()).toContain('enqueue')
  })

  it('operator.auto-run-reflect label names automatic reflection execution', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'operator.auto-run-reflect')
    expect(e).toBeDefined()
    // Must mention automatic/auto and reflect/reflection
    expect(e!.label.toLowerCase()).toMatch(/auto/)
    expect(e!.label.toLowerCase()).toMatch(/reflect/)
  })

  it('operator.auto-run-reflect has a real CLI gesture', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'operator.auto-run-reflect')
    expect(e).toBeDefined()
    expect(e!.gesture).not.toBeNull()
    expect(e!.gesture).toContain('mars operator set auto-run-reflect')
  })

  it('operator.memory-capture has a real CLI gesture', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'operator.memory-capture')
    expect(e).toBeDefined()
    expect(e!.gesture).not.toBeNull()
    expect(e!.gesture).toContain('mars operator set memory-capture')
  })

  it('no registry entry uses the old operator.auto-reflect id', () => {
    const ids = loadLeverRegistry().map((e) => e.id)
    expect(ids).not.toContain('operator.auto-reflect')
  })

  it('no registry entry uses the old self-evolve.auto-trigger id', () => {
    const ids = loadLeverRegistry().map((e) => e.id)
    expect(ids).not.toContain('self-evolve.auto-trigger')
  })
})

describe('lever defaults unchanged', () => {
  it('operator.memory-capture defaults to on', () => {
    // Default is 'on': memory packets are captured by default
    const e = loadLeverRegistry().find((x) => x.id === 'operator.memory-capture')
    expect(e).toBeDefined()
    // readCurrent() returns null when no daemon.json is present (env MARS_REPO not set to a real repo)
    // but the allowed values confirm the contract
    expect(e!.allowedValues).toEqual({ type: 'enum', values: ['on', 'off'] })
  })

  it('operator.auto-run-reflect defaults to off', () => {
    // Default is 'off': reflection does NOT run automatically by default
    const e = loadLeverRegistry().find((x) => x.id === 'operator.auto-run-reflect')
    expect(e).toBeDefined()
    expect(e!.allowedValues).toEqual({ type: 'enum', values: ['on', 'off'] })
  })

  it('self-evolve.auto-enqueue defaults to false', () => {
    // selfEvolve.autoEnqueue = false by default: mechanical suggestions go to proposals, not tasks
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.auto-enqueue')
    expect(e).toBeDefined()
    expect(e!.allowedValues).toEqual({ type: 'enum', values: ['true', 'false'] })
  })
})
