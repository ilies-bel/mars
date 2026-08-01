// Pre-flight context budget enforcement (input side) and the coherence of the
// per-worker budget values themselves.
//
// Before this seam, WORKER_CONFIGS.maxContextTokens was enforced ONLY inside
// runClaudeCode's event loop — so on any provider other than Claude the value
// was dead config, and a run whose prompt could never fit burned a full agent
// invocation before dying mid-way.

import { describe, expect, it } from 'vitest'
import {
  WORKER_CONFIGS,
  Workers,
  createWorker,
  estimatePromptTokens,
  assertPromptFitsContextBudget,
  HARNESS_CONTEXT_FLOOR_TOKENS,
  NO_TOOL_USE_DENIED_TOOLS,
  deniesAllToolUse,
  providerModel,
  WORKER_PROVIDER,
  type WorkerName,
  type WorkerConfig,
} from '..'
import {
  PROVIDERS,
  reportsContextOccupancy,
} from '../providers'
import { PROVIDER_MODELS, type HeadlessRunOpts } from '../provider-types'
import type { RunClaudeResult } from '../../lib/git/claude'

const workerNames = Object.keys(WORKER_CONFIGS) as WorkerName[]

describe('estimatePromptTokens', () => {
  it('approximates four characters per token', () => {
    expect(estimatePromptTokens('')).toBe(0)
    expect(estimatePromptTokens('abcd')).toBe(1)
    expect(estimatePromptTokens('x'.repeat(4000))).toBe(1000)
  })

  it('rounds up so a sub-token remainder is never dropped', () => {
    expect(estimatePromptTokens('abcde')).toBe(2)
  })
})

describe('assertPromptFitsContextBudget', () => {
  const config = (maxContextTokens: number): WorkerConfig => ({
    ...WORKER_CONFIGS.Triager,
    name: 'TestWorker',
    maxContextTokens,
  })

  it('passes when the prompt fits the budget', () => {
    expect(() => assertPromptFitsContextBudget(config(1000), 'x'.repeat(4000))).not.toThrow()
  })

  it('throws with an actionable message when the prompt cannot fit', () => {
    expect(() => assertPromptFitsContextBudget(config(1000), 'x'.repeat(8000))).toThrow(
      /TestWorker: prompt does not fit the context budget.*~2000 estimated prompt tokens vs maxContextTokens=1000/s,
    )
  })

  it('is disabled by a budget of 0', () => {
    expect(() => assertPromptFitsContextBudget(config(0), 'x'.repeat(10_000_000))).not.toThrow()
  })
})

describe('worker.run pre-flight', () => {
  it('fails fast — without dispatching — when the prompt exceeds the budget', async () => {
    // A budget deliberately smaller than the prompt. If the pre-flight did not
    // fire, run() would try to spawn the provider CLI.
    const worker = createWorker({ ...WORKER_CONFIGS.Triager, maxContextTokens: 10 })
    await expect(worker.run('x'.repeat(4000), { cwd: process.cwd() })).rejects.toThrow(
      /prompt does not fit the context budget/,
    )
  })

  it('runs on every provider, including ones that cannot report occupancy', async () => {
    for (const provider of ['claude', 'codex', 'gemini'] as const) {
      const worker = createWorker({
        ...WORKER_CONFIGS.Triager,
        provider,
        maxContextTokens: 10,
      })
      await expect(worker.run('x'.repeat(4000), { cwd: process.cwd() })).rejects.toThrow(
        /prompt does not fit the context budget/,
      )
    }
  })
})

describe('per-worker context budgets are coherent', () => {
  it('every built-in Worker declares a positive budget', () => {
    for (const name of workerNames) {
      expect(WORKER_CONFIGS[name].maxContextTokens, `${name} budget`).toBeGreaterThan(0)
    }
  })

  it('every budget clears the harness context floor', () => {
    // A budget below the floor rejects work that has not overflowed anything:
    // the harness occupies that much before the task prompt is even read.
    // Triager and Scorer both used to sit at 50k, under the floor.
    for (const name of workerNames) {
      expect(
        WORKER_CONFIGS[name].maxContextTokens,
        `${name} budget must exceed HARNESS_CONTEXT_FLOOR_TOKENS`,
      ).toBeGreaterThan(HARNESS_CONTEXT_FLOOR_TOKENS)
    }
  })
})

