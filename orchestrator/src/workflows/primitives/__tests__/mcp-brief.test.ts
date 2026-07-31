import { describe, expect, it } from 'vitest'
import { DEVIATION_RULES } from '../shared'

describe('DEVIATION_RULES — worker-safe MCP tools', () => {
  it('directs dispatched coders to use the worker-safe Mars MCP tools', () => {
    expect(DEVIATION_RULES).toContain('mars_task_note')
    expect(DEVIATION_RULES).toContain('mars_task_check')
    expect(DEVIATION_RULES).toContain('mars_task_add_blocked_followup')
    expect(DEVIATION_RULES).toContain('mars_proposal_add_draft')
  })
})
