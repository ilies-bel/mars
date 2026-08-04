import { describe, expect, it } from 'vitest'
import {
  assessStormExcerpt,
  hasUsableStormEvidence,
  stewardAgent,
  StewardEventSchema,
  renderStewardStormBrief,
  renderGateFixStewardBrief,
  STEWARD_GATE_FIX_TOOLS,
  STEWARD_STORM_TIMEOUT_MS,
  STEWARD_STORM_TOOLS,
  type StewardStormEvent,
} from './steward'
import { agents, getAgentSpec } from './index'

describe('stewardAgent — spec shape', () => {
  it('has id "steward"', () => {
    expect(stewardAgent.name).toBe('steward')
  })

  it('targets the correct model', () => {
    expect(stewardAgent.model).toBe('claude-sonnet-4-6')
  })

  it('has a non-empty systemPrompt', () => {
    expect(stewardAgent.systemPrompt.trim().length).toBeGreaterThan(0)
  })

  it('exposes the inputSchema', () => {
    expect(typeof stewardAgent.inputSchema.parse).toBe('function')
  })

  it('makes prompt optimization callable by the Steward', () => {
    expect(stewardAgent.allowedTools).toContain('PromptOptimize')
  })
})

describe('StewardEventSchema — parse behaviour', () => {
  it('accepts kpi-degraded events', () => {
    const result = StewardEventSchema.parse({
      kind: 'kpi-degraded',
      signal: 'p95_latency',
      delta: 0.42,
    })
    expect(result.kind).toBe('kpi-degraded')
  })

  it('accepts resource-load events', () => {
    const result = StewardEventSchema.parse({
      kind: 'resource-load',
      metric: 'cpu',
      value: 87.5,
    })
    expect(result.kind).toBe('resource-load')
  })

  it('accepts onboarding events', () => {
    const result = StewardEventSchema.parse({
      kind: 'onboarding',
      stack: 'next.js',
    })
    expect(result.kind).toBe('onboarding')
  })

  it('accepts workflow-suggestion events', () => {
    const result = StewardEventSchema.parse({
      kind: 'workflow-suggestion',
      workflowName: 'nightly-sweep',
      rationale: 'Detected repeated manual runs at 02:00 UTC',
    })
    expect(result.kind).toBe('workflow-suggestion')
  })

  it('accepts signature-storm events with a structured brief', () => {
    const result = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'code:coder-exit-nonzero/api-unreachable',
      streak: 3,
      affectedTaskIds: ['t1', 't2', 't3'],
      failureExcerpts: [
        { taskId: 't1', signature: 'code:coder-exit-nonzero/api-unreachable', excerpt: 'boom' },
      ],
    })
    expect(result.kind).toBe('signature-storm')
  })

  it('accepts a quarantined gate failure with its definition and evidence', () => {
    const result = StewardEventSchema.parse({
      kind: 'gate-systemic-failure',
      gate: { id: 'gate-1', scope: 'orchestrator', name: 'typecheck' },
      currentDefinition: {
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        required: true,
        tier: 'task',
      },
      quarantineSignature: 'verify:typecheck/exit-1',
      failureEvidence: 'error TS2322: Type string is not assignable to number',
    })
    expect(result.kind).toBe('gate-systemic-failure')
  })

  it('defaults failureExcerpts to an empty list', () => {
    const result = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'setup:install-failed/unclassified',
      streak: 3,
      affectedTaskIds: [],
    }) as StewardStormEvent
    expect(result.failureExcerpts).toEqual([])
  })

  it('rejects a signature-storm event missing the signature', () => {
    expect(() =>
      StewardEventSchema.parse({ kind: 'signature-storm', streak: 3, affectedTaskIds: [] }),
    ).toThrow()
  })

  it('rejects an unknown event kind', () => {
    expect(() =>
      StewardEventSchema.parse({ kind: 'unknown-event', foo: 'bar' }),
    ).toThrow()
  })

  it('rejects a kpi-degraded event missing required fields', () => {
    expect(() =>
      StewardEventSchema.parse({ kind: 'kpi-degraded' }),
    ).toThrow()
  })
})

