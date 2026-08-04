import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { eventsUrl } from './api'
import { getOpenTaskId } from './openTaskId'
import { setSseConnected } from './sseStatus'

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
    // lands. Invalidate active threads, archived Subthreads, and any open detail.
    let chatDebounce: ReturnType<typeof setTimeout> | null = null
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
      }, 150)
    })

    // Live chat token streaming no longer flows through this global SSE channel:
    // the daemon exposes a per-thread UIMessage-chunk stream
    // (`GET /api/chat/thread/:id/ui-stream`) that `MarsChatTransport` consumes
    // directly. The `chat` invalidation ping above still refetches the thread
    // list + open thread detail so persisted history reconciles.

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
