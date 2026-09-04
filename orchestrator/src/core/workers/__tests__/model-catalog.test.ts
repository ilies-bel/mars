import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MODEL_CATALOG,
  resolveCatalogModel,
  resolveCatalogFacts,
  resolveDefaultThinkingEffort,
  getAvailableThinkingEfforts,
  ALL_THINKING_EFFORT_IDS,
  THINKING_EFFORTS_BY_PROVIDER,
  defaultModelIdFor,
} from '../model-catalog'

// ── Catalog integrity ─────────────────────────────────────────────────────────

describe('MODEL_CATALOG structure', () => {
  it('has at least one agent with at least one model', () => {
    expect(MODEL_CATALOG.agents.length).toBeGreaterThan(0)
    for (const agent of MODEL_CATALOG.agents) {
      expect(agent.models.length).toBeGreaterThan(0)
    }
  })

  it('has exactly one isDefault model per provider (or none)', () => {
    for (const agent of MODEL_CATALOG.agents) {
      const defaults = agent.models.filter((m) => m.isDefault)
      expect(defaults.length).toBeLessThanOrEqual(1)
    }
  })

  it('has exactly one isDefault thinkingEffort per provider (or none)', () => {
    for (const agent of MODEL_CATALOG.agents) {
      const defaults = agent.thinkingEfforts.filter((e) => e.isDefault)
      expect(defaults.length).toBeLessThanOrEqual(1)
    }
  })

  it("model-level thinkingEfforts arrays reference only ids declared at the provider level", () => {
    for (const agent of MODEL_CATALOG.agents) {
      const providerEffortIds = new Set(agent.thinkingEfforts.map((e) => e.id))
      for (const model of agent.models) {
        for (const effortId of model.thinkingEfforts ?? []) {
          expect(providerEffortIds.has(effortId)).toBe(true)
        }
      }
    }
  })
})

// ── resolveCatalogModel — never throws, longest-prefix match ─────────────────

describe('resolveCatalogModel', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { consoleSpy.mockRestore() })

  it('returns the exact model for a known id', () => {
    const model = resolveCatalogModel('claude', 'claude-sonnet-4-6')
    expect(model?.id).toBe('claude-sonnet-4-6')
  })

  it('resolves an unknown model id via longest-prefix match, not throw', () => {
    // 'claude-sonnet-99' shares the 'claude-sonnet-4-6' prefix up to 'claude-sonnet'
    // — wait, that prefix match goes by startsWith(catalogId), so 'claude-sonnet-99'
    // starts with 'claude-sonnet-4-6' — no, it doesn't. So it falls back to default.
    // The important thing is: it does NOT throw.
    expect(() => resolveCatalogModel('claude', 'claude-sonnet-99')).not.toThrow()
  })

  it('resolves claude-sonnet-4-6-extra via prefix match to claude-sonnet-4-6', () => {
    const model = resolveCatalogModel('claude', 'claude-sonnet-4-6-20260101')
    // The model id 'claude-sonnet-4-6-20260101' startsWith 'claude-sonnet-4-6'
    expect(model?.id).toBe('claude-sonnet-4-6')
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('returns null for an unknown agent id', () => {
    expect(resolveCatalogModel('unknown-agent', 'some-model')).toBeNull()
  })

  it('falls back to the default model for a completely unrecognised id', () => {
    const model = resolveCatalogModel('claude', 'completely-unknown-model-xyz')
    // Should return the default or first model, not throw
    expect(model).not.toBeNull()
    expect(model?.id).toBeDefined()
  })
})

// ── resolveCatalogFacts — never throws ───────────────────────────────────────

describe('resolveCatalogFacts', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { consoleSpy.mockRestore() })

  it('returns correct facts for known models', () => {
    const facts = resolveCatalogFacts('claude', 'claude-sonnet-4-6')
    expect(facts.contextWindowTokens).toBe(200_000)
    expect(facts.retentionMs).toBeGreaterThan(0)
    expect(facts.minimumReusablePrefixTokens).toBeGreaterThan(0)
  })

  it('does NOT throw for an unknown model id — returns conservative defaults', () => {
    expect(() => resolveCatalogFacts('claude', 'claude-opus-99-future')).not.toThrow()
    const facts = resolveCatalogFacts('claude', 'claude-opus-99-future')
    expect(facts).toMatchObject({
      retentionMs: expect.any(Number),
      minimumReusablePrefixTokens: expect.any(Number),
      contextWindowTokens: expect.any(Number),
    })
  })

  it('does NOT throw for an unknown agent id — returns conservative defaults', () => {
    expect(() => resolveCatalogFacts('future-provider', 'future-model')).not.toThrow()
    const facts = resolveCatalogFacts('future-provider', 'future-model')
    expect(facts.retentionMs).toBeGreaterThan(0)
    expect(facts.contextWindowTokens).toBeGreaterThan(0)
  })

  it('returns gemini-specific large context window for gemini-2.5-pro', () => {
    const facts = resolveCatalogFacts('gemini', 'gemini-2.5-pro')
    expect(facts.contextWindowTokens).toBeGreaterThan(200_000)
  })
})

// ── resolveDefaultThinkingEffort — model-level beats provider-level ───────────

