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
 * priority then recency. Actions are fired via POST to the daemon.
 *
 * THREE ACTION TIERS:
 *   - Direct ops (restart, purge, prune-worktree, dismiss, unblock):
 *     POST /actions/:op/:id. needsConfirm actions require y/n confirmation.
 *   - Agent ops (diagnose-failure, investigate):
 *     POST /actions/:op/:id; show ⟳ working indicator on the row;
 *     result renders via the next SSE-triggered row update.
 *   - Copy ops (op === 'copy'): display the hint prominently; do NOT POST.
 *
 * Global/batch ops use dedicated routes (no :id):
 *   restart-daemon             → POST /actions/restart-daemon
 *   restart-all-daemon-killed  → POST /actions/restart-all-daemon-killed
 *
 * Keybindings (always):
 *   - j/k or arrows : move cursor
 *   - enter         : open detail view
 *   - b or escape   : back from detail / dismiss confirm
 *   - q or ctrl-c   : quit
 *
 * Keybindings (dynamic, from selected row's actions[]):
 *   First available letter from each hyphen-split action id word, de-duplicated.
 *   Shown in the footer as e.g. [d]iagnose [r]estart [p]urge.
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

// ─── action helpers ───────────────────────────────────────────────────────────

/**
 * Global/batch action ops that use dedicated routes with no :id segment.
 * All other ops use the per-entity route: POST /actions/:op/:id.
 */
const GLOBAL_ACTION_OPS = new Set(['restart-daemon', 'restart-all-daemon-killed'])

/**
 * Compute the POST URL for a given action op and entity.
 * Returns null for 'copy' ops (client-side only; must never POST to the daemon).
 * Global/batch ops use dedicated routes: /actions/restart-daemon etc.
 * All other ops use: /actions/:op/:id.
 *
 * Exported so the URL-routing path is independently testable.
 */
export const resolveActionUrl = (
  baseUrl: string,
  entityId: string,
  op: string,
): string | null => {
  if (op === 'copy') return null
  if (GLOBAL_ACTION_OPS.has(op)) return `${baseUrl}/actions/${op}`
  return `${baseUrl}/actions/${op}/${entityId}`
}

/** Outcome of resolving an action invocation — what the TUI should do. */
export type ActionOutcome =
  | { kind: 'copy'; hint: string }
  | { kind: 'confirm-needed' }
  | { kind: 'fire'; url: string }

/**
 * Resolve what the TUI should do when an action key is pressed.
 *
 * - 'copy'          : display hint, do NOT POST.
 * - 'confirm-needed': action has needsConfirm and caller has not confirmed.
 * - 'fire'          : POST to the resolved URL.
 *
 * Pass confirmed=true after the operator has acknowledged a confirm dialog.
 * The actual HTTP fetch is the caller's responsibility.
 *
 * Exported for testing — covers direct ops, batch ops, needsConfirm gate,
 * and copy-op no-POST invariant.
 */
export const resolveActionOutcome = (
  baseUrl: string,
  entityId: string,
  action: Pick<ActionQueueRow['actions'][number], 'op' | 'needsConfirm' | 'hint'>,
  confirmed = false,
): ActionOutcome => {
  if (action.op === 'copy') {
    return { kind: 'copy', hint: action.hint ?? '' }
  }
  if (action.needsConfirm && !confirmed) {
    return { kind: 'confirm-needed' }
  }
  // resolveActionUrl only returns null for 'copy', already handled above.
  const url = resolveActionUrl(baseUrl, entityId, action.op) as string
  return { kind: 'fire', url }
}

/**
 * Derive a stable key → action binding from a row's actions[].
 *
 * Keys are assigned by scanning the hyphen-separated words of each action.id
 * in order, taking the first available initial letter. If all word-initial
 * letters are taken, the algorithm falls back to scanning every character in
 * the action.id. Actions whose id shares all letters with prior actions are
 * left without a key (rare; typical menus are short and distinct).
 *
 * Exported for testing.
 */
export const deriveActionKeys = (
  actions: ActionQueueRow['actions'],
): Record<string, ActionQueueRow['actions'][number]> => {
  const result: Record<string, ActionQueueRow['actions'][number]> = {}
  for (const action of actions) {
    const words = action.id.split('-')
    let assigned = false
    for (const word of words) {
      const letter = word[0]?.toLowerCase()
      if (letter && !result[letter]) {
        result[letter] = action
        assigned = true
        break
      }
    }
    if (!assigned) {
      for (const ch of action.id) {
        if (/[a-z]/.test(ch) && !result[ch]) {
          result[ch] = action
          break
        }
      }
    }
  }
  return result
}

/**
 * Clear pendingOps entries for rows whose agent result has arrived in the
 * latest projection from the SSE-triggered refresh.
 *
 * For diagnose-failure ops: cleared when row.diagnosis is present.
 * For investigate ops: cleared when row.staleWorktreeDetail.investigation is present.
 * Rows no longer in the projection are also cleared.
 *
 * Exported for testing — verifies the "working indicator clears when the
 * agent result arrives" behaviour without requiring Ink rendering.
 */
export const clearResolvedPendingOps = (
  pendingOps: Record<string, string>,
  updatedRows: ActionQueueRow[],
): Record<string, string> => {
  const result = { ...pendingOps }
  for (const rowId of Object.keys(result)) {
    const op = result[rowId]
    const row = updatedRows.find((r) => r.id === rowId)
    if (!row) {
      delete result[rowId]
    } else if (op === 'diagnose-failure' && row.diagnosis) {
      delete result[rowId]
    } else if (op === 'investigate' && row.staleWorktreeDetail?.investigation) {
      delete result[rowId]
    }
  }
  return result
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

// ─── ActionMenu ───────────────────────────────────────────────────────────────

/** Renders the dynamic action key menu for the selected or detail row. */
const ActionMenu: React.FC<{ actions: ActionQueueRow['actions'] }> = ({ actions }) => {
  if (actions.length === 0) return null
  const keys = deriveActionKeys(actions)
  const parts = Object.entries(keys).map(([k, a]) => `[${k}]${a.label}`)
  return (
    <Box>
      <Text dimColor>{parts.join(' · ')}</Text>
    </Box>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface RowProps {
  row: ActionQueueRow
  selected: boolean
  now: number
  pending: boolean
}

const Row: React.FC<RowProps> = ({ row, selected, now, pending }) => {
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
      {pending && <Text dimColor> ⟳</Text>}
      <Text>  </Text>
      <Text dimColor>{rel}</Text>
    </Box>
  )
}

// ─── Detail ───────────────────────────────────────────────────────────────────

interface DetailProps {
  row: ActionQueueRow
  now: number
  pending: boolean
}

const Detail: React.FC<DetailProps> = ({ row, now, pending }) => {
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
          {!!row.staleWorktreeDetail.investigation && (
            <Box marginTop={1} flexDirection="column">
              <Text bold dimColor>investigation:</Text>
              <Text>{row.staleWorktreeDetail.investigation}</Text>
            </Box>
          )}
        </Box>
      )}
      {pending && (
        <Box marginTop={1}>
          <Text dimColor>⟳ working…</Text>
        </Box>
      )}
      {!pending && row.diagnosis && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>diagnosis:</Text>
          <Text>{row.diagnosis.text}</Text>
          <Text dimColor>diagnosed: {row.diagnosis.diagnosedAt}</Text>
        </Box>
      )}
      {row.actions.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>actions:</Text>
          <ActionMenu actions={row.actions} />
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
  /** The id of the currently selected row, used to re-anchor the cursor on refresh. */
  cursorRowId: string | null
  /** The last resolved cursor index, used as a fallback when the anchored row disappears. */
  lastCursorIndex: number
  detailId: string | null
  error: string | null
  live: boolean
  now: number
  /** rowId → op — rows with an in-flight agent op (diagnose-failure / investigate). */
  pendingOps: Record<string, string>
  /** Set when a needsConfirm action is pressed; cleared on y/n/esc. */
  confirm: { row: ActionQueueRow; action: ActionQueueRow['actions'][number] } | null
  /** Last action HTTP error, if any. Displayed in the footer. */
  actionError: string | null
  /** Set when a 'copy' action is pressed. The hint is surfaced prominently. */
  copiedHint: string | null
  /** True when an SSE refresh was deferred because a gate (confirm/pendingOps/copiedHint) was active. */
  refreshDeferred: boolean
}

/**
 * Returns true when it is safe to re-fetch the action-queue projection.
 * Returns false while a confirm dialog, a copy-hint overlay, or any pending
 * agent op is active — we don't want the rows to reshuffle under the operator.
 */
export function shouldRefreshNow(
  state: Pick<AppState, 'confirm' | 'pendingOps' | 'copiedHint'>,
): boolean {
  return !(
    state.confirm !== null ||
    Object.keys(state.pendingOps).length > 0 ||
    state.copiedHint !== null
  )
}

/**
 * Resolve the cursor index after a refresh that may have inserted or deleted rows.
 *
 * - Anchor hit: if prevRowId is still in rows, return its new index.
 * - Anchor miss + rows non-empty: clamp prevIndex to the last valid index.
 * - Empty rows: return 0.
 *
 * Exported for testing.
 */
export const resolveCursor = (
  rows: ActionQueueRow[],
  prevRowId: string | null,
  prevIndex: number,
): number => {
  if (rows.length === 0) return 0
  if (prevRowId !== null) {
    const idx = rows.findIndex((r) => r.id === prevRowId)
    if (idx !== -1) return idx
  }
  return Math.min(prevIndex, rows.length - 1)
}

const ActionQueueWatchApp: React.FC<{ stateDir: string }> = ({ stateDir }) => {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    rows: [],
    cursorRowId: null,
    lastCursorIndex: 0,
    detailId: null,
    error: null,
    live: false,
    now: Date.now(),
    pendingOps: {},
    confirm: null,
    actionError: null,
    copiedHint: null,
    refreshDeferred: false,
  })

  const refresh = useCallback(async (): Promise<void> => {
    const baseUrl = resolveDaemonBaseUrl(stateDir)
    if (!baseUrl) {
      setState((prev) => ({ ...prev, error: 'daemon not running — start with `mars daemon start`', live: false }))
      return
    }
    try {
      const res = await fetch(`${baseUrl}/view/action-queue?filter=open`)
      if (!res.ok) throw new Error(`GET /view/action-queue: HTTP ${res.status}`)
      const rows = (await res.json()) as ActionQueueRow[]
      setState((prev) => {
        const newIndex = resolveCursor(rows, prev.cursorRowId, prev.lastCursorIndex)
        const pendingOps = clearResolvedPendingOps(prev.pendingOps, rows)
        return {
          ...prev,
          rows,
          cursorRowId: rows[newIndex]?.id ?? null,
          lastCursorIndex: newIndex,
          error: null,
          live: true,
          now: Date.now(),
          pendingOps,
          refreshDeferred: false,
        }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setState((prev) => ({
        ...prev,
        error: message,
        live: false,
        now: Date.now(),
        refreshDeferred: false,
      }))
    }
  }, [stateDir])

  // Initial fetch on mount.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // SSE stream: re-fetch the full projection whenever the daemon emits an
  // 'action-queue' or 'tasks' event. Reconnects automatically after drops.
  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let abortCtrl: AbortController | null = null

    const connect = async (): Promise<void> => {
      if (cancelled) return
      const baseUrl = resolveDaemonBaseUrl(stateDir)
      if (!baseUrl) {
        if (!cancelled) reconnectTimer = setTimeout(() => void connect(), 2000)
        return
      }
      abortCtrl = new AbortController()
      try {
        const res = await fetch(`${baseUrl}/view/stream`, {
          signal: abortCtrl.signal,
        })
        if (!res.ok || !res.body) {
          if (!cancelled) reconnectTimer = setTimeout(() => void connect(), 2000)
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
                setState((prev) => {
                  if (shouldRefreshNow(prev)) {
                    void refresh()
                    return prev
                  }
                  return { ...prev, refreshDeferred: true }
                })
              }
            }
          }
        }
      } catch {
        // Absorb abort errors; fall through to reconnect.
      }
      if (!cancelled) reconnectTimer = setTimeout(() => void connect(), 2000)
    }

    void connect()

    return () => {
      cancelled = true
      abortCtrl?.abort()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    }
  }, [stateDir, refresh])

  // When all refresh gates clear and a deferred refresh is pending, fire exactly one refresh.
  useEffect(() => {
    if (shouldRefreshNow(state) && state.refreshDeferred) {
      setState((prev) => ({ ...prev, refreshDeferred: false }))
      void refresh()
    }
  }, [state.confirm, state.pendingOps, state.copiedHint, state.refreshDeferred, refresh])

  /** Fire an action that has already passed the confirm gate. */
  const fireAction = useCallback(
    async (
      row: ActionQueueRow,
      action: ActionQueueRow['actions'][number],
    ): Promise<void> => {
      if (action.op === 'copy') {
        setState((prev) => ({ ...prev, copiedHint: action.hint ?? '', actionError: null }))
        return
      }
      const baseUrl = resolveDaemonBaseUrl(stateDir)
      if (!baseUrl) return
      const outcome = resolveActionOutcome(baseUrl, row.entityId, action, true)
      if (outcome.kind !== 'fire') return
      const { url } = outcome

      const isAgentOp = action.op === 'diagnose-failure' || action.op === 'investigate'
      setState((prev) => ({
        ...prev,
        actionError: null,
        pendingOps: isAgentOp
          ? { ...prev.pendingOps, [row.id]: action.op }
          : prev.pendingOps,
      }))

      try {
        const res = await fetch(url, { method: 'POST' })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(
            `POST ${url}: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
          )
        }
        // For non-agent ops (direct ops), the SSE stream will push an updated
        // view automatically. For agent ops, the result arrives on the next
        // SSE update that carries the populated diagnosis/investigation field.
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setState((prev) => ({
          ...prev,
          actionError: message,
          refreshDeferred: false,
          pendingOps: isAgentOp
            ? (() => {
                const next = { ...prev.pendingOps }
                delete next[row.id]
                return next
              })()
            : prev.pendingOps,
        }))
      }
    },
    [stateDir],
  )

  const selected = state.rows[state.lastCursorIndex] ?? null

  useInput((input, key) => {
    // A copy hint overlay is up — any key dismisses it.
    if (state.copiedHint !== null) {
      setState((prev) => ({ ...prev, copiedHint: null }))
      return
    }

    // Confirm dialog intercepts all keys.
    if (state.confirm !== null) {
      if (input === 'y') {
        const { row, action } = state.confirm
        setState((prev) => ({ ...prev, confirm: null }))
        void fireAction(row, action)
      } else {
        // Any key other than 'y' cancels the confirm.
        setState((prev) => ({ ...prev, confirm: null }))
      }
      return
    }

    // Detail view.
    if (state.detailId !== null) {
      if (input === 'b' || key.escape) {
        setState((prev) => ({ ...prev, detailId: null }))
        return
      }
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit()
        return
      }
      // Action keys in detail view — derived from the detail row's actions[].
      const detailRow = state.rows.find((r) => r.id === state.detailId)
      if (detailRow) {
        const actionKeys = deriveActionKeys(detailRow.actions)
        const action = actionKeys[input]
        if (action) {
          if (action.needsConfirm) {
            setState((prev) => ({ ...prev, confirm: { row: detailRow, action } }))
          } else {
            void fireAction(detailRow, action)
          }
          return
        }
      }
      return
    }

    // List view.
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
      return
    }
    if (input === 'j' || key.downArrow) {
      setState((prev) => {
        const newIndex =
          prev.rows.length === 0
            ? 0
            : Math.min(prev.lastCursorIndex + 1, prev.rows.length - 1)
        return {
          ...prev,
          cursorRowId: prev.rows[newIndex]?.id ?? null,
          lastCursorIndex: newIndex,
        }
      })
      return
    }
    if (input === 'k' || key.upArrow) {
      setState((prev) => {
        const newIndex = Math.max(prev.lastCursorIndex - 1, 0)
        return {
          ...prev,
          cursorRowId: prev.rows[newIndex]?.id ?? null,
          lastCursorIndex: newIndex,
        }
      })
      return
    }
    if (key.return) {
      if (selected) {
        setState((prev) => ({ ...prev, detailId: selected.id }))
      }
      return
    }
    // Action keys in list view — derived from the selected row's actions[].
    if (selected) {
      const actionKeys = deriveActionKeys(selected.actions)
      const action = actionKeys[input]
      if (action) {
        if (action.needsConfirm) {
          setState((prev) => ({ ...prev, confirm: { row: selected, action } }))
        } else {
          void fireAction(selected, action)
        }
        return
      }
    }
  })

  // ── copy-hint overlay ─────────────────────────────────────────────────────
  if (state.copiedHint !== null) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">
            mars action-queue · command
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Run this command to proceed:</Text>
          <Box marginTop={1}>
            <Text bold color="cyan">
              {state.copiedHint}
            </Text>
          </Box>
        </Box>
        <Box marginTop={2}>
          <Text dimColor>press any key to dismiss</Text>
        </Box>
      </Box>
    )
  }

  // ── confirm dialog ────────────────────────────────────────────────────────
  if (state.confirm !== null) {
    const { row, action } = state.confirm
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="yellow">
            Confirm: {action.label}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>entity: {row.entityId}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>Press </Text>
          <Text bold color="green">
            y
          </Text>
          <Text> to confirm · </Text>
          <Text bold color="red">
            any other key
          </Text>
          <Text> to cancel</Text>
        </Box>
      </Box>
    )
  }

  // ── detail view ───────────────────────────────────────────────────────────
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
          <Detail
            row={detailRow}
            now={state.now}
            pending={!!state.pendingOps[detailRow.id]}
          />
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
        {state.actionError && (
          <Box marginTop={1}>
            <Text color="red">action error: {state.actionError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>b back · q quit</Text>
        </Box>
      </Box>
    )
  }

  // ── list view ─────────────────────────────────────────────────────────────
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
              selected={i === state.lastCursorIndex}
              now={state.now}
              pending={!!state.pendingOps[row.id]}
            />
          ))
        )}
      </Box>
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">error: {state.error}</Text>
        </Box>
      )}
      {state.actionError && (
        <Box marginTop={1}>
          <Text color="red">action error: {state.actionError}</Text>
        </Box>
      )}
      {selected && selected.actions.length > 0 && (
        <Box marginTop={1}>
          <ActionMenu actions={selected.actions} />
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>j/k move · enter detail · q quit</Text>
      </Box>
    </Box>
  )
}

export const runActionQueueWatch = (): void => {
  render(<ActionQueueWatchApp stateDir={getStateDir()} />)
}
