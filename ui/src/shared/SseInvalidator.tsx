import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { eventsUrl } from './api'
import { getOpenTaskId } from './openTaskId'
import { setSseConnected } from './sseStatus'
import { liveTaskQueryKey } from '../widgets/LiveTaskPanel'

/** Initial delay before the first reconnect attempt (ms). */
const MIN_BACKOFF = 1_000
/** Maximum reconnect delay cap — exponential growth stops here (~15 s). */
const MAX_BACKOFF = 15_000

export const SseInvalidator = () => {
  const qc = useQueryClient()

  useEffect(() => {
    let stopped = false
    let backoff = MIN_BACKOFF
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let currentEs: EventSource | null = null

    // Debounce timers live outside connect() so rapid events that straddle a
    // reconnect boundary are still coalesced into a single invalidation batch.
    let tasksDebounce: ReturnType<typeof setTimeout> | null = null
    let proposalsDebounce: ReturnType<typeof setTimeout> | null = null
    let progressDebounce: ReturnType<typeof setTimeout> | null = null
    let chatDebounce: ReturnType<typeof setTimeout> | null = null

    const connect = (): void => {
      if (stopped) return
      const es = new EventSource(eventsUrl())
      currentEs = es

      // On every (re)connect, mark the channel live and invalidate all views
      // so any events missed during the outage are caught immediately on the
      // next fetch. The server sends 'hello' on every fresh SSE connection.
      es.addEventListener('hello', () => {
        setSseConnected(true)
        backoff = MIN_BACKOFF  // reset exponential backoff after a successful link
        void qc.invalidateQueries({ queryKey: ['tasks'] })
        void qc.invalidateQueries({ queryKey: ['progress'] })
        void qc.invalidateQueries({ queryKey: ['proposals'] })
        void qc.invalidateQueries({ queryKey: ['stale-worktrees'] })
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
      })

      // Coalesce rapid task-change events: many tasks may update in quick
      // succession (e.g. orchestrator dispatching a batch).  Rather than
      // firing N × 4 invalidations, debounce at 150 ms so the burst resolves
      // into a single set of refetches.
      es.addEventListener('tasks', () => {
        if (tasksDebounce !== null) clearTimeout(tasksDebounce)
        tasksDebounce = setTimeout(() => {
          tasksDebounce = null
          void qc.invalidateQueries({ queryKey: ['tasks'] })
          void qc.invalidateQueries({ queryKey: ['progress'] })
          void qc.invalidateQueries({ queryKey: ['action-queue'] })
          // Refetch the open drawer's task alongside Progress so the status
          // chip and section data update in place. Switching the drawer to a
          // different id automatically retargets here because `getOpenTaskId`
          // reads the current store value at event time.
          const openId = getOpenTaskId()
          if (openId !== null) {
            void qc.invalidateQueries({ queryKey: ['task', openId] })
          }
        }, 150)
      })

      // 'proposals' events only touch the proposals/stale-worktrees/action-queue
      // surfaces — they do not require a full progress refetch.
      es.addEventListener('proposals', () => {
        if (proposalsDebounce !== null) clearTimeout(proposalsDebounce)
        proposalsDebounce = setTimeout(() => {
          proposalsDebounce = null
          void qc.invalidateQueries({ queryKey: ['proposals'] })
          void qc.invalidateQueries({ queryKey: ['stale-worktrees'] })
          void qc.invalidateQueries({ queryKey: ['action-queue'] })
        }, 150)
      })

      // 'progress' events fire when proposal lifecycle events occur (added,
      // promoted, sliced, dismissed).  These only affect the Progress tab, so
      // we invalidate the 'progress' query key only — not 'tasks' or 'todo'.
      es.addEventListener('progress', () => {
        if (progressDebounce !== null) clearTimeout(progressDebounce)
        progressDebounce = setTimeout(() => {
          progressDebounce = null
          void qc.invalidateQueries({ queryKey: ['progress'] })
        }, 150)
      })

      // 'chat' events fire when a thread is created, updated, or a new message
      // lands. Invalidate active threads, archived Subthreads, and any open detail.
      // Also invalidate thread-tasks so the TASKS panel in ContextRail reflects any
      // tasks filed by the agent during the conversation (linkTaskToThread is called
      // after shell-based `mars task add` commands, before this event fires).
      es.addEventListener('chat', () => {
        if (chatDebounce !== null) clearTimeout(chatDebounce)
        chatDebounce = setTimeout(() => {
          chatDebounce = null
          void qc.invalidateQueries({ queryKey: ['chat-threads'] })
          void qc.invalidateQueries({ queryKey: ['chat-history'] })
          void qc.invalidateQueries({ queryKey: ['chat-thread'] })
          // The main feed. Without this a Notice Mars speaks on its own is
          // durable but invisible until something else forces a refetch —
          // which is not a conversation, it is a log you have to go and read.
          void qc.invalidateQueries({ queryKey: ['chat-conversation'] })
          // Re-derive the TASKS panel: the agent may have filed tasks during this
          // conversation turn via shell `mars task add`. The link is written before
          // hub.broadcast('chat') fires, so the re-fetch returns fresh data.
          void qc.invalidateQueries({ queryKey: ['thread-tasks'] })
        }, 150)
      })

      // Live chat token streaming no longer flows through this global SSE channel:
      // the daemon exposes a per-thread UIMessage-chunk stream
      // (`GET /api/chat/thread/:id/ui-stream`) that `MarsChatTransport` consumes
      // directly. The `chat` invalidation ping above still refetches the thread
      // list + open thread detail so persisted history reconciles.

      // 'live-task' events fire when `mars task note` or `mars task check` writes
      // to a task's progress journal. The payload carries { taskId } so only the
      // relevant LiveTaskPanel re-fetches — no broad invalidation, no debounce
      // (notes arrive one at a time and the endpoint is cheap).
      es.addEventListener('live-task', (e) => {
        const { taskId } = JSON.parse((e as MessageEvent).data) as { taskId: string }
        void qc.invalidateQueries({ queryKey: liveTaskQueryKey(taskId) })
      })

      es.onerror = () => {
        setSseConnected(false)
        es.close()
        if (currentEs === es) currentEs = null
        if (!stopped) {
          // Schedule the next reconnect with the current backoff, then grow it
          // (capped at MAX_BACKOFF) for the next failure.  The backoff resets to
          // MIN_BACKOFF on a successful 'hello' so brief outages recover quickly.
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            connect()
          }, backoff)
          backoff = Math.min(backoff * 2, MAX_BACKOFF)
        }
      }
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      if (tasksDebounce !== null) clearTimeout(tasksDebounce)
      if (proposalsDebounce !== null) clearTimeout(proposalsDebounce)
      if (progressDebounce !== null) clearTimeout(progressDebounce)
      if (chatDebounce !== null) clearTimeout(chatDebounce)
      currentEs?.close()
      currentEs = null
      setSseConnected(false)
    }
  }, [qc])

  return null
}
