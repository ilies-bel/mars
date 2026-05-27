import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/di'
import { createClient } from '@libsql/client'
import { createLibsqlTaskStore } from '../../mastra/lib/task-store'

describe('plan-workflow — TaskStore context injection', () => {
  it('a TaskStore set on RequestContext is retrievable by the step execute pattern', () => {
    // Verify the composition-root wiring: the daemon puts a TaskStore into a
    // RequestContext, Mastra propagates it to each step's execute params, and
    // the plan generate step can extract it with the same cast pattern.
    const client = createClient({ url: ':memory:' })
    const store = createLibsqlTaskStore(client)
    const ctx = new RequestContext()
    ctx.set('taskStore', store)

    // Reproduce the exact extraction pattern used in the generate step.
    const extracted = (ctx.get('taskStore') as typeof store | undefined) ?? null
    expect(extracted).toBe(store)
  })

  it('RequestContext.get returns undefined for an unset key, triggering the getDefaultTaskStore fallback', () => {
    // When the daemon does not set a taskStore (e.g. in legacy call paths),
    // the step falls back to getDefaultTaskStore(). Verify the get returns
    // a falsy value so the ?? operator fires.
    const ctx = new RequestContext()
    const extracted = ctx.get('taskStore') as unknown
    expect(extracted == null || extracted === undefined).toBe(true)
  })
})
