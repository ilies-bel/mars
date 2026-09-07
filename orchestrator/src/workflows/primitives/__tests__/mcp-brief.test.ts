import { describe, expect, it } from 'vitest'
import { DEVIATION_RULES } from '../shared'
import { buildWorkerEnv } from '../../../core/lib/git/claude'
import { WORKER_TOOL_MATRIX } from '../../../core/mcp/worker-server'

describe('DEVIATION_RULES — worker-safe MCP tools', () => {
  it('directs dispatched coders to use the worker-safe Mars MCP tools', () => {
    expect(DEVIATION_RULES).toContain('mars_task_note')
    expect(DEVIATION_RULES).toContain('mars_task_check')
    expect(DEVIATION_RULES).toContain('mars_task_add_blocked_followup')
    expect(DEVIATION_RULES).toContain('mars_proposal_add_draft')
  })
})

describe('buildWorkerEnv — MARS_MCP_TASK_ID and MARS_MCP_WORKER_CLASS stamping', () => {
  it('stamps MARS_MCP_TASK_ID when a task id is provided (Planner dispatch)', () => {
    const env = buildWorkerEnv('mars-planner-abc', 'Planner')
    expect(env['MARS_MCP_TASK_ID']).toBe('mars-planner-abc')
  })

  it('stamps MARS_MCP_WORKER_CLASS when a worker class is provided (Planner dispatch)', () => {
    const env = buildWorkerEnv('mars-planner-abc', 'Planner')
    expect(env['MARS_MCP_WORKER_CLASS']).toBe('Planner')
  })

  it('does not stamp MARS_MCP_WORKER_CLASS when workerClass is omitted', () => {
    const env = buildWorkerEnv('mars-task-xyz')
    expect(env['MARS_MCP_WORKER_CLASS']).toBeUndefined()
  })

  it('does not set MARS_MCP_WORKER_CLASS when workerClass arg is omitted', () => {
    // buildWorkerEnv without a workerClass arg must not introduce a new
    // MARS_MCP_WORKER_CLASS key. (MARS_MCP_TASK_ID is intentionally not tested
    // here because it may be set in process.env for the running test process.)
    const originalClass = process.env['MARS_MCP_WORKER_CLASS']
    delete process.env['MARS_MCP_WORKER_CLASS']
    try {
      const env = buildWorkerEnv('mars-task-xyz')
      expect(env['MARS_MCP_WORKER_CLASS']).toBeUndefined()
    } finally {
      if (originalClass !== undefined) process.env['MARS_MCP_WORKER_CLASS'] = originalClass
    }
  })
})

describe('WORKER_TOOL_MATRIX — per-class tool gating', () => {
  it('Planner does not receive mars_task_check (done-criterion ticking is not its role)', () => {
    expect(WORKER_TOOL_MATRIX['Planner']).not.toContain('mars_task_check')
  })

  it('Planner receives mars_task_note and mars_task_context', () => {
    expect(WORKER_TOOL_MATRIX['Planner']).toContain('mars_task_note')
    expect(WORKER_TOOL_MATRIX['Planner']).toContain('mars_task_context')
  })

  it('Coder receives all three tools including mars_task_check', () => {
    expect(WORKER_TOOL_MATRIX['Coder']).toContain('mars_task_note')
    expect(WORKER_TOOL_MATRIX['Coder']).toContain('mars_task_check')
    expect(WORKER_TOOL_MATRIX['Coder']).toContain('mars_task_context')
  })
})
