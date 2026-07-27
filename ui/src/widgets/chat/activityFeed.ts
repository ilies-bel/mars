/**
 * activityFeed — pure helper for the "Recent activity" context-rail panel.
 *
 * Merges live tool-call segments from a streaming LiveBuffer with persisted
 * tool_use segments from the saved thread history, producing an ordered feed
 * capped at 8 entries (most-recent first) with a 'live'|'persisted' state tag.
 *
 * No React dependencies — plain TypeScript, tested in isolation.
 */

import type { ChatThreadDetail } from '@/shared/schemas'
import type { LiveBuffer } from '@/shared/chatBuffer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityEntry = {
  /** Stable id for React key / dedup (toolUseId for live; segment id for persisted). */
  id: string
  /** The name of the tool (e.g. 'Bash', 'Read'). */
  toolName: string
  /** 'live' while the entry is from the active streaming buffer; 'persisted' once saved. */
  state: 'live' | 'persisted'
  /** Raw input sent to the tool. */
  input: unknown
  /** Epoch-ms timestamp; approximate for live entries (set at build time). */
  ts: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 8

// ---------------------------------------------------------------------------
// buildActivityFeed
// ---------------------------------------------------------------------------

/**
 * Build an ordered activity feed for the "Recent activity" panel.
 *
 * @param threadDetail  Persisted thread history; null/undefined when absent.
 * @param liveBuffer    Active streaming buffer; null when not streaming.
 * @param isStreaming   Whether the client is currently streaming a reply.
 * @returns             Up to 8 ActivityEntry items, live entries first.
 */
export function buildActivityFeed(
  threadDetail: ChatThreadDetail | null | undefined,
  liveBuffer: LiveBuffer | null,
  isStreaming: boolean,
): ActivityEntry[] {
  const live: ActivityEntry[] = []
  const persisted: ActivityEntry[] = []
  const nowMs = Date.now()

  // Collect live entries from liveBuffer when actively streaming.
  // Segments arrive in arrival order; we collect then reverse so the most-
  // recently started tool call appears first.
  if (isStreaming && liveBuffer) {
    let idx = 0
    for (const seg of liveBuffer.segments) {
      if (seg.type === 'tool_group') {
        for (const tool of seg.tools) {
          live.push({
            id: tool.toolUseId,
            toolName: tool.toolName,
            state: 'live',
            input: tool.input,
            ts: nowMs + idx,
          })
          idx++
        }
      }
    }
    live.reverse()
  }

  // Collect persisted entries from threadDetail, skipping any ids already
  // covered by the live buffer (avoids duplicates when the same tool call
  // appears in both sources during a streaming transition).
  if (threadDetail) {
    const liveIds = new Set(live.map((e) => e.id))
    const msgs = threadDetail.messages
    // Walk messages newest-first, then segments newest-first within each message.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]!
      const msgTs = new Date(msg.createdAt).getTime()
      const segs = msg.segments
      for (let j = segs.length - 1; j >= 0; j--) {
        const seg = segs[j]!
        if (seg.type === 'tool_use') {
          const id = seg.id ?? `${msg.id}:${j}`
          if (!liveIds.has(id)) {
            persisted.push({
              id,
              toolName: seg.toolName,
              state: 'persisted',
              input: seg.input,
              ts: msgTs,
            })
          }
        }
      }
    }
  }

  // Live entries first (most-recent live at index 0), then persisted entries.
  return [...live, ...persisted].slice(0, MAX_ENTRIES)
}
