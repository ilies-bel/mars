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
 *   continue-all-daemon-killed → POST /actions/continue-all-daemon-killed
 *
 * Keybindings (always):
 *   - arrows        : move cursor (↑/↓)
 *   - PgUp / PgDn   : jump 10 rows
 *   - enter         : open detail view
 *   - escape        : back from detail / dismiss confirm
 *   - q or ctrl-c   : quit
 *   - click         : select row (single), open detail (click selected / double-click)
 *   - wheel         : scroll list
 *
 * Keybindings (dynamic, from selected row's actions[]):
 *   First available letter from each hyphen-split action id word, de-duplicated.
 *   Shown in the footer as e.g. [d]iagnose [r]estart [p]urge.
 *
 * Mouse support:
 *   SGR extended mouse tracking (\x1b[?1002h\x1b[?1006h) is enabled on mount
 *   when stdout is a TTY. Mouse sequences arrive via Ink's useInput as ESC-stripped
 *   CSI strings (e.g. '[<0;5;3M'). Tracking is disabled on all exit paths —
 *   Ink unmount, process.exit() — so the shell is never left swallowing mouse input.
 *   Non-TTY environments degrade gracefully: no mouse, no crashes, no garbage bytes.
 *
 *   Alternate-screen buffer (\x1b[?1049h) is used so the TUI always renders from
 *   terminal row 1 — required for pixel-accurate row click mapping.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Box, Text, render, useApp, useInput, type DOMElement } from 'ink'
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
const GLOBAL_ACTION_OPS = new Set([
  'restart-daemon',
  'continue-all-daemon-killed',
  'run-reflect',
  'enable-auto-reflect',
])

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

// ─── SGR mouse parsing ────────────────────────────────────────────────────────

/**
 * A parsed SGR extended mouse event. Coordinates are 1-indexed terminal
 * positions (column x, row y). Only events relevant to the TUI are surfaced
 * — right-click, middle-click, and motion events are filtered out (null).
 */
export type SGRMouseEvent = {
  kind: 'left-press' | 'left-release' | 'wheel-up' | 'wheel-down'
  x: number
  y: number
}

/**
 * Parse an SGR extended mouse sequence from raw input as received by Ink's
 * useInput handler.
 *
 * Ink strips the leading ESC from unrecognised CSI sequences before passing
 * them to the useInput callback. The expected input format is therefore:
 *   '[<Pb;Px;PyM'  (button press)
 *   '[<Pb;Px;Pym'  (button release)
 *
 * Button codes used:
 *   0  = left button click
 *   64 = scroll wheel up
 *   65 = scroll wheel down
 *
 * Returns null for sequences that are not left-click or wheel events
 * (right-click, middle-click, drag, motion-only, or non-SGR input) so the
 * caller can safely ignore them with no branching.
 *
 * Exported for unit testing — the parser is pure and has no side effects.
 */
export function parseSGRMouse(input: string): SGRMouseEvent | null {
  const m = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input)
  if (!m) return null
  const pb = parseInt(m[1]!, 10)
  const x = parseInt(m[2]!, 10)
  const y = parseInt(m[3]!, 10)
  const isPress = m[4] === 'M'
  if (pb === 64) return { kind: 'wheel-up', x, y }
  if (pb === 65) return { kind: 'wheel-down', x, y }
  if (pb === 0 && isPress) return { kind: 'left-press', x, y }
  if (pb === 0 && !isPress) return { kind: 'left-release', x, y }
  // Ignore: right/middle click (pb 1,2), drag (pb 32+), motion (pb 35), etc.
  return null
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

/** Renders the dynamic action key menu for the selected row (list view). */
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
  /** Ref attached to the container of individual action lines for mouse hit-testing. */
  actionsBoxRef: React.Ref<DOMElement>
}

const Detail: React.FC<DetailProps> = ({ row, now, pending, actionsBoxRef }) => {
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
      {row.poolSnapshot && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>pool snapshot (at failure):</Text>
          <Text dimColor>
            workers active: {row.poolSnapshot.activeWorkerCount}  queued: {row.poolSnapshot.queuedCount}  running: {row.poolSnapshot.runningCount}  blocked: {row.poolSnapshot.blockedCount}
          </Text>
        </Box>
      )}
      {row.stallDiagnostics != null && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>stall diagnostics:</Text>
          <Text dimColor>{JSON.stringify(row.stallDiagnostics, null, 2)}</Text>
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
          <Text dimColor>actions (click or press key):</Text>
          {/* Each action on its own line for individual mouse click targeting. */}
          <Box ref={actionsBoxRef} flexDirection="column">
            {Object.entries(deriveActionKeys(row.actions)).map(([key, action]) => (
              <Box key={action.id}>
                <Text dimColor>[</Text>
                <Text>{key}</Text>
                <Text dimColor>] </Text>
                <Text>{action.label}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// ─── SSE frame classifier ─────────────────────────────────────────────────────

/**
 * Classify a raw SSE frame (text between two `\n\n` delimiters) and return the
 * event name, or null when the frame carries no named event.
 *
 * - SSE comments (lines beginning with `:`) and empty frames return null.
 * - Named events return the value after `event: ` (e.g. `"hello"`, `"tasks"`).
 *
 * Exported for testing: the caller decides what to do with the event name.
 */
export function classifySSEFrame(frame: string): string | null {
  const trimmed = frame.trim()
  if (!trimmed || trimmed.startsWith(':')) return null
  const eventLine = trimmed.split('\n').find((l) => l.startsWith('event:'))
  if (!eventLine) return null
  return eventLine.slice('event:'.length).trim() || null
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
  /**
   * True when the SSE stream is connected and the daemon has sent the `hello`
   * acknowledgement. Managed exclusively by the SSE connect loop — not by the
   * HTTP data refresh.
   */
  live: boolean
  /**
   * True when the SSE stream was live but heartbeats have stopped arriving,
   * indicating the connection is stale (half-open socket or daemon hang).
   */
  streamStale: boolean
  /**
   * Consecutive SSE connect failures since the last successful connection.
   * Used to show a degraded state after repeated failures instead of the
   * eternally-optimistic "connecting…".
   */
  streamFailures: number
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

/**
 * The terminal row (1-indexed) where the first data row renders in list view.
 *
 * In alternate-screen mode, Ink starts rendering at y=1.
 * The list view layout is:
 *   y=1  header bar
 *   y=2  blank (marginTop={1} on the rows container)
 *   y=3  first data row
 *
 * Exported for use in tests that verify click-to-row-index mapping.
 */
export const LIST_ROW_Y_START = 3

const ActionQueueWatchApp: React.FC<{ stateDir: string }> = ({ stateDir }) => {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    rows: [],
    cursorRowId: null,
    lastCursorIndex: 0,
    detailId: null,
    error: null,
    live: false,
    streamStale: false,
    streamFailures: 0,
    now: Date.now(),
    pendingOps: {},
    confirm: null,
    actionError: null,
    copiedHint: null,
    refreshDeferred: false,
  })

  // ── mouse support ─────────────────────────────────────────────────────────

  /**
   * Last left-press position and timestamp, used to detect double-click or
   * click on the already-selected row (both open detail view).
   */
  const lastClickRef = useRef<{ y: number; timeMs: number } | null>(null)

  /**
   * Ref attached to the actions list container in the detail view. Used to
   * compute absolute terminal Y positions for action click hit-testing.
   */
  const detailActionsBoxRef = useRef<DOMElement>(null)

  /**
   * Maps terminal Y coordinates (1-indexed) to the action at that Y.
   * Updated after every render while the detail view is visible.
   */
  const actionHitYRef = useRef<Map<number, ActionQueueRow['actions'][number]>>(new Map())

  // Enable SGR extended mouse tracking on mount; disable on all exit paths.
  // Only enabled when stdout is a TTY (graceful degradation in CI/pipes).
  useEffect(() => {
    if (!process.stdout.isTTY) return

    process.stdout.write('\x1b[?1002h\x1b[?1006h')

    const cleanup = (): void => {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?1002l\x1b[?1006l')
      }
    }
    // Cover the process.exit() path (Ink unmount may not run in that case).
    process.on('exit', cleanup)
    return (): void => {
      process.removeListener('exit', cleanup)
      cleanup()
    }
  }, [])

  // After every render, update the action click hit-regions for the detail view.
  // Running after every render (no deps) keeps positions correct on resize and
  // content change. The update is O(depth of yoga tree × number of actions).
  useEffect(() => {
    if (!state.detailId || !detailActionsBoxRef.current) {
      actionHitYRef.current = new Map()
      return
    }
    const detailRow = state.rows.find((r) => r.id === state.detailId)
    if (!detailRow || detailRow.actions.length === 0) {
      actionHitYRef.current = new Map()
      return
    }

    // Compute absolute top (0-indexed Ink-space) by walking the yoga node tree.
    // With alternate-screen mode, Ink's coordinate origin is terminal row 1,
    // so terminal_y = absoluteInkTop + 1.
    let absoluteTop = 0
    let node: DOMElement | null = detailActionsBoxRef.current
    while (node !== null) {
      const layout = (node as DOMElement).yogaNode?.getComputedLayout()
      if (!layout) break
      absoluteTop += layout.top
      const parent = node.parentNode as DOMElement | null
      if (!parent || !parent.yogaNode) break
      node = parent
    }
    const firstActionTerminalY = absoluteTop + 1

    const map = new Map<number, ActionQueueRow['actions'][number]>()
    const keyEntries = Object.entries(deriveActionKeys(detailRow.actions))
    keyEntries.forEach(([, action], i) => {
      map.set(firstActionTerminalY + i, action)
    })
    actionHitYRef.current = map
  })

  // ── data fetching ─────────────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<void> => {
    const baseUrl = resolveDaemonBaseUrl(stateDir)
    if (!baseUrl) {
      setState((prev) => ({ ...prev, error: 'daemon not running — start with `mars daemon start`' }))
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
  //
  // Live-state management:
  //   • `live` flips to true when the daemon sends `event: hello` (stream
  //     established and acknowledged), NOT when the first data event arrives.
  //     This means an empty queue still shows "live" immediately.
  //   • `streamStale` flips to true when no data (including heartbeat pings)
  //     has arrived within STALE_AFTER_MS — the socket is half-open or hung.
  //   • `streamFailures` counts consecutive failed connect attempts so we can
  //     show "stream down — retrying (n)" instead of "connecting…" forever.
  //   • On every reconnect, `resolveDaemonBaseUrl(stateDir)` is called fresh
  //     so a restarted daemon's new ephemeral port is picked up automatically.
  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let abortCtrl: AbortController | null = null
    // How long to wait without any data before declaring the stream stale.
    // The daemon sends a heartbeat every 30 s; 75 s = 2.5 × heartbeat interval.
    const STALE_AFTER_MS = 75_000

    const connect = async (): Promise<void> => {
      if (cancelled) return
      // Re-read the port file on every attempt so a daemon restart on a new
      // ephemeral port is picked up without restarting the TUI.
      const baseUrl = resolveDaemonBaseUrl(stateDir)
      if (!baseUrl) {
        if (!cancelled) reconnectTimer = setTimeout(() => void connect(), 2000)
        return
      }
      abortCtrl = new AbortController()
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

      const resetHeartbeat = (): void => {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
        heartbeatTimer = setTimeout(() => {
          if (!cancelled) {
            setState((prev) => ({ ...prev, live: false, streamStale: true }))
          }
        }, STALE_AFTER_MS)
      }

      try {
        const res = await fetch(`${baseUrl}/view/stream`, {
          signal: abortCtrl.signal,
        })
        if (!res.ok || !res.body) {
          setState((prev) => ({
            ...prev,
            live: false,
            streamFailures: prev.streamFailures + 1,
          }))
          if (!cancelled) reconnectTimer = setTimeout(() => void connect(), 2000)
          return
        }
        // Connection established: start heartbeat watchdog and reset failure counter.
        setState((prev) => ({ ...prev, streamFailures: 0 }))
        resetHeartbeat()

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          // Any data from the server (including heartbeat pings) resets the
          // stale watchdog — we know the connection is alive.
          resetHeartbeat()
          buffer += decoder.decode(value, { stream: true })
          // SSE frames are delimited by double newlines.
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            if (cancelled) break
            const name = classifySSEFrame(frame)
            if (name === 'hello') {
              // Daemon acknowledged the subscription — stream is live.
              setState((prev) => ({
                ...prev,
                live: true,
                streamStale: false,
                streamFailures: 0,
              }))
            } else if (name === 'action-queue' || name === 'tasks') {
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
      } catch {
        // Absorb abort/network errors; fall through to reconnect.
      } finally {
        if (heartbeatTimer !== null) {
          clearTimeout(heartbeatTimer)
          heartbeatTimer = null
        }
      }

      if (!cancelled) {
        setState((prev) => ({ ...prev, live: false, streamFailures: prev.streamFailures + 1 }))
        reconnectTimer = setTimeout(() => void connect(), 2000)
      }
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
    // ── SGR mouse events ────────────────────────────────────────────────────
    // Ink strips the leading ESC from unrecognised CSI sequences; SGR mouse
    // events arrive as '[<Pb;Px;PyM' / '[<Pb;Px;Pym'. Handle them first so
    // they don't accidentally trigger letter-key handlers.
    const mouseEv = parseSGRMouse(input)
    if (mouseEv !== null) {
      // Overlays suppress mouse events (same as keyboard).
      if (state.copiedHint !== null || state.confirm !== null) return

      if (mouseEv.kind === 'wheel-up') {
        setState((prev) => {
          const newIndex = Math.max(prev.lastCursorIndex - 1, 0)
          return { ...prev, lastCursorIndex: newIndex, cursorRowId: prev.rows[newIndex]?.id ?? null }
        })
        return
      }

      if (mouseEv.kind === 'wheel-down') {
        setState((prev) => {
          const newIndex =
            prev.rows.length === 0
              ? 0
              : Math.min(prev.lastCursorIndex + 1, prev.rows.length - 1)
          return { ...prev, lastCursorIndex: newIndex, cursorRowId: prev.rows[newIndex]?.id ?? null }
        })
        return
      }

      if (mouseEv.kind === 'left-press') {
        // Detail view: check if click lands on an action hint line.
        if (state.detailId !== null) {
          const action = actionHitYRef.current.get(mouseEv.y)
          if (action) {
            const detailRow = state.rows.find((r) => r.id === state.detailId)
            if (detailRow) {
              if (action.needsConfirm) {
                setState((prev) => ({ ...prev, confirm: { row: detailRow, action } }))
              } else {
                void fireAction(detailRow, action)
              }
            }
          }
          return
        }

        // List view: click selects a row; click on the selected row (or
        // double-click within 500 ms) opens detail.
        const rowIndex = mouseEv.y - LIST_ROW_Y_START
        if (rowIndex >= 0 && rowIndex < state.rows.length) {
          const clickedRow = state.rows[rowIndex]!
          const now = Date.now()
          const isDoubleOrRepeat =
            lastClickRef.current !== null &&
            lastClickRef.current.y === mouseEv.y &&
            now - lastClickRef.current.timeMs < 500
          lastClickRef.current = { y: mouseEv.y, timeMs: now }

          if (isDoubleOrRepeat || rowIndex === state.lastCursorIndex) {
            setState((prev) => ({ ...prev, detailId: clickedRow.id }))
          } else {
            setState((prev) => ({
              ...prev,
              lastCursorIndex: rowIndex,
              cursorRowId: clickedRow.id,
            }))
          }
        }
      }
      return
    }

    // ── keyboard events ─────────────────────────────────────────────────────

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
      if (key.escape) {
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
    if (key.downArrow) {
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
    if (key.upArrow) {
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
    if (key.pageDown) {
      setState((prev) => {
        const newIndex =
          prev.rows.length === 0
            ? 0
            : Math.min(prev.lastCursorIndex + 10, prev.rows.length - 1)
        return {
          ...prev,
          cursorRowId: prev.rows[newIndex]?.id ?? null,
          lastCursorIndex: newIndex,
        }
      })
      return
    }
    if (key.pageUp) {
      setState((prev) => {
        const newIndex = Math.max(prev.lastCursorIndex - 10, 0)
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
            actionsBoxRef={detailActionsBoxRef}
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
          <Text dimColor>esc back · q quit</Text>
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
        {state.live && !state.streamStale ? (
          <Text dimColor> · live</Text>
        ) : state.streamStale ? (
          <Text color="yellow"> · stale</Text>
        ) : state.streamFailures >= 3 ? (
          <Text color="yellow"> · stream down — retrying ({state.streamFailures})</Text>
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
        <Text dimColor>
          ↑/↓ move{state.rows.length > 10 ? ' · PgUp/PgDn' : ''} · enter detail · click select · q quit
        </Text>
      </Box>
    </Box>
  )
}

export const runActionQueueWatch = (): void => {
  render(<ActionQueueWatchApp stateDir={getStateDir()} />, { alternateScreen: true })
}
