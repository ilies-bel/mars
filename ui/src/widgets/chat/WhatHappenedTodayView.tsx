/**
 * WhatHappenedTodayView — a self-contained, client-only "release notes" reply
 * that streams into view like a real assistant turn.
 *
 * The hero "What happened today?" quick action routes here instead of prefilling
 * the composer. Nothing here touches the daemon: the reply is canned markdown
 * revealed token-by-token via `useFakeStream`, then rendered through the same
 * AI-Elements `Message` / `Response` chrome the live transcript uses, so it reads
 * as a normal conversation turn (user bubble → streaming assistant bubble).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { Response } from '@/components/ai-elements/response'

/** The user turn shown at the top of the fake conversation. */
const USER_PROMPT = 'What happened today?'

/**
 * Canned release-notes reply (markdown). Modelled on a day's worth of merged
 * arcs so it reads like a real "while you were away" digest.
 */
const RELEASE_NOTES = `Here's what shipped today — **Mars v0.9.2**. Six arcs merged into \`main\` since your last visit.

### 🚀 Fixes
- **Merge lock** — bounded the integration-gate with its own timeout so a stuck verify releases the merge lock fast instead of blocking the queue.
- **Step duration** — the orchestrator now pairs step-duration correctly when a workflow repeats step names.
- **KPI compute** — repaired the \`kpi-compute\` test fixtures for the PGlite \`NOT NULL\` constraints.

### ✨ Improvements
- **Activity detail** — in-progress cards now surface the live merge/verify sub-phase as \`activity_detail\`, so you can see exactly where an arc is.
- **Relative time** — fixed \`relativeTime\` escalation and tightened task-detail schema validation in the UI.

### 📊 Today at a glance
- **6** arcs merged · **0** failed · **2** awaiting your review

Want me to open any of these, or groom the action queue next?`

interface UseFakeStreamResult {
  /** The portion of the text revealed so far. */
  text: string
  /** True once the whole string has been revealed. */
  done: boolean
}

/**
 * Reveal `fullText` progressively to mimic token streaming. Splits on
 * whitespace (preserving it) and advances a fixed number of tokens per tick so
 * markdown structure stays intact as it grows. Cleans up its timer on unmount.
 */
function useFakeStream(
  fullText: string,
  { tokensPerTick = 4, tickMs = 55 }: { tokensPerTick?: number; tickMs?: number } = {},
): UseFakeStreamResult {
  const tokens = useMemo(() => fullText.split(/(\s+)/), [fullText])
  const [count, setCount] = useState(0)

  useEffect(() => {
    setCount(0)
    if (tokens.length === 0) return
    let n = 0
    let cancelled = false
    const id = setInterval(() => {
      if (cancelled) return
      n = Math.min(n + tokensPerTick, tokens.length)
      setCount(n)
      if (n >= tokens.length) clearInterval(id)
    }, tickMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [tokens, tokensPerTick, tickMs])

  return { text: tokens.slice(0, count).join(''), done: count >= tokens.length }
}

/** A recipe auto-run hero-delta line rendered with a 🤖 prefix. */
export interface AutorunEntry {
  kind: 'recipe-autorun'
  text: string
}

export interface WhatHappenedTodayViewProps {
  /** Return to the hero empty state. */
  onBack: () => void
  /**
   * Recipe auto-run events to surface in the delta view.
   *
   * Each entry renders as a 🤖-prefixed one-liner below the release-notes
   * reply, explaining which taught recipe fired and on which task.
   */
  autorunEntries?: ReadonlyArray<AutorunEntry>
}

export const WhatHappenedTodayView = ({ onBack, autorunEntries = [] }: WhatHappenedTodayViewProps) => {
  const { text, done } = useFakeStream(RELEASE_NOTES)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center border-b border-primary/30 px-4 py-2">
        <button
          type="button"
          data-testid="what-happened-back"
          onClick={onBack}
          className="font-mono text-[11px] text-primary transition-colors hover:text-foreground"
        >
          ← Back to chat
        </button>
      </div>

      <Conversation className="flex-1">
        <ConversationContent>
          {/* User turn */}
          <Message from="user" data-message-role="user">
            <MessageContent variant="contained">
              <Response>{USER_PROMPT}</Response>
            </MessageContent>
          </Message>

          {/* Streaming assistant turn */}
          <Message from="assistant" data-message-role="assistant">
            <MessageContent
              variant="flat"
              className="border border-primary/20 bg-card px-3 py-2"
            >
              <Response>{text}</Response>
              {!done && (
                <span
                  className="ml-0.5 inline-block h-3 w-0.5 animate-pulse rounded-sm bg-foreground/60 align-middle"
                  aria-hidden="true"
                  data-testid="what-happened-cursor"
                />
              )}
            </MessageContent>
          </Message>

          {/* Recipe auto-run hero feed lines — one 🤖 line per auto-applied teach */}
          {autorunEntries.length > 0 && (
            <ul
              data-testid="recipe-autorun-feed"
              className="mt-2 flex flex-col gap-0.5 px-1"
            >
              {autorunEntries.map((entry, i) => (
                <li
                  key={i}
                  data-testid="recipe-autorun-line"
                  className="font-mono text-[12px] text-foreground/80"
                >
                  🤖 {entry.text}
                </li>
              ))}
            </ul>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  )
}