describe('gate-systemic-failure dispatch', () => {
  const event = StewardEventSchema.parse({
    kind: 'gate-systemic-failure',
    gate: { id: 'gate-1', scope: 'orchestrator', name: 'typecheck' },
    currentDefinition: { cmd: 'npx', args: ['tsc', '--noEmit'], required: true, tier: 'task' },
    quarantineSignature: 'verify:typecheck/exit-1',
    failureEvidence: 'TypeScript reported an option that is no longer supported.',
  })

  it('uses repository-read tools and requires one structured proposal only', () => {
    expect(STEWARD_GATE_FIX_TOOLS).toEqual(['Read', 'Bash', 'Grep', 'Glob'])
    const rendered = renderGateFixStewardBrief(event as Extract<typeof event, { kind: 'gate-systemic-failure' }>)
    expect(rendered).toContain('"cmd"')
    expect(rendered).toContain('"args"')
    expect(rendered).toContain('"required"')
    expect(rendered).toContain('"tier"')
    expect(rendered).toContain('"rationale"')
    expect(rendered).toMatch(/do not apply|do not reactivate/i)
  })
})

describe('signature-storm dispatch — write-capable, not a read-only explainer', () => {
  const brief = StewardEventSchema.parse({
    kind: 'signature-storm',
    signature: 'code:coder-exit-nonzero/api-unreachable',
    streak: 4,
    affectedTaskIds: ['task-a', 'task-b'],
    failureExcerpts: [
      { taskId: 'task-a', signature: 'code:coder-exit-nonzero/api-unreachable', excerpt: 'ECONNREFUSED' },
    ],
  }) as StewardStormEvent

  it('grants edit tools — the breaker pausing dispatch for prose is the bug', () => {
    expect(STEWARD_STORM_TOOLS).toContain('Edit')
    expect(STEWARD_STORM_TOOLS).toContain('Write')
    expect(stewardAgent.allowedTools).toContain('Edit')
    expect(stewardAgent.deniedTools).toHaveLength(0)
  })

  it('renders the signature, streak, and affected task ids into the brief', () => {
    const rendered = renderStewardStormBrief(brief)
    expect(rendered).toContain('code:coder-exit-nonzero/api-unreachable')
    expect(rendered).toContain('Consecutive failing tasks: 4')
    expect(rendered).toContain('task-a, task-b')
  })

  it('inlines the failure excerpts so the run is self-contained', () => {
    const rendered = renderStewardStormBrief(brief)
    expect(rendered).toContain('ECONNREFUSED')
    expect(rendered).toContain('### task-a')
  })

  it('asks for a committed fix, not an explanation', () => {
    const rendered = renderStewardStormBrief(brief)
    expect(rendered).toMatch(/WRITE-CAPABLE/)
    expect(rendered).toMatch(/git commit/)
    expect(rendered).toMatch(/not a\n?read-only investigation/)
  })

  it('renders cleanly with no excerpts and no affected ids', () => {
    const empty = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'verify:has-diff/no-commits-ahead',
      streak: 3,
      affectedTaskIds: [],
    }) as StewardStormEvent
    const rendered = renderStewardStormBrief(empty)
    expect(rendered).toContain('(none recorded)')
    expect(rendered).not.toContain('## Failure excerpts')
  })
})

