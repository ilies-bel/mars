/**
 * Unit tests for the viewStepPrompt projection in AppServices and its
 * transcript-recovery helpers.
 *
 * Tests observable behaviour through the public interface:
 * createAppServices({ traceStore }).viewStepPrompt({ workflowInstanceId,
 * stepName }). Covers all three resolution outcomes:
 *   - 'persisted'  — promptText present on the step_started payload,
 *   - 'recovered'  — pre-persistence run, prompt pulled from stored
 *                    transcripts (streaming chunks / durable blob / on-disk
 *                    JSONL via the helper's baseDir seam),
 *   - null         — nothing queryable anywhere.
 *
 * Uses a real TraceEventStore backed by a temp SQLite file so the payload
 * substring filter (q) and the chunk/durable transcript paths execute for
 * real.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTraceEventStore, type TraceEventStore } from '../trace-events-store'
import { openLibsql } from '../libsql'
import type { Client } from '@libsql/client'
import { createAppServices } from '../../app-services'
import type { AppServices } from '../../app-services'
import {
  extractFirstUserMessageText,
  recoverPromptFromDiskTranscript,
} from '../step-prompt-recovery'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-step-prompt-'))
  return join(dir, 'mars.db')
}

/** Build a minimal AppServices with only the trace store wired in. */
const makeServices = (traceStore: TraceEventStore): AppServices =>
  createAppServices({
    traceStore,
    buildAlertSources: async () => ({
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }),
  })

const insertStarted = async (
  client: Client,
  opts: {
    taskId: string | null
    workflowInstanceId: string
    stepName: string
    timestamp: string
    promptText?: string
  },
): Promise<void> => {
  const payload: Record<string, unknown> = {
    stepName: opts.stepName,
    workflowInstanceId: opts.workflowInstanceId,
    workerName: 'Coder',
  }
  if (opts.promptText !== undefined) payload.promptText = opts.promptText
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'step_started', 'info', ?, NULL, 'code', ?)`,
    args: [randomUUID(), Date.parse(opts.timestamp), opts.taskId, JSON.stringify(payload)],
  })
}

const insertEnded = async (
  client: Client,
  opts: {
    taskId: string | null
    workflowInstanceId: string
    stepName: string
    timestamp: string
    sessionId?: string
  },
): Promise<void> => {
  const payload: Record<string, unknown> = {
    stepName: opts.stepName,
    workflowInstanceId: opts.workflowInstanceId,
    outcome: 'completed',
    durationMs: 100,
  }
  if (opts.sessionId !== undefined) payload.sessionId = opts.sessionId
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'step_ended', 'info', ?, NULL, 'code', ?)`,
    args: [randomUUID(), Date.parse(opts.timestamp), opts.taskId, JSON.stringify(payload)],
  })
}

/** A claude stream-json user event carrying `text` as its first message. */
const userEvent = (text: string): Record<string, unknown> => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

