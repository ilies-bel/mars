/**
 * Provider registry — reshape acceptance tests (ADR-0097).
 *
 * Verifies that the seam is genuinely open:
 *   1. A key-backed provider (no subprocess members) can be registered and
 *      resolved without touching the core interface.
 *   2. `isCliProvider` correctly distinguishes CLI-subprocess descriptors from
 *      transport-neutral ones.
 *   3. The three shipped providers (claude, gemini, codex) remain available and
 *      satisfy the CLI-subprocess interface — no behaviour change from the
 *      reshape.
 *
 * This test MUST NOT import or invoke any subprocess, pty, or binary: the
 * fake-key-backed provider must compile and run without a process handle, argv,
 * or stdout to decode.
 */

import { describe, it, expect, afterEach } from 'vitest'
import type { Disposer } from '@mars/workflow'
import {
  registerProvider,
  getProvider,
  requireProvider,
  listProviders,
  isCliProvider,
  type ProviderDescriptor,
  type CliProviderDescriptor,
} from '../provider-registry'
import type { HeadlessRunOpts } from '../provider-types'
import type { RunAgentResult } from '../../ports/executor/types'

// Side-effect import: registers the three shipped providers so the built-in
// assertions below work regardless of suite import order.
import '../providers'

// ---------------------------------------------------------------------------
// Fake key-backed provider — the test object for criterion 1 / 4
//
// Implements only ProviderDescriptor (the transport-neutral core): name,
// models, conversationMemory, headless. NO spawnArgv, feedPrompt, isReady,
// doneSignal, prepare — and headless carries no readOutput.
// If TypeScript rejects this object as a ProviderDescriptor, the reshape is
// incomplete.
// ---------------------------------------------------------------------------

const FAKE_KEY_BACKED_RUN_RESULT: RunAgentResult = {
  exitCode: 0,
  stdout: 'fake response',
  stderr: '',
  sessionId: null,
  conversation: [],
  quotaRejected: null,
}

const FAKE_KEY_BACKED: ProviderDescriptor = {
  name: 'test-key-backed',
  models: {
    flagship: 'key-model-large',
    balanced: 'key-model-mid',
    fast: 'key-model-small',
  },
  conversationMemory: (_model: string) => ({
    retentionMs: 60_000,
    minimumReusablePrefixTokens: 512,
    contextWindowTokens: 128_000,
  }),
  headless: {
    capabilities: {
      usageSemantics: 'per-request',
      quotaRejected: true,
      sessionId: false,
    },
    // No subprocess: the run() implementation would call an HTTP API in production.
    run: async (_prompt: string, _opts: HeadlessRunOpts): Promise<RunAgentResult> =>
      FAKE_KEY_BACKED_RUN_RESULT,
    // readOutput is intentionally absent — key-backed adapters decode HTTP
    // response bodies inside run(), not a captured stdout.
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let disposeRegistration: Disposer | undefined

afterEach(() => {
  disposeRegistration?.()
  disposeRegistration = undefined
})

// ---------------------------------------------------------------------------
// Criterion 1 & 3: A non-subprocess provider can be registered and resolved
// ---------------------------------------------------------------------------

describe('key-backed provider registration', () => {
  it('can be registered with registerProvider without subprocess members', () => {
    // If TypeScript compilation of FAKE_KEY_BACKED above passes, the seam
    // admits non-subprocess providers. This runtime assertion confirms the
    // registry accepted the registration.
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    expect(getProvider('test-key-backed')).toBeDefined()
  })

  it('is retrievable via requireProvider after registration', () => {
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    const p = requireProvider('test-key-backed')
    expect(p.name).toBe('test-key-backed')
    expect(p.models.flagship).toBe('key-model-large')
  })

  it('appears in listProviders after registration', () => {
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    const names = listProviders().map((p) => p.name)
    expect(names).toContain('test-key-backed')
  })

  it('is removed from the registry after the disposer fires', () => {
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    disposeRegistration()
    disposeRegistration = undefined
    expect(getProvider('test-key-backed')).toBeUndefined()
  })

  it('headless.run() is callable without a subprocess', async () => {
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    const p = requireProvider('test-key-backed')
    const result = await p.headless.run('hello', { cwd: '/tmp' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('fake response')
  })

  it('conversationMemory() returns the declared facts', () => {
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    const p = requireProvider('test-key-backed')
    const mem = p.conversationMemory('key-model-large')
    expect(mem.retentionMs).toBe(60_000)
    expect(mem.contextWindowTokens).toBe(128_000)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: isCliProvider correctly narrows the descriptor type
// ---------------------------------------------------------------------------

describe('isCliProvider type guard', () => {
  it('returns false for a key-backed provider (no spawnArgv)', () => {
    disposeRegistration = registerProvider(FAKE_KEY_BACKED)
    const p = requireProvider('test-key-backed')
    expect(isCliProvider(p)).toBe(false)
  })

  it('returns true for the claude provider (has spawnArgv)', () => {
    const p = requireProvider('claude')
    expect(isCliProvider(p)).toBe(true)
  })

  it('returns true for the gemini provider', () => {
    expect(isCliProvider(requireProvider('gemini'))).toBe(true)
  })

  it('returns true for the codex provider', () => {
    expect(isCliProvider(requireProvider('codex'))).toBe(true)
  })

  it('narrowed CLI descriptor exposes spawnArgv and feedPrompt', () => {
    const p = requireProvider('claude')
    if (!isCliProvider(p)) throw new Error('expected claude to be a CLI provider')
    // TypeScript: p is now typed as CliProviderDescriptor — these compile.
    expect(typeof p.spawnArgv).toBe('function')
    expect(typeof p.feedPrompt).toBe('function')
    expect(typeof p.headless.readOutput).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: The three shipped providers behave unchanged (no regression)
// ---------------------------------------------------------------------------

describe('built-in CLI providers — unchanged after reshape', () => {
  const BUILT_INS = ['claude', 'gemini', 'codex'] as const

  it.each(BUILT_INS)('%s resolves from the registry', (name) => {
    const p = requireProvider(name)
    expect(p.name).toBe(name)
  })

  it.each(BUILT_INS)('%s satisfies isCliProvider', (name) => {
    expect(isCliProvider(requireProvider(name))).toBe(true)
  })

  it.each(BUILT_INS)('%s headless.capabilities is set', (name) => {
    const { capabilities } = requireProvider(name).headless
    expect(capabilities).toHaveProperty('usageSemantics')
    expect(capabilities).toHaveProperty('quotaRejected')
    expect(capabilities).toHaveProperty('sessionId')
  })

  it.each(BUILT_INS)('%s has a models table with all three tiers', (name) => {
    const { models } = requireProvider(name)
    expect(typeof models.flagship).toBe('string')
    expect(typeof models.balanced).toBe('string')
    expect(typeof models.fast).toBe('string')
  })

  it('claude CliProviderDescriptor carries readOutput on headless', () => {
    const p = requireProvider('claude') as CliProviderDescriptor
    expect(typeof p.headless.readOutput).toBe('function')
  })

  it('gemini CliProviderDescriptor carries readOutput on headless', () => {
    const p = requireProvider('gemini') as CliProviderDescriptor
    expect(typeof p.headless.readOutput).toBe('function')
  })

  it('codex CliProviderDescriptor carries readOutput on headless', () => {
    const p = requireProvider('codex') as CliProviderDescriptor
    expect(typeof p.headless.readOutput).toBe('function')
  })
})
