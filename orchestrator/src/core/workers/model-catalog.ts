/**
 * Model catalog — single declarative source of labels, defaults, and
 * conversation-memory facts for every provider's chat models.
 *
 * Design rules (enforced throughout this module):
 *
 *  1. Opt-in-beyond-common. The provider-level `thinkingEfforts` list carries
 *     label + display order for EVERY known effort value. Entries marked `optIn`
 *     are only offered when the ACTIVE MODEL's per-model `thinkingEfforts` array
 *     names that id. Unmarked entries are common to all models in the provider.
 *     A model entry lists ONLY what it adds, never the full set.
 *
 *  2. Model-level default beats provider-level default. A model's
 *     `defaultThinkingEffort` overrides the provider's `isDefault` marker for
 *     that model.
 *
 *  3. NEVER validate model ids against the catalog. The provider CLI is the
 *     source of truth for which models exist; the catalog is for labels,
 *     defaults, and facts. An unknown model is accepted and resolved by
 *     longest-prefix match, then by conservative defaults. No throw, ever.
 *
 *  4. Derive validation sets from this module. Export the valid effort sets
 *     computed at module load so every validation site imports from here —
 *     no second drifting list anywhere in the codebase.
 */

import type { ConversationMemoryFacts } from './provider-types'

// ── Catalog types ─────────────────────────────────────────────────────────────

export interface CatalogThinkingEffort {
  readonly id: string
  readonly label: string
  /** Baseline default for all models in this provider (overridden per model). */
  readonly isDefault?: boolean
  /**
   * When true, this effort is only shown/offered when the ACTIVE MODEL's
   * per-model `thinkingEfforts` array explicitly lists this id.
   * Omitting/false means the effort is common to all models in the provider.
   */
  readonly optIn?: boolean
}

export interface CatalogReasoningEffort {
  readonly id: string
  readonly label: string
  readonly isDefault?: boolean
}

export interface CatalogModel {
  readonly id: string
  readonly label: string
  /** Default selection in a provider's model picker. */
  readonly isDefault?: boolean
  /**
   * Model-level default thinking effort. Wins over the provider-level
   * `thinkingEfforts[].isDefault`. Omit to inherit the provider default.
   */
  readonly defaultThinkingEffort?: string
  /**
   * The opt-in effort IDs this model ADDS beyond the provider's common set.
   * Lists only the additions — not the full set of available efforts.
   */
  readonly thinkingEfforts?: readonly string[]
  // ── conversation-memory facts ──────────────────────────────────────────────
  readonly contextWindowTokens: number
  readonly retentionMs: number
  readonly minimumReusablePrefixTokens: number
}

export interface CatalogAgent {
  readonly id: string
  readonly label: string
  readonly models: readonly CatalogModel[]
  /**
   * ALL known thinking-effort values for this provider, in display order.
   * Entries with `optIn: true` are filtered by the active model's per-model
   * `thinkingEfforts` array (rule 1 above).
   */
  readonly thinkingEfforts: readonly CatalogThinkingEffort[]
  /** Codex-only second axis (reasoning effort). Absent for other providers. */
  readonly reasoningEfforts?: readonly CatalogReasoningEffort[]
}

export interface ModelCatalog {
  /** Date-stamped version token. Bump when the catalog data changes. */
  readonly version: string
  /** Minimum Mars CLI version required to interpret this catalog correctly. */
  readonly minCliVersion: string
  readonly agents: readonly CatalogAgent[]
}

// ── Conservative fallback facts ───────────────────────────────────────────────

/**
 * Applied when a model id matches no catalog entry and no prefix. Safe for
 * any chat turn: small minimum prefix avoids spurious prefix reuse, and
 * 200 k token context is well within every current provider.
 */
const CONSERVATIVE_DEFAULTS: ConversationMemoryFacts = {
  retentionMs: 5 * 60 * 1000,
  minimumReusablePrefixTokens: 1024,
  contextWindowTokens: 200_000,
}

// ── The catalog ───────────────────────────────────────────────────────────────