describe('storm evidence — "no evidence" must not masquerade as evidence', () => {
  // A sweep that re-drives already-failed tasks overwrote `tasks.error` with a
  // repeated `recovery_failed:<sig>:` chain. The Steward woke with a brief made
  // entirely of that padding, had nothing to diagnose, and silently produced
  // nothing. The brief has to be able to say "I have no evidence".
  const statusEcho =
    'recovery_failed:code/uncommitted-changes: '.repeat(12) +
    'recovery_exhausted:code/uncommitted-changes:'

  it('treats a recovery-status chain as unusable', () => {
    const assessed = assessStormExcerpt(statusEcho)
    expect(assessed.usable).toBe(false)
    expect(assessed.verdict).toBe('status-echo')
    expect(assessed.excerpt).toContain('no usable output was captured')
  })

  it('treats empty and whitespace-only error text as unusable', () => {
    expect(assessStormExcerpt(null).verdict).toBe('empty')
    expect(assessStormExcerpt('').verdict).toBe('empty')
    expect(assessStormExcerpt('   \n  ').verdict).toBe('empty')
  })

  it('passes real captured output through untouched', () => {
    const real =
      'FAIL src/core/daemon/__tests__/http-events.test.ts\n' +
      ' × responds 200 with the event page\n' +
      '   → expected 500 to be 200 // Object.is equality\n' +
      '   at src/core/daemon/__tests__/http-events.test.ts:41:24'
    const assessed = assessStormExcerpt(real)
    expect(assessed.usable).toBe(true)
    expect(assessed.verdict).toBe('ok')
    expect(assessed.excerpt).toBe(real)
  })

  it('keeps real output usable even when a status prefix is attached to it', () => {
    const mixed =
      'recovery_failed:verify/unclassified: ' +
      'Error: ENOSPC: no space left on device, write\n    at WriteStream._write (node:internal/fs/streams:425:5)'
    expect(assessStormExcerpt(mixed).usable).toBe(true)
  })

  it('tells the Steward out loud when nothing usable was captured', () => {
    const blind = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'code/uncommitted-changes',
      streak: 3,
      affectedTaskIds: ['fix-139f327c'],
      failureExcerpts: [
        {
          taskId: 'fix-139f327c',
          signature: 'code/uncommitted-changes',
          excerpt: assessStormExcerpt(statusEcho).excerpt,
          usable: false,
        },
      ],
    }) as StewardStormEvent

    expect(hasUsableStormEvidence(blind)).toBe(false)
    const rendered = renderStewardStormBrief(blind)
    expect(rendered).toContain('NO USABLE EVIDENCE')
    expect(rendered).toContain('No usable failure output was captured')
    expect(rendered).toContain('insufficient evidence to diagnose')
  })

  it('omits the no-evidence banner when at least one excerpt is real', () => {
    const sighted = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'code/uncommitted-changes',
      streak: 3,
      affectedTaskIds: ['mars-95f2318e'],
      failureExcerpts: [
        {
          taskId: 'mars-95f2318e',
          signature: 'code/uncommitted-changes',
          excerpt: 'error: Your local changes to the following files would be overwritten by merge',
          usable: true,
        },
      ],
    }) as StewardStormEvent

    expect(hasUsableStormEvidence(sighted)).toBe(true)
    expect(renderStewardStormBrief(sighted)).not.toContain('No usable failure output was captured')
  })

  it('defaults excerpts to usable so a caller cannot silently drop the flag', () => {
    const parsed = StewardEventSchema.parse({
      kind: 'signature-storm',
      signature: 'x/y',
      streak: 3,
      affectedTaskIds: [],
      failureExcerpts: [{ taskId: 't', signature: 'x/y', excerpt: 'boom' }],
    }) as StewardStormEvent
    expect(parsed.failureExcerpts[0].usable).toBe(true)
  })
})

describe('storm Steward budget', () => {
  it('bounds one run at 10 minutes — dispatch is paused for its whole duration', () => {
    expect(STEWARD_STORM_TIMEOUT_MS).toBe(10 * 60_000)
  })
})

describe('agent registry — steward entry', () => {
  it('exposes steward in the agents map', () => {
    expect(agents['steward']).toBeDefined()
  })

  it('resolves steward via getAgentSpec', () => {
    const spec = getAgentSpec('steward')
    expect(spec.name).toBe('steward')
  })

  it('steward spec in registry has an inputSchema', () => {
    const spec = agents['steward']
    expect(typeof spec.inputSchema?.parse).toBe('function')
  })
})
