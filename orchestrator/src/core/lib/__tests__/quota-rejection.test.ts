/**
 * Tests for the provider rate/spend-limit rejection handling path.
 *
 * The scenario: every dispatched coder immediately receives a
 * `rate_limit_event` with status='rejected' and resetsAt, followed by a
 * `result` event with is_error:true and api_error_status:429, then exits 1.
 *
 * Required behaviour (three acceptance criteria):
 * 1. `quotaRejected` is surfaced on the RunClaudeResult parsed from those events.
 * 2. The code step re-queues the task with its worktree intact — no failed
 *    status, no recovery fix-task row inserted, no recovery slot consumed.
 * 3. Dispatch pauses until resetsAt and raises exactly one
 *    level-triggered 'provider-rate-limited' action-queue row.
 *
 * Coverage split:
 *  - extractQuotaRejected: pure-function unit tests (no IO).
 *  - isQuotaRejectedAbortError / extractQuotaResetsAt: sentinel unit tests (no IO).
 *  - runClaudeCode integration: stub `claude` binary emits the exact event
 *    sequence and exits 1; assert RunClaudeResult.quotaRejected is non-null
 *    and resetsAt matches.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { extractQuotaRejected } from '../claude-stream'
import { QUOTA_REJECTED_ABORT_MESSAGE } from '../../../workflows/primitives/shared'
import { WorkflowTerminalError } from '../workflow-terminal-error'
import { runClaudeCode } from '../git/claude'
import type { ClaudeEvent } from '../claude-stream'

// ---------------------------------------------------------------------------
// Pure unit tests: extractQuotaRejected
// ---------------------------------------------------------------------------

describe('extractQuotaRejected', () => {
  it('returns null for an empty conversation', () => {
    expect(extractQuotaRejected([])).toBeNull()
  })

  it('returns null when no rate_limit_event or 429 result is present', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        is_error: false,
        session_id: 'abc',
      },
    ]
    expect(extractQuotaRejected(conversation)).toBeNull()
  })

  it('detects a rate_limit_event with status=rejected and captures resetsAt', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1783081200,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
        },
      } as unknown as ClaudeEvent,
      {
        type: 'result',
        subtype: 'error_api_error',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your monthly spend limit.",
        session_id: 's1',
      },
    ]
    const result = extractQuotaRejected(conversation)
    expect(result).not.toBeNull()
    expect(result?.resetsAt).toBe(1783081200)
  })

  it('uses the LAST rate_limit_event when multiple appear', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 100, rateLimitType: 'five_hour' },
      } as unknown as ClaudeEvent,
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 9999, rateLimitType: 'monthly' },
      } as unknown as ClaudeEvent,
    ]
    const result = extractQuotaRejected(conversation)
    expect(result?.resetsAt).toBe(9999)
  })

  it('returns null when rate_limit_event has status != rejected', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'throttled', resetsAt: 1783081200 },
      } as unknown as ClaudeEvent,
    ]
    // status is not 'rejected', so not a quota rejection
    expect(extractQuotaRejected(conversation)).toBeNull()
  })

  it('falls back to resetsAt=0 when rate_limit_event has no resetsAt', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected' },
      } as unknown as ClaudeEvent,
    ]
    const result = extractQuotaRejected(conversation)
    expect(result).not.toBeNull()
    expect(result?.resetsAt).toBe(0)
  })

  it('detects 429 result event alone (secondary signal) with resetsAt=0', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'result',
        subtype: 'error_api_error',
        is_error: true,
        api_error_status: 429,
        result: 'Rate limited',
        session_id: 's1',
      },
    ]
    const result = extractQuotaRejected(conversation)
    expect(result).not.toBeNull()
    expect(result?.resetsAt).toBe(0)
  })

  it('does not trigger on non-429 api_error_status', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'result',
        subtype: 'error_api_error',
        is_error: true,
        api_error_status: 500,
        result: 'Internal server error',
        session_id: 's1',
      },
    ]
    expect(extractQuotaRejected(conversation)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure unit tests: quota-rejection sentinel functions
// ---------------------------------------------------------------------------

describe('QUOTA_REJECTED_ABORT_MESSAGE sentinel — WorkflowTerminalError discriminant', () => {
  it('quota-rejected kind: WorkflowTerminalError carries the correct kind and resetsAt in meta', () => {
    const err = new WorkflowTerminalError('quota-rejected', QUOTA_REJECTED_ABORT_MESSAGE('task-abc', 1783081200), { resetsAt: 1783081200 })
    expect(err).toBeInstanceOf(WorkflowTerminalError)
    expect(err.kind).toBe('quota-rejected')
    expect(err.meta.resetsAt).toBe(1783081200)
    expect(err.message).toContain('task-abc')
  })

  it('plain Error is not instanceof WorkflowTerminalError', () => {
    const err = new Error(QUOTA_REJECTED_ABORT_MESSAGE('task-abc', 1783081200))
    expect(err instanceof WorkflowTerminalError).toBe(false)
  })

  it('resetsAt defaults to undefined when not provided in meta', () => {
    const err = new WorkflowTerminalError('quota-rejected', 'quota hit')
    expect(err.kind).toBe('quota-rejected')
    expect(err.meta.resetsAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration test: stub claude binary emitting the rate_limit event sequence
// ---------------------------------------------------------------------------

/**
 * Write a stub `claude` binary that emits:
 * 1. system/init
 * 2. rate_limit_event with status=rejected and a resetsAt timestamp
 * 3. result with is_error:true, api_error_status:429
 * Then exits with code 1, writing nothing to stderr.
 *
 * This mirrors the exact sequence observed in the .mars/watch.log incident.
 */