describe('viewStepPrompt — resolution outcomes', () => {
  let dbPath: string
  let store: TraceEventStore
  let client: Client
  let svc: AppServices

  beforeEach(async () => {
    dbPath = tmpDbPath()
    store = await openTraceEventStore(dbPath)
    client = openLibsql({ url: `file:${dbPath}` })
    svc = makeServices(store)
  })

  afterEach(async () => {
    client.close()
    await store.close()
  })

  it('returns the persisted promptText with source=persisted', async () => {
    await insertStarted(client, {
      taskId: 'task-A',
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:00.000Z',
      promptText: 'You are the Coder. <files>a.ts</files> Save your work.',
    })

    const result = await svc.viewStepPrompt({
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
    })

    expect(result).toEqual({
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
      prompt: 'You are the Coder. <files>a.ts</files> Save your work.',
      source: 'persisted',
    })
  })

  it('resolves by exact (workflowInstanceId, stepName) — not by substring collision', async () => {
    await insertStarted(client, {
      taskId: 'task-A',
      workflowInstanceId: 'wf-1',
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:00.000Z',
      promptText: 'coder prompt',
    })
    await insertStarted(client, {
      taskId: 'task-A',
      workflowInstanceId: 'wf-1',
      stepName: 'verify',
      timestamp: '2025-01-01T10:01:00.000Z',
      promptText: 'verify prompt',
    })

    const result = await svc.viewStepPrompt({
      workflowInstanceId: 'wf-1',
      stepName: 'verify',
    })

    expect(result.prompt).toBe('verify prompt')
    expect(result.source).toBe('persisted')
  })

  it('recovers the prompt from streaming transcript chunks when not persisted', async () => {
    const taskId = 'task-rec'
    const sessionId = 'sess-rec-1'
    await insertStarted(client, {
      taskId,
      workflowInstanceId: 'wf-rec',
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:00.000Z',
      // no promptText — pre-persistence run
    })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: 'wf-rec',
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:05.000Z',
      sessionId,
    })
    await store.appendTranscriptChunk!(taskId, sessionId, 0, [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' },
      userEvent('the composed prompt recovered from chunks'),
      { type: 'assistant', message: { role: 'assistant', content: [] } },
    ])

    const result = await svc.viewStepPrompt({
      workflowInstanceId: 'wf-rec',
      stepName: 'run-claude-code',
    })

    expect(result.prompt).toBe('the composed prompt recovered from chunks')
    expect(result.source).toBe('recovered')
  })

  it('recovers from the durable transcript blob when chunks are absent', async () => {
    const taskId = 'task-dur'
    await insertStarted(client, {
      taskId,
      workflowInstanceId: 'wf-dur',
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:00.000Z',
    })
    // No step_ended (no sessionId) — chunk and disk tiers are skipped.
    await store.appendDurableTranscript!(
      taskId,
      'sess-dur-1',
      'run-claude-code',
      JSON.stringify([userEvent('the composed prompt from the durable blob')]),
    )

    const result = await svc.viewStepPrompt({
      workflowInstanceId: 'wf-dur',
      stepName: 'run-claude-code',
    })

    expect(result.prompt).toBe('the composed prompt from the durable blob')
    expect(result.source).toBe('recovered')
  })

  it('returns null/null when the step exists but nothing is recoverable', async () => {
    await insertStarted(client, {
      taskId: 'task-nul',
      workflowInstanceId: 'wf-nul',
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:00.000Z',
    })

    const result = await svc.viewStepPrompt({
      workflowInstanceId: 'wf-nul',
      stepName: 'run-claude-code',
    })

    expect(result).toEqual({
      workflowInstanceId: 'wf-nul',
      stepName: 'run-claude-code',
      prompt: null,
      source: null,
    })
  })

  it('returns null/null for an unknown (workflowInstanceId, stepName)', async () => {
    const result = await svc.viewStepPrompt({
      workflowInstanceId: 'wf-ghost',
      stepName: 'no-such-step',
    })

    expect(result.prompt).toBeNull()
    expect(result.source).toBeNull()
  })
})

describe('extractFirstUserMessageText', () => {
  it('extracts text from an array-of-blocks user message', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'later' }] } },
    ]
    expect(extractFirstUserMessageText(events)).toBe('hello')
  })

  it('extracts a plain-string content user message', () => {
    const events = [{ type: 'user', message: { role: 'user', content: 'plain prompt' } }]
    expect(extractFirstUserMessageText(events)).toBe('plain prompt')
  })

  it('joins multiple text blocks with newlines', () => {
    const events = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'tool_result', content: 'ignored' },
            { type: 'text', text: 'part two' },
          ],
        },
      },
    ]
    expect(extractFirstUserMessageText(events)).toBe('part one\npart two')
  })

  it('returns null when no user message carries text', () => {
    expect(extractFirstUserMessageText([])).toBeNull()
    expect(extractFirstUserMessageText([{ type: 'assistant' }])).toBeNull()
    expect(
      extractFirstUserMessageText([{ type: 'user', message: { role: 'user', content: [] } }]),
    ).toBeNull()
  })
})

describe('recoverPromptFromDiskTranscript', () => {
  it('finds the session JSONL under any project directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mars-claude-projects-'))
    mkdirSync(join(base, '-Users-x-repo'), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify(userEvent('prompt recovered from disk')),
    ].join('\n')
    writeFileSync(join(base, '-Users-x-repo', 'sess-disk-1.jsonl'), lines)

    const text = await recoverPromptFromDiskTranscript('sess-disk-1', base)
    expect(text).toBe('prompt recovered from disk')
  })

  it('returns null for a missing session or unsafe id', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mars-claude-projects-'))
    expect(await recoverPromptFromDiskTranscript('sess-none', base)).toBeNull()
    expect(await recoverPromptFromDiskTranscript('../etc/passwd', base)).toBeNull()
    expect(await recoverPromptFromDiskTranscript('', base)).toBeNull()
  })
})
