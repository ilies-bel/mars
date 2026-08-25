import { describe, it, expect, afterEach } from 'vitest'
import type { Disposer } from '@mars/workflow'
import { installableProviderNames } from '../install'
import { registerProvider, type ProviderDescriptor } from '../../../core/workers/provider-registry'
// Side-effect import: registers the built-in claude/gemini/codex providers so
// this test file can assert on them without depending on import order across
// the suite.
import '../../../core/workers/providers'

// FAKE_PROVIDER is a minimal key-backed descriptor: it implements only the
// transport-neutral ProviderDescriptor (name, models, conversationMemory,
// headless) with no CLI-subprocess members. This proves that registerProvider
// accepts any adapter kind, not just CLI subprocess providers.
const FAKE_PROVIDER: ProviderDescriptor = {
  name: 'fake-provider',
  models: { flagship: 'fake-big', balanced: 'fake-mid', fast: 'fake-small' },
  conversationMemory: () => {
    throw new Error('unused in this test')
  },
  headless: {
    run: async () => {
      throw new Error('unused in this test')
    },
    capabilities: {
      usageSemantics: 'per-request',
      quotaRejected: false,
      sessionId: false,
    },
  },
}

let dispose: Disposer | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
})

describe('installableProviderNames', () => {
  it('lists every currently-shipped provider', () => {
    const names = installableProviderNames()
    expect(names).toContain('claude')
    expect(names).toContain('gemini')
    expect(names).toContain('codex')
  })

  it('picks up a provider registered at runtime with no install.ts edit', () => {
    expect(installableProviderNames()).not.toContain('fake-provider')

    dispose = registerProvider(FAKE_PROVIDER)

    expect(installableProviderNames()).toContain('fake-provider')

    dispose()
    dispose = undefined

    expect(installableProviderNames()).not.toContain('fake-provider')
  })
})