const writeQuotaRejectionStub = (
  stubDir: string,
  sessionId: string,
  resetsAt: number,
): void => {
  const stubPath = resolve(stubDir, 'claude')
  const stubScript = `#!/usr/bin/env node
const sessionId = ${JSON.stringify(sessionId)};
const resetsAt = ${resetsAt};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: resetsAt,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
  },
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'error_api_error',
  is_error: true,
  api_error_status: 429,
  result: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
  session_id: sessionId,
}) + '\\n');
// No stderr output — the real claude CLI behaves this way on spend-limit rejections.
process.exit(1);
`
  writeFileSync(stubPath, stubScript, 'utf8')
  chmodSync(stubPath, 0o755)
}

describe('runClaudeCode — quota rejection event sequence', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-quota-rejection-stub-'))
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('surfaces quotaRejected with correct resetsAt when rate_limit_event is emitted', async () => {
    const resetsAt = 1783081200
    writeQuotaRejectionStub(stubDir, 'quota-test-session', resetsAt)

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    // The stub exits non-zero with no stderr.
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('')

    // quotaRejected must be non-null and carry the resetsAt from the event.
    expect(r.quotaRejected).not.toBeNull()
    expect(r.quotaRejected?.resetsAt).toBe(resetsAt)
  }, 15_000)

  it('captures the rate_limit_event in the conversation for observability', async () => {
    const resetsAt = 1783081200
    writeQuotaRejectionStub(stubDir, 'quota-obs-session', resetsAt)

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    const rateLimitEvent = r.conversation.find((e) => e.type === 'rate_limit_event')
    expect(rateLimitEvent).toBeDefined()
    const info = (rateLimitEvent as { rate_limit_info?: { status: string; resetsAt: number } }).rate_limit_info
    expect(info?.status).toBe('rejected')
    expect(info?.resetsAt).toBe(resetsAt)
  }, 15_000)

  it('quotaRejected is null for a normal zero-exit run (no rate_limit_event)', async () => {
    // Write a stub that exits 0 with no rate_limit events.
    const stubPath = resolve(stubDir, 'claude')
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node
const sessionId = 'ok-session';
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: sessionId,
}) + '\\n');
process.exit(0);
`,
      'utf8',
    )
    chmodSync(stubPath, 0o755)

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    expect(r.exitCode).toBe(0)
    expect(r.quotaRejected).toBeNull()
  }, 15_000)
})
