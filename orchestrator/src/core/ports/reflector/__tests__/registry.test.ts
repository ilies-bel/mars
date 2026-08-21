import { describe, expect, it } from 'vitest'
import {
  getReflector,
  listReflectors,
  registerReflector,
  requireReflector,
} from '../registry'
import { tokenReflector } from '../../../lib/reflector'
import { deepArcReflector, deepSessionReflector } from '../../../lib/deep-reflector'
import { failureReflector } from '../../../lib/failure-reflector'
import type { Reflector, ReflectorRunOutcome } from '../types'

describe('built-in registration', () => {
  it('registers all four built-in kinds at import time', () => {
    const kinds = listReflectors()
      .map((impl) => impl.kind)
      .sort()
    expect(kinds).toEqual(['deep-arc', 'deep-session', 'failure', 'token'])
  })

  it('getReflector resolves each built-in by kind', () => {
    expect(getReflector('token')).toBe(tokenReflector)
    expect(getReflector('deep-arc')).toBe(deepArcReflector)
    expect(getReflector('deep-session')).toBe(deepSessionReflector)
    expect(getReflector('failure')).toBe(failureReflector)
  })

  it('getReflector returns undefined for an unregistered kind', () => {
    // @ts-expect-error — deliberately probing a kind outside the ReflectorKind union.
    expect(getReflector('nope')).toBeUndefined()
  })

  it('requireReflector throws naming the known kinds for an unregistered kind', () => {
    // @ts-expect-error — deliberately probing a kind outside the ReflectorKind union.
    expect(() => requireReflector('nope')).toThrow(/Unknown Reflector implementation 'nope'/)
    // @ts-expect-error — same probe, second assertion.
    expect(() => requireReflector('nope')).toThrow(/token/)
    // @ts-expect-error — same probe, third assertion.
    expect(() => requireReflector('nope')).toThrow(/deep-arc/)
    // @ts-expect-error — same probe, fourth assertion.
    expect(() => requireReflector('nope')).toThrow(/deep-session/)
    // @ts-expect-error — same probe, fifth assertion.
    expect(() => requireReflector('nope')).toThrow(/failure/)
  })

  it('every built-in reports a kind matching its registered key', () => {
    expect(tokenReflector.kind).toBe('token')
    expect(deepArcReflector.kind).toBe('deep-arc')
    expect(deepSessionReflector.kind).toBe('deep-session')
    expect(failureReflector.kind).toBe('failure')
  })
})

describe('requireReflector() generic typing', () => {
  it('returns the concrete reflect() signature callers ask for', () => {
    const reflector = requireReflector<
      Parameters<typeof tokenReflector.reflect>[0],
      ReflectorRunOutcome
    >('token')
    expect(typeof reflector.reflect).toBe('function')
  })
})

describe('registerReflector()', () => {
  it('registers a new implementation and the returned disposer withdraws it', () => {
    const original = getReflector('failure')
    const fake: Reflector<{ note: string }, ReflectorRunOutcome> = {
      kind: 'failure',
      async reflect(request) {
        return { rawOutput: request.note, exitCode: 0 }
      },
    }
    const dispose = registerReflector(fake)
    expect(getReflector('failure')).toBe(fake)
    dispose()
    // The disposer only withdraws the registration — it does not restore a
    // prior value — so the key goes back to unregistered here. Re-register
    // the real built-in afterward so this test does not leak state into the
    // rest of the suite (or, within one worker, other test files).
    expect(getReflector('failure')).toBeUndefined()
    if (original) registerReflector(original)
    expect(getReflector('failure')).toBe(original)
  })
})