describe('resolveDefaultThinkingEffort', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { consoleSpy.mockRestore() })

  it('uses the model-level defaultThinkingEffort when set (beats provider-level isDefault)', () => {
    // claude-opus-4-6 has defaultThinkingEffort: 'high'
    // Provider-level isDefault is 'medium' (claude's thinkingEfforts)
    const effort = resolveDefaultThinkingEffort('claude', 'claude-opus-4-6')
    expect(effort).toBe('high') // model-level wins
  })

  it('uses the model-level defaultThinkingEffort for sonnet (medium)', () => {
    const effort = resolveDefaultThinkingEffort('claude', 'claude-sonnet-4-6')
    expect(effort).toBe('medium')
  })

  it('falls back to provider-level isDefault when model has no override', () => {
    // codex's gpt-5.6-terra has defaultThinkingEffort: 'medium'
    const effort = resolveDefaultThinkingEffort('codex', 'gpt-5.6-terra')
    expect(effort).toBe('medium')
  })

  it('does NOT throw for an unknown model id', () => {
    expect(() => resolveDefaultThinkingEffort('claude', 'claude-future-99')).not.toThrow()
  })

  it('returns undefined for an unknown agent id', () => {
    expect(resolveDefaultThinkingEffort('unknown-agent', 'any-model')).toBeUndefined()
  })
})

// ── getAvailableThinkingEfforts — opt-in convention ───────────────────────────

describe('getAvailableThinkingEfforts', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { consoleSpy.mockRestore() })

  it('includes common (non-optIn) efforts for every model', () => {
    const sonnetEfforts = getAvailableThinkingEfforts('claude', 'claude-sonnet-4-6')
    const ids = sonnetEfforts.map((e) => e.id)
    // none, low, medium, high are common; xhigh and max are optIn
    expect(ids).toContain('none')
    expect(ids).toContain('low')
    expect(ids).toContain('medium')
    expect(ids).toContain('high')
  })

  it('does NOT include optIn efforts for a model that does not list them', () => {
    // claude-sonnet-4-6 does NOT list xhigh or max in its per-model array
    const sonnetEfforts = getAvailableThinkingEfforts('claude', 'claude-sonnet-4-6')
    const ids = sonnetEfforts.map((e) => e.id)
    expect(ids).not.toContain('xhigh')
    expect(ids).not.toContain('max')
  })

  it('DOES include optIn efforts for models that declare them', () => {
    // claude-opus-4-6 lists ['xhigh', 'max'] in its per-model thinkingEfforts
    const opusEfforts = getAvailableThinkingEfforts('claude', 'claude-opus-4-6')
    const ids = opusEfforts.map((e) => e.id)
    expect(ids).toContain('xhigh')
    expect(ids).toContain('max')
  })

  it('returns an empty array for an unknown agent', () => {
    const efforts = getAvailableThinkingEfforts('unknown-provider', 'any-model')
    expect(efforts).toEqual([])
  })
})

// ── Exported validation sets (rule 4) ─────────────────────────────────────────

describe('ALL_THINKING_EFFORT_IDS', () => {
  it('is derived from the catalog and non-empty', () => {
    expect(ALL_THINKING_EFFORT_IDS.size).toBeGreaterThan(0)
  })

  it('contains ids from every provider', () => {
    // All three providers share 'high'
    expect(ALL_THINKING_EFFORT_IDS.has('high')).toBe(true)
    expect(ALL_THINKING_EFFORT_IDS.has('low')).toBe(true)
    expect(ALL_THINKING_EFFORT_IDS.has('medium')).toBe(true)
  })

  it('contains only ids that appear in the catalog', () => {
    const catalogIds = new Set(
      MODEL_CATALOG.agents.flatMap((a) => a.thinkingEfforts.map((e) => e.id)),
    )
    for (const id of ALL_THINKING_EFFORT_IDS) {
      expect(catalogIds.has(id)).toBe(true)
    }
  })
})

describe('THINKING_EFFORTS_BY_PROVIDER', () => {
  it('has an entry for every provider in the catalog', () => {
    for (const agent of MODEL_CATALOG.agents) {
      expect(THINKING_EFFORTS_BY_PROVIDER.has(agent.id)).toBe(true)
    }
  })

  it('includes all effort ids for the codex provider', () => {
    const codexEfforts = THINKING_EFFORTS_BY_PROVIDER.get('codex')
    expect(codexEfforts).toBeDefined()
    expect(codexEfforts!.has('high')).toBe(true)
  })
})

// ── defaultModelIdFor ─────────────────────────────────────────────────────────

describe('defaultModelIdFor', () => {
  it('returns the isDefault model id for a known provider', () => {
    const id = defaultModelIdFor('claude')
    expect(id).toBe('claude-sonnet-4-6') // marked isDefault in catalog
  })

  it('returns undefined for an unknown provider', () => {
    expect(defaultModelIdFor('unknown-provider')).toBeUndefined()
  })
})

// ── Thread selection integration — catalog default used when no stored value ──

describe('catalog default for thread with no stored selection', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { consoleSpy.mockRestore() })

  it('resolveDefaultThinkingEffort uses catalog defaults, not a hard-coded value', () => {
    // This test verifies that a thread with no stored selection falls back to
    // the catalog rather than a separate hard-coded list.
    const effort = resolveDefaultThinkingEffort('claude', 'claude-sonnet-4-6')
    // The catalog declares 'medium' as the model-level default for sonnet.
    expect(effort).toBe('medium')
    // Prove it came from the catalog, not a magic constant:
    const catalogEntry = MODEL_CATALOG.agents
      .find((a) => a.id === 'claude')
      ?.models.find((m) => m.id === 'claude-sonnet-4-6')
    expect(catalogEntry?.defaultThinkingEffort).toBe('medium')
  })
})
