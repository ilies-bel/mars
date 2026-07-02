/**
 * `run` command group: `run show <taskId>`.
 *
 * Renders the workflow run timeline for a task as aligned plain-text rows.
 * Reads from the daemon's `GET /view/runs/:taskId` endpoint (ADR-0055).
 * If the daemon is not running the command fails fast with an actionable
 * error — the timeline data lives in the daemon's trace store.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from '../command'
import type { RunTimeline, RunTimelineStep } from '../../core/daemon/http-server'

const NO_DAEMON_MSG =
  'run show: daemon not running — run `mars daemon start` (the run timeline is served by the daemon)'

const readDaemonPort = async (stateDir: string): Promise<number | null> => {
  try {
    const raw = (await readFile(join(stateDir, 'http.port'), 'utf8')).trim()
    const port = Number(raw)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/** Format a duration as a human-readable string. */
const fmtDuration = (ms: number | null): string => {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Status glyph for aligned table output. */
const STATUS_GLYPH: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  killed: '⚡',
  running: '…',
}

/** Build the one-line detail column for a step. */
const stepDetail = (step: RunTimelineStep): string => {
  if (step.failureReason) return `FAIL: ${step.failureReason}`
  if (step.claudeSessionId) return `session:${step.claudeSessionId.slice(0, 8)}`
  return step.phase ?? '-'
}

/** Render the token column: null fields are omitted. */
const fmtTokens = (
  inp: number | null,
  out: number | null,
  cache: number | null,
): string => {
  if (inp === null && out === null) return '-'
  const parts: string[] = []
  if (inp !== null) parts.push(`↓${inp.toLocaleString('en-US')}`)
  if (out !== null) parts.push(`↑${out.toLocaleString('en-US')}`)
  if (cache !== null && cache > 0) parts.push(`cache:${cache.toLocaleString('en-US')}`)
  return parts.join(' ')
}

const STEP_COL = 28
const STATUS_COL = 2
const DUR_COL = 8
const TOK_COL = 22
const SEP = '  '

const renderTimeline = (
  timeline: RunTimeline,
  out: (s: string) => void,
): void => {
  if (timeline.runs.length === 0) {
    out(`task ${timeline.taskId}: no run data recorded yet`)
    return
  }

  let totalDurationMs = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let runIndex = 0

  for (const run of timeline.runs) {
    runIndex++
    out(`run ${runIndex}  id:${run.runId}  started:${run.startedAt}`)

    // Header row
    out(
      SEP +
        'step'.padEnd(STEP_COL) +
        SEP +
        'st'.padEnd(STATUS_COL) +
        SEP +
        'dur'.padEnd(DUR_COL) +
        SEP +
        'tokens'.padEnd(TOK_COL) +
        SEP +
        'detail',
    )
    out(
      SEP +
        '─'.repeat(STEP_COL) +
        SEP +
        '─'.repeat(STATUS_COL) +
        SEP +
        '─'.repeat(DUR_COL) +
        SEP +
        '─'.repeat(TOK_COL) +
        SEP +
        '─'.repeat(20),
    )

    for (const step of run.steps) {
      const glyph = STATUS_GLYPH[step.status] ?? '?'
      const dur = fmtDuration(step.durationMs)
      const tokens = fmtTokens(step.inputTokens, step.outputTokens, step.cacheReadTokens)
      const detail = stepDetail(step)

      out(
        SEP +
          step.stepName.padEnd(STEP_COL) +
          SEP +
          glyph.padEnd(STATUS_COL) +
          SEP +
          dur.padEnd(DUR_COL) +
          SEP +
          tokens.padEnd(TOK_COL) +
          SEP +
          detail,
      )

      if (step.durationMs !== null) totalDurationMs += step.durationMs
      if (step.inputTokens !== null) totalInputTokens += step.inputTokens
      if (step.outputTokens !== null) totalOutputTokens += step.outputTokens
      if (step.cacheReadTokens !== null) totalCacheReadTokens += step.cacheReadTokens
    }
    out('')
  }

  // Totals row
  out(
    'total' +
      '  wall:' +
      fmtDuration(totalDurationMs) +
      '  tokens: ↓' +
      totalInputTokens.toLocaleString('en-US') +
      ' ↑' +
      totalOutputTokens.toLocaleString('en-US') +
      ' cache:' +
      totalCacheReadTokens.toLocaleString('en-US'),
  )
}

const runShow: Command = {
  path: 'run show',
  summary: 'show workflow run timeline for a task',
  usage: 'usage: mars run show <taskId>',
  run: async (args, deps) => {
    const taskId = args.positional[0]
    if (!taskId) {
      deps.err('usage: mars run show <taskId>')
      return { code: 2 }
    }

    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }

    let timeline: RunTimeline
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/runs/${encodeURIComponent(taskId)}`,
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        const msg =
          typeof body.error === 'string' ? body.error : `daemon returned ${res.status}`
        deps.err(`run show: ${msg}`)
        return { code: 1 }
      }
      timeline = (await res.json()) as RunTimeline
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }

    renderTimeline(timeline, deps.out)
    return { code: 0 }
  },
}

const runGroup: Command = {
  path: 'run',
  summary: 'run subcommands',
  usage: 'usage: mars run <show> ...',
  run: (_args, deps) => {
    deps.err('usage: mars run <show> ...')
    return { code: 1 }
  },
}

export const runCommands: readonly Command[] = [runShow, runGroup]
