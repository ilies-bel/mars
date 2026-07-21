import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { eventsUrl } from './api'
import { getOpenTaskId } from './openTaskId'
import { setSseConnected } from './sseStatus'
import { publishChatDelta } from './chatDeltaBus'
import type { LiveEvent } from './liveEvent'

export const SseInvalidator = () => {
  const qc = useQueryClient()

  useEffect(() => {
    const es = new EventSource(eventsUrl())
    // On every connect (including reconnects after a drop), mark the channel
    // live and invalidate all views so any events missed during the outage
    // are caught immediately on the next fetch.
    es.addEventListener('hello', () => {
      setSseConnected(true)
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
    let tasksDebounce: ReturnType<typeof setTimeout> | null = null
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
    let proposalsDebounce: ReturnType<typeof setTimeout> | null = null
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
    let progressDebounce: ReturnType<typeof setTimeout> | null = null
    es.addEventListener('progress', () => {
      if (progressDebounce !== null) clearTimeout(progressDebounce)
      progressDebounce = setTimeout(() => {
        progressDebounce = null
        void qc.invalidateQueries({ queryKey: ['progress'] })
      }, 150)
    })

    // 'chat' events fire when a thread is created, updated, or a new message
    // lands. Invalidate both the threads list and any open thread detail view.
    let chatDebounce: ReturnType<typeof setTimeout> | null = null
    es.addEventListener('chat', () => {
      if (chatDebounce !== null) clearTimeout(chatDebounce)
      chatDebounce = setTimeout(() => {
        chatDebounce = null
        void qc.invalidateQueries({ queryKey: ['chat-threads'] })
        void qc.invalidateQueries({ queryKey: ['chat-thread'] })
      }, 150)
    })

    // 'chat-delta' events carry live segment data from the daemon chat-runner.
    // Publish each raw segment onto the per-thread delta bus; the active
    // thread's MarsChatTransport subscribes and normalises it into the
    // UIMessage stream that useChat renders.
    es.addEventListener('chat-delta', (e) => {
      try {
        const me = e as MessageEvent<string>
        const payload = JSON.parse(me.data) as unknown
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'threadId' in payload &&
          typeof (payload as Record<string, unknown>).threadId === 'string' &&
          'event' in payload
        ) {
          const { threadId, event } = payload as { threadId: string; event: LiveEvent }
          publishChatDelta(threadId, event)
        }
      } catch {
        // Malformed payload — ignore.
      }
    })

    es.onerror = () => setSseConnected(false)
    return () => {
      if (tasksDebounce !== null) clearTimeout(tasksDebounce)
      if (proposalsDebounce !== null) clearTimeout(proposalsDebounce)
      if (progressDebounce !== null) clearTimeout(progressDebounce)
      if (chatDebounce !== null) clearTimeout(chatDebounce)
      es.close()
      setSseConnected(false)
    }
  }, [qc])

  return null
}
