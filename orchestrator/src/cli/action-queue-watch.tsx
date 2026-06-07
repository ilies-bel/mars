/**
 * Mars Action-Queue Cockpit TUI — what `mars action-queue watch` renders.
 *
 * Connects directly to the Mars daemon HTTP API. The daemon port is discovered
 * by reading `.mars/http.port` — never guessed or taken from an environment
 * variable (a guessed-port 200 is often an unrelated server). Initial state
 * comes from GET /view/action-queue?filter=open. The view stays live over the
 * daemon's SSE channel at GET /view/stream: on each 'action-queue' or 'tasks'
 * event the full projection is re-fetched and re-rendered. A reconnect loop
 * survives daemon restarts without killing the TUI.
 *
 * Renders the full ActionQueueRow projection — failed-task, stale-worktree,
 * draft-proposal, and the synthetic daemon-killed-batch row — sorted by
 * priority then recency. No mutating actions in this slice (read path only).
 *
 * Keybindings:
 *   - j/k or arrows : move cursor
 *   - enter         : open detail view
 *   - b or escape   : back from detail
 *   - q or ctrl-c   : quit
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStateDir } from '../core/context'
import type { ActionQueueRow } from '../core/daemon/view/action-queue'

// ─── port discovery ───────────────────────────────────────────────────────────

/**
 * Read the daemon's HTTP base URL from `<stateDir>/http.port`.
 * Returns null when the file is absent or contains a non-integer port.
 *
 * Exported so the data-discovery path is independently testable.
 */
export const resolveDaemonBaseUrl = (stateDir: string): string | null => {
  try {
    const raw = readFileSync(join(stateDir, 'http.port'), 'utf8').trim()
    const port = Number(raw)
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null
  } catch {
    return null
  }
}

// ─── display helpers ──────────────────────────────────────────────────────────

const formatRelativeMs = (ts: number, now: number): string => {
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000))
  if (diffSec < 5) return 'now'
  if (diffSec < 60) return `${diffSec}s ago`
  const m = Math.floor(diffSec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const shortId = (id: string): string => (id.length <= 8 ? id : id.slice(0, 8))

const kindColor = (kind: ActionQueueRow['kind']): string => {
  if (kind === 'failed-task') return 'red'
  if (kind === 'stale-worktree') return 'yellow'
  return 'magenta' // draft-proposal
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface RowProps {
  row: ActionQueueRow
  selected: boolean
  now: number
}

const Row: React.FC<RowProps> = ({ row, selected, now }) => {
  const ts = Date.parse(row.at)
  const rel = Number.isNaN(ts) ? row.at : formatRelativeMs(ts, now)
  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '> ' : '  '}</Text>
      <Text color={kindColor(row.kind)}>{row.kind}</Text>
      <Text> </Text>
      <Text dimColor>{shortId(row.entityId)}</Text>
      <Text>  </Text>
      <Text>{row.title}</Text>
      <Text>  </Text>
      <Text dimColor>{rel}</Text>
    </Box>
  )
}

// ─── Detail ───────────────────────────────────────────────────────────────────

interface DetailProps {
  row: ActionQueueRow
  now: number
}