describe('in-run context-overflow handling skips providers without occupancy', () => {
  it('reportsContextOccupancy is true only for the per-request provider', () => {
    expect(reportsContextOccupancy(PROVIDERS.claude.headless)).toBe(true)
    expect(reportsContextOccupancy(PROVIDERS.codex.headless)).toBe(false)
    expect(reportsContextOccupancy(PROVIDERS.gemini.headless)).toBe(false)
  })

  it('threads the budget to a per-request adapter and zero to a cumulative one', async () => {
    const seen: Array<number | undefined> = []
    const restore: Array<() => void> = []
    const stub = (providerName: 'claude' | 'codex'): void => {
      const adapter = PROVIDERS[providerName].headless as {
        run: (prompt: string, opts: HeadlessRunOpts) => Promise<RunClaudeResult>
      }
      const original = adapter.run
      adapter.run = async (_prompt, opts) => {
        seen.push(opts.maxContextTokens)
        throw new Error('stop')
      }
      restore.push(() => {
        adapter.run = original
      })
    }
    stub('claude')
    stub('codex')
    try {
      const claudeWorker = createWorker({ ...WORKER_CONFIGS.Triager, provider: 'claude' })
      const codexWorker = createWorker({ ...WORKER_CONFIGS.Triager, provider: 'codex' })
      await expect(claudeWorker.run('hi', { cwd: process.cwd() })).rejects.toThrow('stop')
      await expect(codexWorker.run('hi', { cwd: process.cwd() })).rejects.toThrow('stop')
    } finally {
      for (const r of restore) r()
    }
    expect(seen[0]).toBe(WORKER_CONFIGS.Triager.maxContextTokens)
    // Codex reports cumulative spend, not occupancy — comparing it against a
    // context window is what produced `289216/50000`. The budget is withheld.
    expect(seen[1]).toBe(0)
  })
})

describe('Triager is pinned as a cheap classification call', () => {
  it('runs on the fast model tier at low reasoning effort', () => {
    const cfg = Workers.Triager.config
    // The TIER is the pin, not a native model id: whichever provider the
    // daemon runs (Codex by default) resolves its own cheapest model.
    expect(cfg.model).toBe(providerModel(WORKER_PROVIDER, 'fast'))
    expect(cfg.model).toBe(PROVIDER_MODELS[WORKER_PROVIDER].fast)
    expect(cfg.effort).toBe('low')
  })

  it('gets no MCP servers injected — deny-listing tools cannot name mcp__* tools', async () => {
    // A taskId on the dispatch is what injects the mars-worker (and with it
    // codegraph) MCP servers. Handing those to a no-tools Worker would give
    // back exactly the repo-browsing surface the deny-list removed.
    expect(deniesAllToolUse(WORKER_CONFIGS.Triager)).toBe(true)
    expect(deniesAllToolUse(WORKER_CONFIGS.Coder)).toBe(false)

    // Stub whichever provider the daemon actually runs the Triager on —
    // Codex by default — not a hardcoded one.
    const adapter = PROVIDERS[WORKER_PROVIDER].headless as {
      run: (prompt: string, opts: HeadlessRunOpts) => Promise<RunClaudeResult>
    }
    const original = adapter.run
    let seenTaskId: string | undefined = 'unset'
    adapter.run = async (_prompt, opts) => {
      seenTaskId = opts.taskId
      throw new Error('stop')
    }
    try {
      await expect(
        Workers.Triager.run('hi', { cwd: process.cwd(), taskId: 'mars-123' }),
      ).rejects.toThrow('stop')
    } finally {
      adapter.run = original
    }
    expect(seenTaskId).toBeUndefined()
  })

  it('is denied the entire tool surface — it answers from its prompt', () => {
    const denied = new Set(Workers.Triager.config.disallowedTools)
    for (const tool of NO_TOOL_USE_DENIED_TOOLS) {
      expect(denied.has(tool), `Triager must deny ${tool}`).toBe(true)
    }
    // Read/Grep/Glob/Bash in particular: read-only is NOT no-tools, and repo
    // browsing is exactly the spend this pin removes.
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Task', 'WebFetch']) {
      expect(denied.has(tool), `Triager must deny ${tool}`).toBe(true)
    }
  })
})
