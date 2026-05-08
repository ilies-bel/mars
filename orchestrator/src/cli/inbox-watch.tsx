import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import {
  listInboxItems,
  setInboxState,
  type InboxItem,
  type InboxPriority,
} from '../mastra/lib/inbox'

// Future task: replace 1s polling with a notify socket (.mars/inbox.sock)
// for instant updates. Out of scope here.
const POLL_INTERVAL_MS = 1000

const PRIORITY_RANK: Record<InboxPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

const STATE_GLYPH: Record<string, string> = {
  open: '●',
  acknowledged: '◐',
}

const PRIORITY_COLOR: Record<InboxPriority, string> = {
  urgent: 'red',
  high: 'magenta',
  normal: 'yellow',
  low: 'gray',
}

const formatRelativeTime = (iso: string): string => {
  if (!iso) return '-'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diffSec = Math.floor((Date.now() - t) / 1000)
  if (diffSec < 5) return 'now'
  if (diffSec < 60) return `${diffSec}s ago`
  const m = Math.floor(diffSec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const compareItems = (a: InboxItem, b: InboxItem): number => {
  const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (pr !== 0) return pr
  // last_seen_at desc
  const ta = Date.parse(a.lastSeenAt) || 0
  const tb = Date.parse(b.lastSeenAt) || 0
  return tb - ta
}

const extractAffectedTaskIds = (item: InboxItem): string[] => {
  const occurrences = (item.payload as { occurrences?: unknown }).occurrences
  if (!Array.isArray(occurrences)) return []
  const ids: string[] = []
  for (const occ of occurrences) {
    if (occ && typeof occ === 'object') {
      const taskId = (occ as { taskId?: unknown; task_id?: unknown }).taskId
        ?? (occ as { taskId?: unknown; task_id?: unknown }).task_id
      if (typeof taskId === 'string' && taskId.length > 0) {
        ids.push(taskId)
      }
    }
  }
  return ids
}

interface ListRowProps {
  item: InboxItem
  selected: boolean
}

const ListRow: React.FC<ListRowProps> = ({ item, selected }) => {
  const glyph = STATE_GLYPH[item.state] ?? '·'
  const sig = item.signature ? `(${item.signature})` : '()'
  const affected = extractAffectedTaskIds(item)
  const affectedDisplay =
    affected.length > 0
      ? affected.length > 4
        ? `${affected.slice(0, 4).join(', ')} +${affected.length - 4}`
        : affected.join(', ')
      : null

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={selected ? 'cyan' : undefined}>
          {selected ? '> ' : '  '}
        </Text>
        <Text color={item.state === 'open' ? 'green' : 'yellow'}>{glyph}</Text>
        <Text> </Text>
        <Text bold>{item.kind}</Text>
        <Text dimColor>{sig}</Text>
        <Text>   </Text>
        <Text color={PRIORITY_COLOR[item.priority]}>{item.priority}</Text>
        <Text>   </Text>
        <Text dimColor>×{item.seenCount}</Text>
        <Text>   </Text>
        <Text dimColor>{formatRelativeTime(item.lastSeenAt)}</Text>
      </Box>
      <Box paddingLeft={6}>
        <Text>{item.title}</Text>
      </Box>
      <Box paddingLeft={6}>
        <Text dimColor>raised_by {item.raisedBy}</Text>
      </Box>
      {affectedDisplay && (
        <Box paddingLeft={6}>
          <Text dimColor>affected {affectedDisplay}</Text>
        </Box>
      )}
    </Box>
  )
}

interface DetailViewProps {
  item: InboxItem
}

const DetailView: React.FC<DetailViewProps> = ({ item }) => {
  // Markdown rendering of body is out of scope; render as plain text.
  const payloadJson = JSON.stringify(item.payload, null, 2)
  const contextJson = JSON.stringify(item.context, null, 2)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold>{item.title}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>id: {item.id}</Text>
        <Text dimColor>
          kind: {item.kind} ({item.signature ?? '-'})
        </Text>
        <Text dimColor>
          state: {item.state}   priority: {item.priority}   seen: ×
          {item.seenCount}
        </Text>
        <Text dimColor>raised_by: {item.raisedBy}</Text>
        <Text dimColor>raised_at: {item.raisedAt}</Text>
        <Text dimColor>last_seen_at: {item.lastSeenAt}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>{item.body || '(no body)'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>payload:</Text>
        <Text>{payloadJson}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>context:</Text>
        <Text>{contextJson}</Text>
      </Box>
    </Box>
  )
}

interface AppState {
  items: InboxItem[]
  resolvedCount: number
  cursor: number
  showResolved: boolean
  detailId: string | null
  error: string | null
  status: string | null
}

const InboxWatchApp: React.FC = () => {
  const { exit } = useApp()
  const [state, setState] = useState<AppState>({
    items: [],
    resolvedCount: 0,
    cursor: 0,
    showResolved: false,
    detailId: null,
    error: null,
    status: null,
  })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // Future task: filtering UI by category/kind/priority + search are out of scope.
      const [open, ack, resolved] = await Promise.all([
        listInboxItems('open'),
        listInboxItems('acknowledged'),
        listInboxItems('resolved'),
      ])
      setState((prev) => {
        const visible: InboxItem[] = prev.showResolved
          ? [...open, ...ack, ...resolved]
          : [...open, ...ack]
        visible.sort(compareItems)
        const cursor =
          visible.length === 0
            ? 0
            : Math.min(prev.cursor, visible.length - 1)
        return {
          ...prev,
          items: visible,
          resolvedCount: resolved.length,
          cursor,
          error: null,
        }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setState((prev) => ({ ...prev, error: message }))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [refresh])

  const selected = state.items[state.cursor] ?? null

  const applyState = useCallback(
    async (
      item: InboxItem,
      target: 'acknowledged' | 'resolved' | 'dismissed',
    ): Promise<void> => {
      try {
        await setInboxState(item.id, target)
        setState((prev) => ({
          ...prev,
          status: `${target} ${item.id.slice(0, 8)}`,
        }))
        await refresh()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setState((prev) => ({ ...prev, error: message }))
      }
    },
    [refresh],
  )

  useInput((input, key) => {
    if (state.detailId !== null) {
      if (input === 'b' || key.escape) {
        setState((prev) => ({ ...prev, detailId: null }))
        return
      }
      if (input === 'r' && selected) {
        void applyState(selected, 'resolved')
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
        cursor: prev.items.length === 0 ? 0 : Math.min(prev.cursor + 1, prev.items.length - 1),
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
    if (input === 'a' && selected) {
      void applyState(selected, 'acknowledged')
      return
    }
    if (input === 'r' && selected) {
      void applyState(selected, 'resolved')
      return
    }
    if (input === 'd' && selected) {
      void applyState(selected, 'dismissed')
      return
    }
    if (input === 'R') {
      setState((prev) => ({ ...prev, showResolved: !prev.showResolved }))
      void refresh()
      return
    }
  })

  const openCount = state.items.filter((i) => i.state === 'open').length
  const ackCount = state.items.filter((i) => i.state === 'acknowledged').length

  if (state.detailId !== null) {
    const detailItem = state.items.find((i) => i.id === state.detailId)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">
            mars inbox · detail
          </Text>
        </Box>
        {detailItem ? (
          <DetailView item={detailItem} />
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
          <Text dimColor>r resolve · b back</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          mars inbox
        </Text>
        <Text> · </Text>
        <Text color="green">{openCount} open</Text>
        <Text> · </Text>
        <Text color="yellow">{ackCount} ack</Text>
        <Text> · </Text>
        <Text dimColor>{state.resolvedCount} resolved</Text>
        {state.showResolved && (
          <>
            <Text>  </Text>
            <Text color="magenta">[showing resolved]</Text>
          </>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.items.length === 0 ? (
          <Box justifyContent="center" paddingY={2}>
            <Text dimColor>inbox empty — nothing to triage</Text>
          </Box>
        ) : (
          state.items.map((item, idx) => (
            <ListRow
              key={item.id}
              item={item}
              selected={idx === state.cursor}
            />
          ))
        )}
      </Box>
      {state.error && (
        <Box marginTop={1}>
          <Text color="red">error: {state.error}</Text>
        </Box>
      )}
      {state.status && !state.error && (
        <Box marginTop={1}>
          <Text dimColor>{state.status}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          j/k move · enter detail · a ack · r resolve · d dismiss · R toggle
          resolved · q quit
        </Text>
      </Box>
    </Box>
  )
}

export const runInboxWatch = (): void => {
  render(<InboxWatchApp />)
}