const Detail: React.FC<DetailProps> = ({ row, now }) => {
  const ts = Date.parse(row.at)
  const rel = Number.isNaN(ts) ? row.at : formatRelativeMs(ts, now)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold>
          {row.kind} · {row.entityId}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{row.title}</Text>
      </Box>
      {!!row.body && (
        <Box marginTop={1}>
          <Text>{row.body}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>id:       {row.id}</Text>
        <Text dimColor>priority: {row.priority}</Text>
        <Text dimColor>at:       {rel}</Text>
        {!!row.errorKind && row.errorKind !== 'unknown' && (
          <Text dimColor>error:    {row.errorKind}</Text>
        )}
        {!!row.failureReasonCode && (
          <Text dimColor>code:     {row.failureReasonCode}</Text>
        )}
        {!!row.fixForTaskId && (
          <Text dimColor>fix for:  {row.fixForTaskId}</Text>
        )}
      </Box>
      {row.dag && (
        <Box marginTop={1} flexDirection="column">
          {!!row.dag.proposalId && (
            <Text dimColor>proposal:    {row.dag.proposalId}</Text>
          )}
          {row.dag.blockers.length > 0 && (
            <Text dimColor>
              blockers:    {row.dag.blockers.map((b) => `${b.id}(${b.status})`).join(', ')}
            </Text>
          )}
          {row.dag.blocking.length > 0 && (
            <Text dimColor>
              blocking:    {row.dag.blocking.map((b) => `${b.id}(${b.status})`).join(', ')}
            </Text>
          )}
          {row.dag.descendants.length > 0 && (
            <Text dimColor>
              descendants: {row.dag.descendants.map((b) => `${b.id}(${b.status})`).join(', ')}
            </Text>
          )}
        </Box>
      )}
      {row.staleWorktreeDetail && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>status: {row.staleWorktreeDetail.status}</Text>
          <Text dimColor>age:    {row.staleWorktreeDetail.ageHours.toFixed(1)}h</Text>
          {!!row.staleWorktreeDetail.branch && (
            <Text dimColor>branch: {row.staleWorktreeDetail.branch}</Text>
          )}
          {row.staleWorktreeDetail.empty && (
            <Text dimColor>(worktree is empty — safe to purge)</Text>
          )}
          <Box marginTop={1}>
            <Text>mars purge {row.entityId}</Text>
          </Box>
        </Box>
      )}
      {row.diagnosis && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>
            diagnosis:
          </Text>
          <Text>{row.diagnosis.text}</Text>
          <Text dimColor>diagnosed: {row.diagnosis.diagnosedAt}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>b back · q quit</Text>
      </Box>
    </Box>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

interface AppState {
  rows: ActionQueueRow[]
  cursor: number
  detailId: string | null
  error: string | null
  live: boolean
  now: number
}

const ActionQueueWatchApp: React.FC<{ baseUrl: string | null }> = ({ baseUrl }) => {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    rows: [],
    cursor: 0,
    detailId: null,
    error: baseUrl === null
      ? 'daemon not running — start with `mars daemon start`'
      : null,
    live: false,
    now: Date.now(),
  })

  const refresh = useCallback(async (): Promise<void> => {
    if (!baseUrl) return
    try {
      const res = await fetch(`${baseUrl}/view/action-queue?filter=open`)
      if (!res.ok) throw new Error(`GET /view/action-queue: HTTP ${res.status}`)
      const rows = (await res.json()) as ActionQueueRow[]
      setState((prev) => {
        const cursor =
          rows.length === 0 ? 0 : Math.min(prev.cursor, rows.length - 1)
        return {
          ...prev,
          rows,
          cursor,
          error: null,
          live: true,
          now: Date.now(),
        }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setState((prev) => ({
        ...prev,
        error: message,
        live: false,
        now: Date.now(),
      }))
    }
  }, [baseUrl])

  // Initial fetch on mount.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // SSE stream: re-fetch the full projection whenever the daemon emits an
  // 'action-queue' or 'tasks' event. Reconnects automatically after drops.
  useEffect(() => {
    if (!baseUrl) return

    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let abortCtrl: AbortController | null = null

    const connect = async (): Promise<void> => {
      if (cancelled) return
      abortCtrl = new AbortController()
      try {
        const res = await fetch(`${baseUrl}/view/stream`, {
          signal: abortCtrl.signal,
        })
        if (!res.ok || !res.body) {
          if (!cancelled)
            reconnectTimer = setTimeout(() => void connect(), 2000)
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // SSE frames are delimited by double newlines.
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            if (cancelled) break
            const eventLine = frame
              .trim()
              .split('\n')
              .find((l) => l.startsWith('event:'))
            if (eventLine) {
              const name = eventLine.slice('event:'.length).trim()
              if (name === 'action-queue' || name === 'tasks') {
                void refresh()
              }
            }
          }
        }
      } catch {
        // Absorb abort errors; fall through to reconnect.
      }
      if (!cancelled)
        reconnectTimer = setTimeout(() => void connect(), 2000)
    }

    void connect()

    return () => {
      cancelled = true
      abortCtrl?.abort()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    }
  }, [baseUrl, refresh])

  const selected = state.rows[state.cursor] ?? null

  useInput((input, key) => {
    if (state.detailId !== null) {
      if (input === 'b' || key.escape) {
        setState((prev) => ({ ...prev, detailId: null }))
        return
      }
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit()
      }
      return
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
      return
    }
    if (input === 'j' || key.downArrow) {
      setState((prev) => ({
        ...prev,
        cursor:
          prev.rows.length === 0
            ? 0
            : Math.min(prev.cursor + 1, prev.rows.length - 1),
      }))
      return
    }
    if (input === 'k' || key.upArrow) {
      setState((prev) => ({
        ...prev,
        cursor: Math.max(prev.cursor - 1, 0),
      }))
      return
    }
    if (key.return) {
      if (selected) {
        setState((prev) => ({ ...prev, detailId: selected.id }))
      }
      return
    }
  })

  if (state.detailId !== null) {
    const detailRow = state.rows.find((r) => r.id === state.detailId)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">
            mars action-queue · detail
          </Text>
        </Box>
        {detailRow ? (
          <Detail row={detailRow} now={state.now} />
        ) : (
          <Box>
            <Text dimColor>(item no longer available)</Text>
          </Box>
        )}
        {state.error && (
          <Box marginTop={1}>
            <Text color="red">error: {state.error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>b back · q quit</Text>
        </Box>
      </Box>
    )
  }

  const failedCount = state.rows.filter((r) => r.kind === 'failed-task').length
  const staleCount = state.rows.filter((r) => r.kind === 'stale-worktree').length
  const draftCount = state.rows.filter((r) => r.kind === 'draft-proposal').length

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          mars action-queue
        </Text>
        <Text> · </Text>
        <Text color="red">{failedCount} failed</Text>
        <Text> · </Text>
        <Text color="yellow">{staleCount} stale</Text>
        <Text> · </Text>
        <Text color="magenta">{draftCount} drafts</Text>
        {state.live ? (
          <Text dimColor> · live</Text>
        ) : (
          <Text dimColor> · connecting…</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.rows.length === 0 && !state.error ? (
          <Box justifyContent="center" paddingY={2}>
            <Text dimColor>action queue empty</Text>
          </Box>
        ) : (
          state.rows.map((row, i) => (
            <Row
              key={row.id}
              row={row}
              selected={i === state.cursor}
              now={state.now}
            />
          ))
        )}
      </Box>
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">error: {state.error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>j/k move · enter detail · q quit</Text>
      </Box>
    </Box>
  )
}

export const runActionQueueWatch = (): void => {
  const stateDir = getStateDir()
  const baseUrl = resolveDaemonBaseUrl(stateDir)
  render(<ActionQueueWatchApp baseUrl={baseUrl} />)
}
