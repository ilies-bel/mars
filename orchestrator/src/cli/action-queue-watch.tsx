/**
 * Live Todo TUI — what `mars actionQueue watch` renders.
 *
 * Mirrors the web UI's Todo page: a single feed of drafts (proposals
 * waiting to be shaped) and stale worktrees (operational alerts), grouped
 * into Today / Yesterday / This Week / Older. Bucketing rules live in
 * `orchestrator/src/core/lib/todo-feed.ts` so the CLI, web UI server,
 * and React Todo page all agree.
 *
 * Data source: the local web UI server's `/api/todo` endpoint at
 * `MARS_UI_URL` (default `http://127.0.0.1:7777`). Reusing the existing
 * HTTP endpoint avoids duplicating the DB-query path in the orchestrator
 * package today. A future task can lift `listTodo()` into `todo-feed.ts`
 * and have the web server delegate to it; both surfaces will keep working
 * because the wire shape is unchanged.
 *
 * Keybindings (intentionally trimmed from the old action_queue_items TUI):
 *   - j/k or arrows : move cursor
 *   - enter         : open detail view
 *   - b or escape   : back from detail
 *   - q or ctrl-c   : quit
 *
 * a/r/d (ack/resolve/dismiss) are gone because drafts and stale worktrees
 * have no in-TUI mutating actions in this slice — by design. `mars actionQueue`
 * (the non-watch verb) keeps managing the orchestrator `action_queue_items` table
 * exactly as before.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import {
  BUCKET_ORDER,
  BUCKET_LABEL,
  buildTodoFeed,
  groupTodoIntoBuckets,
  itemKey,
  itemTimestamp,
  type DraftLike,
  type StaleLike,
  type TodoItem,
} from '../core/lib/todo-feed'

const POLL_INTERVAL_MS = 1000

const DEFAULT_UI_URL = 'http://127.0.0.1:7777'

const todoUrl = (): string => {
  const base = process.env.MARS_UI_URL?.trim() || DEFAULT_UI_URL
  return `${base.replace(/\/+$/, '')}/api/todo`
}

interface TodoPayload {
  drafts: DraftLike[]
  staleWorktrees: StaleLike[]
}

const fetchTodoPayload = async (): Promise<TodoPayload> => {
  const res = await fetch(todoUrl())
  if (!res.ok) {
    throw new Error(`GET /api/todo: HTTP ${res.status}`)
  }
  const body = (await res.json()) as TodoPayload
  return {
    drafts: Array.isArray(body.drafts) ? body.drafts : [],
    staleWorktrees: Array.isArray(body.staleWorktrees)
      ? body.staleWorktrees
      : [],
  }
}

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

const shortId = (id: string): string =>
  id.length <= 8 ? id : id.slice(0, 8)

interface RowProps {
  item: TodoItem
  selected: boolean
  now: number
}

const Row: React.FC<RowProps> = ({ item, selected, now }) => {
  const ts = itemTimestamp(item, now)
  const rel = formatRelativeMs(ts, now)

  if (item.kind === 'draft') {
    const d = item.draft
    const goal = d.goal.trim() || '(no goal)'
    return (
      <Box>
        <Text color={selected ? 'cyan' : undefined}>
          {selected ? '> ' : '  '}
        </Text>
        <Text color="magenta">draft</Text>
        <Text> </Text>
        <Text dimColor>{shortId(d.id)}</Text>
        <Text>  </Text>
        <Text>{goal}</Text>
        <Text>  </Text>
        <Text dimColor>{rel}</Text>
      </Box>
    )
  }

  const w = item.worktree
  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>
        {selected ? '> ' : '  '}
      </Text>
      <Text color="yellow">stale</Text>
      <Text> </Text>
      <Text dimColor>{shortId(w.taskId)}</Text>
      <Text>  </Text>
      <Text>{w.prompt.trim() || '(no prompt)'}</Text>
      <Text>  </Text>
      <Text dimColor>{rel}</Text>
    </Box>
  )
}

interface DetailProps {
  item: TodoItem
  now: number
}

const Detail: React.FC<DetailProps> = ({ item, now }) => {
  if (item.kind === 'draft') {
    const d = item.draft
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box>
          <Text bold>draft · {d.id}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{d.goal.trim() || '(no goal)'}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>source: {d.source}</Text>
          <Text dimColor>acceptance: {d.acceptanceCount}</Text>
          <Text dimColor>
            updated: {formatRelativeMs(d.updatedAt, now)}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>refine: /mars:chat {d.id}</Text>
        </Box>
      </Box>
    )
  }

  const w = item.worktree
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold>stale worktree · {w.taskId}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{w.prompt.trim() || '(no prompt)'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>status: {w.status}</Text>
        <Text dimColor>age: {w.ageHours.toFixed(1)}h</Text>
        <Text dimColor>updated_at: {w.updatedAt}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>cleanup:</Text>
        <Text>mars purge {w.taskId}</Text>
      </Box>
    </Box>
  )
}

interface AppState {
  items: TodoItem[]
  draftCount: number
  staleCount: number
  cursor: number
  detailKey: string | null
  error: string | null
  now: number
}

const TodoWatchApp: React.FC = () => {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    items: [],
    draftCount: 0,
    staleCount: 0,
    cursor: 0,
    detailKey: null,
    error: null,
    now: Date.now(),
  })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const payload = await fetchTodoPayload()
      const items = buildTodoFeed(payload)
      setState((prev) => {
        const cursor =
          items.length === 0 ? 0 : Math.min(prev.cursor, items.length - 1)
        return {
          ...prev,
          items,
          draftCount: payload.drafts.length,
          staleCount: payload.staleWorktrees.length,
          cursor,
          error: null,
          now: Date.now(),
        }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setState((prev) => ({ ...prev, error: message, now: Date.now() }))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Flat list, sorted into bucket order. `state.cursor` indexes into this
  // flat view so j/k can move smoothly across bucket boundaries while the
  // visual grouping (with headers) is computed below.
  const groups = groupTodoIntoBuckets(state.items, state.now)
  const flat: TodoItem[] = []
  for (const g of groups) flat.push(...g.items)
  const selected = flat[state.cursor] ?? null

  useInput((input, key) => {
    if (state.detailKey !== null) {
      if (input === 'b' || key.escape) {
        setState((prev) => ({ ...prev, detailKey: null }))
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
          flat.length === 0 ? 0 : Math.min(prev.cursor + 1, flat.length - 1),
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
        setState((prev) => ({ ...prev, detailKey: itemKey(selected) }))
      }
      return
    }
  })

  if (state.detailKey !== null) {
    const detailItem = flat.find((i) => itemKey(i) === state.detailKey)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">
            mars todo · detail
          </Text>
        </Box>
        {detailItem ? (
          <Detail item={detailItem} now={state.now} />
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

  let runningIndex = 0
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          mars todo
        </Text>
        <Text> · </Text>
        <Text color="magenta">{state.draftCount} drafts</Text>
        <Text> · </Text>
        <Text color="yellow">{state.staleCount} stale</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {flat.length === 0 ? (
          <Box justifyContent="center" paddingY={2}>
            <Text dimColor>
              todo empty — no drafts or stale worktrees
            </Text>
          </Box>
        ) : (
          // We iterate the grouped buckets so headers render in canonical
          // order; the flat-cursor mapping above keeps j/k navigation in
          // sync with the visual order.
          BUCKET_ORDER.map((key) => {
            const group = groups.find((g) => g.key === key)
            if (!group) return null
            const header = (
              <Box key={`h-${key}`} marginTop={1}>
                <Text dimColor>── {BUCKET_LABEL[key]} ──</Text>
              </Box>
            )
            const rows = group.items.map((item) => {
              const idx = runningIndex++
              return (
                <Row
                  key={itemKey(item)}
                  item={item}
                  selected={idx === state.cursor}
                  now={state.now}
                />
              )
            })
            return (
              <Box key={`g-${key}`} flexDirection="column">
                {header}
                {rows}
              </Box>
            )
          })
        )}
      </Box>
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">error: {state.error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          j/k move · enter detail · q quit
        </Text>
      </Box>
    </Box>
  )
}

export const runActionQueueWatch = (): void => {
  render(<TodoWatchApp />)
}