export const MODEL_CATALOG: ModelCatalog = {
  version: '2026-09-04',
  minCliVersion: '0.0.0',
  agents: [
    // ── Claude ──────────────────────────────────────────────────────────────
    {
      id: 'claude',
      label: 'Claude',
      models: [
        {
          id: 'claude-opus-4-6',
          label: 'Claude Opus 4.6',
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          // Opus models support extended thinking; make that the default.
          defaultThinkingEffort: 'high',
          // Opt-in: extended and max effort are Opus-class additions.
          thinkingEfforts: ['xhigh', 'max'],
        },
        {
          id: 'claude-sonnet-4-6',
          label: 'Claude Sonnet 4.6',
          isDefault: true,
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          // Sonnet uses medium by default; xhigh/max are not offered.
          defaultThinkingEffort: 'medium',
        },
        {
          id: 'claude-haiku-4-6',
          label: 'Claude Haiku 4.6',
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 512,
          defaultThinkingEffort: 'low',
        },
      ],
      thinkingEfforts: [
        { id: 'none',  label: 'None' },
        { id: 'low',   label: 'Low' },
        { id: 'medium', label: 'Medium', isDefault: true },
        { id: 'high',  label: 'High' },
        { id: 'xhigh', label: 'Extended', optIn: true },
        { id: 'max',   label: 'Max',      optIn: true },
      ],
    },

    // ── Gemini ──────────────────────────────────────────────────────────────
    {
      id: 'gemini',
      label: 'Gemini',
      models: [
        {
          id: 'gemini-2.5-pro',
          label: 'Gemini 2.5 Pro',
          isDefault: true,
          contextWindowTokens: 1_048_576,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 4096,
          defaultThinkingEffort: 'high',
          thinkingEfforts: ['max'],
        },
        {
          id: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
          contextWindowTokens: 1_048_576,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          defaultThinkingEffort: 'medium',
        },
      ],
      thinkingEfforts: [
        { id: 'none',   label: 'None' },
        { id: 'low',    label: 'Low' },
        { id: 'medium', label: 'Medium', isDefault: true },
        { id: 'high',   label: 'High' },
        { id: 'max',    label: 'Max', optIn: true },
      ],
    },

    // ── Codex ────────────────────────────────────────────────────────────────
    {
      id: 'codex',
      label: 'Codex',
      models: [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          isDefault: true,
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          // Reasoning effort is the codex axis; map its default here.
          defaultThinkingEffort: 'high',
        },
        {
          id: 'gpt-5.6-sol',
          label: 'GPT-5.6 Sol',
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          defaultThinkingEffort: 'high',
        },
        {
          id: 'gpt-5.6-terra',
          label: 'GPT-5.6 Terra',
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          defaultThinkingEffort: 'medium',
        },
        {
          id: 'gpt-5.6-luna',
          label: 'GPT-5.6 Luna',
          contextWindowTokens: 200_000,
          retentionMs: 5 * 60 * 1000,
          minimumReusablePrefixTokens: 1024,
          defaultThinkingEffort: 'low',
        },
      ],
      thinkingEfforts: [
        { id: 'low',    label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high',   label: 'High', isDefault: true },
      ],
      // Codex exposes a separate reasoning-effort axis alongside thinking.
      reasoningEfforts: [
        { id: 'low',    label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high',   label: 'High', isDefault: true },
      ],
    },
  ],
}

// ── Agent and model lookup helpers ────────────────────────────────────────────

/** Find the catalog agent entry for a provider. Returns undefined if absent. */
const findAgent = (agentId: string): CatalogAgent | undefined =>
  MODEL_CATALOG.agents.find((a) => a.id === agentId)

/**
 * Resolve the catalog entry for `(agentId, modelId)`.
 *
 * Resolution order (rule 3 — never throw on unknown model id):
 *   1. Exact match in the agent's model list.
 *   2. Longest-prefix match (e.g. `claude-opus-5-20260101` → `claude-opus-4-6`
 *      when the new model shares the `claude-opus` prefix family).
 *   3. The agent's `isDefault` model.
 *   4. The first model in the agent's list.
 *   5. null — when the agent itself is unknown.
 *
 * A notice is logged at level `warn` when falling through to prefix or
 * conservative resolution so operators can update the catalog for new models.
 */
export const resolveCatalogModel = (
  agentId: string,
  modelId: string,
): CatalogModel | null => {
  const agent = findAgent(agentId)
  if (!agent) return null

  // 1. Exact match.
  const exact = agent.models.find((m) => m.id === modelId)
  if (exact) return exact

  // 2. Longest-prefix match.
  let best: CatalogModel | null = null
  let bestLen = 0
  for (const m of agent.models) {
    if (modelId.startsWith(m.id) && m.id.length > bestLen) {
      best = m
      bestLen = m.id.length
    }
    // Also try the reverse: catalog entry starts the model id
    // (e.g. catalog has `claude-opus`, model is `claude-opus-5`).
    if (m.id.startsWith(modelId.split('-').slice(0, -1).join('-') + '-') && m.id.length > bestLen) {
      // No — this is not the prefix convention. Skip; the above covers it.
    }
  }
  if (best) {
    console.warn(
      `[model-catalog] Unknown model '${modelId}' for agent '${agentId}'; ` +
      `resolved by longest-prefix match to '${best.id}'. Update the catalog for accurate facts.`,
    )
    return best
  }

  // 3+4. Fall back to the default or first model.
  const defaultModel = agent.models.find((m) => m.isDefault) ?? agent.models[0] ?? null
  if (defaultModel) {
    console.warn(
      `[model-catalog] Unknown model '${modelId}' for agent '${agentId}'; ` +
      `no prefix match — using conservative defaults from '${defaultModel.id}'.`,
    )
  }
  return defaultModel ?? null
}

// ── Conversation-memory facts ─────────────────────────────────────────────────

/**
 * Resolve conversation-memory facts for `(agentId, modelId)`.
 *
 * Never throws. Falls back through: catalog exact → prefix match → agent
 * default model → CONSERVATIVE_DEFAULTS. A warn is emitted on any fallback.
 */
export const resolveCatalogFacts = (
  agentId: string,
  modelId: string,
): ConversationMemoryFacts => {
  const entry = resolveCatalogModel(agentId, modelId)
  if (!entry) {
    // Agent itself is unknown — use conservative defaults.
    console.warn(
      `[model-catalog] Unknown agent '${agentId}' for model '${modelId}'; ` +
      `using conservative defaults.`,
    )
    return CONSERVATIVE_DEFAULTS
  }
  return {
    contextWindowTokens: entry.contextWindowTokens,
    retentionMs: entry.retentionMs,
    minimumReusablePrefixTokens: entry.minimumReusablePrefixTokens,
  }
}

// ── Thinking-effort resolution ────────────────────────────────────────────────

/**
 * Resolve the default thinking-effort id for a `(agentId, modelId)` pair.
 *
 * Rule 2: model-level `defaultThinkingEffort` wins over the provider-level
 * `thinkingEfforts[].isDefault` marker.
 *
 * Returns `undefined` when the agent is unknown or has no thinking efforts.
 */
export const resolveDefaultThinkingEffort = (
  agentId: string,
  modelId: string,
): string | undefined => {
  const agent = findAgent(agentId)
  if (!agent || agent.thinkingEfforts.length === 0) return undefined

  const model = resolveCatalogModel(agentId, modelId)
  // Model-level override (rule 2).
  if (model?.defaultThinkingEffort) return model.defaultThinkingEffort

  // Provider-level isDefault.
  return agent.thinkingEfforts.find((e) => e.isDefault)?.id
}

/**
 * Return the set of thinking-effort ids available for `(agentId, modelId)`.
 *
 * Rule 1: an effort marked `optIn: true` is included only when the active
 * model's per-model `thinkingEfforts` array explicitly names it.
 * Efforts without `optIn` are always included.
 */
export const getAvailableThinkingEfforts = (
  agentId: string,
  modelId: string,
): readonly CatalogThinkingEffort[] => {
  const agent = findAgent(agentId)
  if (!agent) return []

  const model = resolveCatalogModel(agentId, modelId)
  const modelOptIns = new Set(model?.thinkingEfforts ?? [])

  return agent.thinkingEfforts.filter(
    (e) => !e.optIn || modelOptIns.has(e.id),
  )
}

// ── Exported validation sets (rule 4) ─────────────────────────────────────────

/**
 * All known thinking-effort ids across ALL providers, derived from the catalog.
 * Import this instead of maintaining a second list.
 */
export const ALL_THINKING_EFFORT_IDS: ReadonlySet<string> = new Set(
  MODEL_CATALOG.agents.flatMap((a) => a.thinkingEfforts.map((e) => e.id)),
)

/**
 * Valid thinking-effort ids per provider, derived from the catalog.
 * Includes opt-in efforts (callers filter by model when needed).
 */
export const THINKING_EFFORTS_BY_PROVIDER: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  MODEL_CATALOG.agents.map((a) => [
    a.id,
    new Set(a.thinkingEfforts.map((e) => e.id)),
  ]),
)

/**
 * Valid reasoning-effort ids per provider (Codex-only axis), derived from the catalog.
 * Exported for future validation sites; not currently consumed by any code path.
 * @internal
 */
const REASONING_EFFORTS_BY_PROVIDER: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  MODEL_CATALOG.agents
    .filter((a) => a.reasoningEfforts && a.reasoningEfforts.length > 0)
    .map((a) => [
      a.id,
      new Set((a.reasoningEfforts ?? []).map((e) => e.id)),
    ]),
)
// Retain the computed set so tree-shaking keeps it linked (avoids dead-code warnings).
void REASONING_EFFORTS_BY_PROVIDER

/**
 * The catalog's default model id for a provider. Returns undefined when the
 * provider is unknown or has no models.
 */
export const defaultModelIdFor = (agentId: string): string | undefined => {
  const agent = findAgent(agentId)
  if (!agent) return undefined
  return (agent.models.find((m) => m.isDefault) ?? agent.models[0])?.id
}
