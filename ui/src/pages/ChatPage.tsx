/**
 * ChatPage — default landing screen for mars.
 *
 * Layout: narrow threads sidebar (create, rename on double-click, delete with
 * confirm) + main area (message list with segment rendering + composer).
 *
 * Message segments:
 *   text      → react-markdown + remark-gfm inside `.chat-markdown` prose div
 *   thinking  → collapsible "Thought process" block at reduced opacity
 *   tool_use  → consecutive runs collapse into an activity group header
 *               "Used N tools — Bash ×3, Read" expandable to per-tool detail
 *
 * Welcome state (no messages): quick-action chips + slash palette on `/` in
 * composer as canned prompt prefills (not RPC calls).
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useQuery, useMutation } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  fetchChatThreads,
  fetchChatThread,
  fetchActionQueue,
  createChatThread,
  postChatMessage,
  renameChatThread,
  deleteChatThread,
  stopChatThread,
  invokeAction,
  setMessageFeedback,
  clearMessageFeedback,
  ApiError,
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { ChatThread, ChatMessage, ChatSegmentToolUse, ChatSegmentAlert, ChatSegmentResult, ActionQueueItem, ActionDescriptor, ChatFeedback } from '@/shared/schemas'
import { AlertCard } from '@/widgets/chat/AlertCard'
import { ContextRail } from '@/widgets/chat/ContextRail'
import { WhileYouWereAwayPanel } from '@/widgets/WhileYouWereAwayPanel'
import { FallbackSurface } from '@/components/FallbackSurface'
import { QueueThreadRow } from '@/widgets/chat/QueueThreadRow'
import { QueueThreadDetail, PROCESS_LEVEL_OPS } from '@/widgets/chat/QueueThreadDetail'
import {
  mergeSidebarEntries,
  isResolvedSelection,
  type KindFilter,
} from '@/widgets/chat/queueThreads'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useActionQueueHistory } from '@/entities/actionQueue/useActionQueueHistory'
import { historyLabel } from '@/pages/ActionQueuePageFilters'
import { kindBadgeLabel } from '@/shared/actionQueueDetail'
import { readAqStateFromUrl, writeAqStateToUrl } from '@/shared/actionQueueUrlState'
import { taskHash } from '@/shared/routing'
import { useLiveBuffer, clearLiveBuffer } from '@/shared/chatBuffer'
import { formatDuration, relativeTime } from '@/shared/time'

// ---------------------------------------------------------------------------
// Welcome state: quick-action chips and slash palette
// ---------------------------------------------------------------------------

const WELCOME_CHIPS = [
  { label: 'Groom the action queue', prompt: 'Groom the action queue' },
  { label: 'Grill an idea', prompt: 'Grill this idea into a PRD: ' },
  { label: 'Enqueue a task', prompt: 'Enqueue a task: ' },
  { label: "What happened today?", prompt: 'What happened today?' },
] as const

const SLASH_COMMANDS = [
  { cmd: '/grill', prompt: 'Grill this idea into a PRD: ' },
  { cmd: '/task', prompt: 'Enqueue a task: ' },
  { cmd: '/action-queue', prompt: 'Groom the action queue' },
  { cmd: '/unblock', prompt: 'Help unblock task ' },
] as const

// ---------------------------------------------------------------------------
// Hero empty state — top-alert prioritization and suggestion chips
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
  high: 0,
  normal: 1,
  low: 2,
}

/**
 * Returns the most important open action-queue alert from a list.
 * Sort key: priority (high → normal → low), then `at` descending (newest tiebreak).
 * Returns null for an empty list.
 */
export const pickTopAlert = (items: ActionQueueItem[]): ActionQueueItem | null => {
  if (items.length === 0) return null
  return [...items].sort((a, b) => {
    const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (pd !== 0) return pd
    // newest first: lexicographic ISO-string comparison works because
    // all at-values use the same UTC format
    return b.at.localeCompare(a.at)
  })[0] ?? null
}

const KIND_ICON: Record<string, string> = {
  'failed-task': '⚠️',
  'stale-worktree': '🗑️',
  'draft-proposal': '💡',
  'awaiting-validation': '🔍',
  'arc-failed': '⛓️',
}

export interface HeroSuggestionsProps {
  /** The top open alert, or null when the action queue is clear. */
  topAlert: ActionQueueItem | null
  /** Called when the user clicks the alert chip. */
  onAlertClick: () => void
  /** Called when the user clicks a quick-action chip; receives the prefill prompt. */
  onChipClick: (prompt: string) => void
}

/**
 * Suggestion row rendered below the hero composer.
 *
 * When a top alert is provided it renders as the FIRST chip so the user is
 * immediately aware of the most pressing item. The standard quick-action chips
 * follow.
 */
export const HeroSuggestions = ({ topAlert, onAlertClick, onChipClick }: HeroSuggestionsProps) => (
  <div className="flex flex-wrap justify-center gap-2 max-w-2xl">
    {topAlert !== null && (
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/5 px-3 py-1.5 font-mono text-[11px] text-fg transition-colors hover:border-accent/70 hover:bg-accent/10 active:scale-[0.97]"
        onClick={onAlertClick}
        data-testid="hero-alert-chip"
      >
        <span aria-hidden="true" className="flex-none text-[12px]">
          {KIND_ICON[topAlert.kind] ?? '🔔'}
        </span>
        <span className="max-w-[200px] truncate font-semibold">{topAlert.title}</span>
        <span className="max-w-[140px] truncate text-iron/60">— {topAlert.body}</span>
      </button>
    )}
    {WELCOME_CHIPS.map(({ label, prompt }) => (
      <button
        key={label}
        type="button"
        className="rounded border border-iron/40 px-3 py-1.5 font-mono text-[11px] text-iron transition-colors hover:border-iron/70 hover:bg-iron/20 hover:text-fg active:scale-[0.97]"
        onClick={() => onChipClick(prompt)}
      >
        {label}
      </button>
    ))}
  </div>
)

// ---------------------------------------------------------------------------
// Segment grouping helpers
// ---------------------------------------------------------------------------

type ToolGroup = { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
type FlatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'error'; message: string }
  | ToolGroup
  | { kind: 'alert'; alert: ChatSegmentAlert }
  | { kind: 'result'; result: ChatSegmentResult }

/**
 * Collapses consecutive tool_use segments into a single ToolGroup so the UI
 * can render them as a collapsible activity row.
 *
 * tool_result segments are absorbed into the preceding ToolGroup by attaching
 * their content to the matching tool_use (via tool_use_id) rather than being
 * rendered standalone.
 *
 * thinking segments with empty text are silently dropped — they produce no
 * visible output rather than an empty "Thought process" block.
 */
export const groupMessageSegments = (msg: ChatMessage): FlatSegment[] => {
  const out: FlatSegment[] = []
  // Shallow-copy each tool_use so we can safely attach tool_result content.
  let currentTools: ChatSegmentToolUse[] | null = null

  const flushTools = () => {
    if (currentTools !== null) {
      out.push({ kind: 'tool_group', tools: currentTools })
      currentTools = null
    }
  }

  for (const seg of msg.segments) {
    if (seg.type === 'tool_use') {
      if (currentTools === null) currentTools = []
      // Shallow-copy so we can set .result without mutating the parsed segment.
      currentTools.push({ ...seg })
    } else if (seg.type === 'tool_result') {
      // Attach to the matching tool_use inside the current group. Don't flush —
      // tool_result is part of the same activity block as its tool_use.
      if (currentTools !== null) {
        const match = seg.tool_use_id
          ? currentTools.find(t => t.id === seg.tool_use_id)
          : currentTools[currentTools.length - 1]
        if (match) {
          match.result = seg.content
          if (seg.isError) match.isError = true
        }
      }
    } else {
      flushTools()
      if (seg.type === 'text') {
        out.push({ kind: 'text', text: seg.text })
      } else if (seg.type === 'alert') {
        out.push({ kind: 'alert', alert: seg })
      } else if (seg.type === 'result') {
        out.push({ kind: 'result', result: seg })
      } else if (seg.type === 'thinking' && seg.text) {
        // Skip empty thinking segments — they render as a pointless blank block.
        out.push({ kind: 'thinking', text: seg.text })
      } else if (seg.type === 'error') {
        out.push({ kind: 'error', message: seg.message })
      }
      // Any other (unknown) segment type is silently dropped.
    }
  }
  flushTools()
  return out
}

/**
 * Summarises a tool group for the collapsed header:
 *   "Used 4 tools — Bash ×3, Read"
 */
export const toolGroupLabel = (tools: ChatSegmentToolUse[]): string => {
  const counts: Record<string, number> = {}
  for (const t of tools) {
    counts[t.toolName] = (counts[t.toolName] ?? 0) + 1
  }
  const parts = Object.entries(counts).map(([name, n]) =>
    n > 1 ? `${name} ×${n}` : name,
  )
  return `Used ${tools.length} tool${tools.length !== 1 ? 's' : ''} — ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------
// Small, single-use presentational components (all private to this file)
// ---------------------------------------------------------------------------

/** Render a tool_use segment's input/result JSON in a capped scroll box. */
const JsonBox = ({ value }: { value: unknown }) => (
  <pre className="max-h-40 overflow-auto rounded bg-iron/10 p-2 font-mono text-[11px] leading-relaxed text-iron">
    {JSON.stringify(value, null, 2)}
  </pre>
)

/** One expanded tool entry inside an activity group. */
const ToolDetail = ({ tool }: { tool: ChatSegmentToolUse }) => {
  const [open, setOpen] = useState(false)
  const isError = tool.isError ?? false

  return (
    <div className="border-b border-iron/20 last:border-0">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left font-mono text-[11px] hover:bg-iron/10"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-iron/60">{open ? '▼' : '▶'}</span>
        <span className={isError ? 'text-red-400' : 'text-iron'}>{tool.toolName}</span>
        <span className={`ml-auto ${isError ? 'text-red-400' : 'text-iron/60'}`}>
          {isError ? '✕' : '✓'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1.5">
          {tool.input !== undefined && (
            <div>
              <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-iron/50">
                Input
              </div>
              <JsonBox value={tool.input} />
            </div>
          )}
          {tool.result !== undefined && (
            <div>
              <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-iron/50">
                Result
              </div>
              <div className={isError ? 'rounded border border-red-400/30 bg-red-900/10' : ''}>
                <JsonBox value={tool.result} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Collapsible activity group for consecutive tool_use segments. */
const ToolActivityGroup = ({ tools }: { tools: ChatSegmentToolUse[] }) => {
  const [expanded, setExpanded] = useState(false)
  const label = toolGroupLabel(tools)

  return (
    <div className="my-1 rounded border border-iron/20 bg-surface text-[12px]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-iron hover:bg-iron/10"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-iron/50">{expanded ? '▼' : '▶'}</span>
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="border-t border-iron/20">
          {tools.map((t, i) => (
            <ToolDetail key={t.id ?? i} tool={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Collapsible thinking block at reduced opacity. */
const ThinkingBlock = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false)

  return (
    <div className="my-1 rounded border border-iron/20 bg-surface opacity-60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] text-iron hover:bg-iron/10"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-iron/50">{open ? '▼' : '▶'}</span>
        <span>Thought process</span>
      </button>
      {open && (
        <div className="border-t border-iron/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-iron/80 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

/** Adapt a ChatSegmentAlert to AlertCard props and render it. */
const AlertCardFromSegment = ({ alert }: { alert: ChatSegmentAlert }) => {
  // Defensive: verbs/actions may be absent on legacy items bypassing schema defaults.
  const recipeVerbs = alert.verbs ?? []
  const legacyActions = alert.actions ?? []
  const verbs =
    recipeVerbs.length > 0
      ? recipeVerbs
      : legacyActions.map((a) => ({ op: a.op, label: a.label, style: a.style }))
  return (
    <AlertCard
      itemId={`${alert.kind}:${alert.entityId}`}
      entityId={alert.entityId}
      kind={alert.kind}
      summary={alert.humanSummary || alert.title}
      detail={alert.humanDetail}
      verbs={verbs}
      resolved={alert.resolved}
      snoozeUntil={alert.snoozeUntil}
    />
  )
}

// ---------------------------------------------------------------------------
// Feedback controls for assistant messages
// ---------------------------------------------------------------------------

// Inline SVG thumbs icons — no icon-library dependency.
const ThumbUpSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width="14"
    height="14"
    aria-hidden="true"
  >
    <path d="M1 8.25a1.25 1.25 0 1 1 2.5 0v7.5a1.25 1.25 0 0 1-2.5 0v-7.5zM11 3V1.7c0-.268.14-.526.395-.607A2 2 0 0 1 14 3c0 .995-.182 1.948-.514 2.826-.204.54.166 1.174.744 1.174h2.52c1.243 0 2.261 1.01 2.146 2.247a23.864 23.864 0 0 1-1.341 5.974C17.153 16.323 16.072 17 14.9 17H8.8c-.72 0-1.4-.285-1.895-.787L4.81 14.098a1.25 1.25 0 0 1 0-1.77l1.5-1.5a1.25 1.25 0 0 1 .884-.366h.738c.64 0 1.18-.42 1.373-1.003L11 3z" />
  </svg>
)

const ThumbDownSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width="14"
    height="14"
    aria-hidden="true"
  >
    <path d="M19 11.75a1.25 1.25 0 1 1-2.5 0v-7.5a1.25 1.25 0 0 1 2.5 0v7.5zM9 17v1.3c0 .268-.14.526-.395.607A2 2 0 0 1 6 17c0-.995.182-1.948.514-2.826.204-.54-.166-1.174-.744-1.174H3.25C2.007 13 .989 11.99 1.104 10.753a23.864 23.864 0 0 1 1.341-5.974C2.847 3.677 3.928 3 5.1 3h6.1c.72 0 1.4.285 1.895.787l2.095 2.211a1.25 1.25 0 0 1 0 1.77l-1.5 1.5a1.25 1.25 0 0 1-.884.366h-.738c-.64 0-1.18.42-1.373 1.003L9 17z" />
  </svg>
)

interface FeedbackControlsProps {
  messageId: string
  feedback: ChatFeedback | null
  onFeedbackChange: () => void
}

/**
 * Thumbs-up / thumbs-down controls for assistant messages.
 *
 * - Always visible once a rating exists; otherwise shown on hover/focus only.
 * - Clicking the active rating clears it.
 * - Thumbs-down reveals a single-line note input (submit on Enter/blur; Escape
 *   dismisses without clearing the rating).
 * - Thumbs-up stores immediately with no note.
 * - Optimistic local state; reverts on error.
 */
export const FeedbackControls = ({ messageId, feedback, onFeedbackChange }: FeedbackControlsProps) => {
  // Optimistic local state shadows the persisted value.
  const [localRating, setLocalRating] = useState<'up' | 'down' | null>(feedback?.rating ?? null)
  const [localNote, setLocalNote] = useState<string | null>(feedback?.note ?? null)
  const [showNote, setShowNote] = useState(false)
  const [noteInput, setNoteInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const noteRef = useRef<HTMLInputElement>(null)

  // Sync to persisted value whenever it changes from outside (SSE refetch).
  useEffect(() => {
    setLocalRating(feedback?.rating ?? null)
    setLocalNote(feedback?.note ?? null)
  }, [feedback?.rating, feedback?.note])

  useEffect(() => {
    if (showNote) noteRef.current?.focus()
  }, [showNote])

  const invalidate = () => {
    onFeedbackChange()
  }

  const handleUp = async () => {
    setError(null)
    if (localRating === 'up') {
      // Toggle off.
      const prev = localRating
      setLocalRating(null)
      try {
        await clearMessageFeedback(messageId)
        invalidate()
      } catch (e) {
        setLocalRating(prev)
        setError(e instanceof Error ? e.message : 'Failed to clear feedback')
      }
      return
    }
    setShowNote(false)
    const prevRating = localRating
    setLocalRating('up')
    try {
      await setMessageFeedback(messageId, 'up', null)
      invalidate()
    } catch (e) {
      setLocalRating(prevRating)
      setError(e instanceof Error ? e.message : 'Failed to set feedback')
    }
  }

  const handleDown = async () => {
    setError(null)
    if (localRating === 'down') {
      // Toggle off.
      const prev = localRating
      setLocalRating(null)
      setShowNote(false)
      try {
        await clearMessageFeedback(messageId)
        invalidate()
      } catch (e) {
        setLocalRating(prev)
        setError(e instanceof Error ? e.message : 'Failed to clear feedback')
      }
      return
    }
    // Set rating immediately, then show note input.
    const prevRating = localRating
    setLocalRating('down')
    try {
      await setMessageFeedback(messageId, 'down', null)
      invalidate()
    } catch (e) {
      setLocalRating(prevRating)
      setError(e instanceof Error ? e.message : 'Failed to set feedback')
      return
    }
    setNoteInput(localNote ?? '')
    setShowNote(true)
  }

  const submitNote = async () => {
    const note = noteInput.trim() || null
    setShowNote(false)
    const prevNote = localNote
    setLocalNote(note)
    try {
      await setMessageFeedback(messageId, 'down', note)
      invalidate()
    } catch (e) {
      setLocalNote(prevNote)
      setError(e instanceof Error ? e.message : 'Failed to save note')
    }
  }

  const hasRating = localRating !== null

  return (
    <div
      className={[
        'mt-1.5 flex flex-col gap-1',
        hasRating ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
      ].join(' ')}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={localRating === 'up'}
          aria-label="helpful"
          className={[
            'rounded p-0.5 transition-colors',
            localRating === 'up'
              ? 'text-accent'
              : 'text-iron/40 hover:text-iron',
          ].join(' ')}
          onClick={() => void handleUp()}
        >
          <ThumbUpSvg />
        </button>
        <button
          type="button"
          aria-pressed={localRating === 'down'}
          aria-label="not helpful"
          className={[
            'rounded p-0.5 transition-colors',
            localRating === 'down'
              ? 'text-red-400'
              : 'text-iron/40 hover:text-iron',
          ].join(' ')}
          onClick={() => void handleDown()}
        >
          <ThumbDownSvg />
        </button>
        {localNote && localRating === 'down' && (
          <span
            className="max-w-[200px] truncate font-mono text-[10px] text-iron/50"
            title={localNote}
          >
            {localNote}
          </span>
        )}
      </div>
      {showNote && (
        <input
          ref={noteRef}
          type="text"
          aria-label="What went wrong? (optional)"
          placeholder="What went wrong? (optional)"
          className="w-full max-w-xs rounded border border-iron/30 bg-surface px-2 py-1 font-mono text-[11px] text-fg placeholder:text-iron/40 focus:border-iron/60 focus:outline-none"
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitNote()
            if (e.key === 'Escape') setShowNote(false)
          }}
          onBlur={() => void submitNote()}
        />
      )}
      {error && (
        <p className="font-mono text-[10px] text-red-400">{error}</p>
      )}
    </div>
  )
}

/** A safe, compact recovery surface for an interrupted assistant response. */
const ChatResponseError = ({ onTryAgain }: { onTryAgain: () => void }) => (
  <div
    role="alert"
    className="my-2 flex items-start gap-3 rounded-md border border-error/25 bg-error/5 px-3 py-2.5 text-[13px] text-fg"
  >
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-error text-[10px] font-bold leading-none text-white"
    >
      !
    </span>
    <div className="min-w-0 leading-relaxed">
      <p className="font-medium">Response interrupted</p>
      <p className="text-muted">Codex could not finish this reply. Send another message to try again.</p>
      <button
        type="button"
        className="mt-1.5 text-[12px] font-medium text-error underline decoration-error/40 underline-offset-2 transition-colors hover:text-fg"
        onClick={onTryAgain}
      >
        Try again
      </button>
    </div>
  </div>
)

/** A single chat message rendered with segment grouping. */
export const ChatMessageBubble = ({
  msg,
  onDiscuss,
  onFeedbackChange,
}: {
  msg: ChatMessage
  onDiscuss: (prompt: string) => void
  /** Called after a feedback write so the parent can invalidate its query cache. */
  onFeedbackChange?: () => void
}) => {
  const segments = groupMessageSegments(msg)
  const isUser = msg.role === 'user'
  // For assistant messages, apply card chrome only when the message contains
  // non-alert content. AlertCard already renders its own bordered card, so a
  // pure-alert message skips the outer border to avoid double-boxing.
  const assistantHasNonAlert = !isUser && segments.some(seg => seg.kind !== 'alert')
  const handleFeedbackChange = useCallback(() => {
    onFeedbackChange?.()
  }, [onFeedbackChange])

  return (
    <div className={`group flex ${isUser ? 'justify-end' : 'justify-start'} px-4 py-1`}>
      <div
        className={[
          'max-w-[80%] rounded-lg',
          isUser
            ? 'bg-iron/20 px-3 py-2 font-mono text-[12px] text-fg'
            : assistantHasNonAlert
              ? 'flex-1 border border-iron/20 bg-surface px-3 py-2 text-[13px]'
              : 'flex-1 text-[13px]',
        ].join(' ')}
      >
        {segments.map((seg, i) => {
          if (seg.kind === 'text') {
            return (
              <div key={i} className="chat-markdown prose prose-sm prose-invert max-w-none">
                <Markdown remarkPlugins={[remarkGfm]}>{seg.text}</Markdown>
              </div>
            )
          }
          if (seg.kind === 'alert') {
            return (
              <AlertCardFromSegment
                key={i}
                alert={seg.alert}
              />
            )
          }
          if (seg.kind === 'result') {
            const { durationMs, inputTokens, outputTokens, cost } = seg.result
            const parts: string[] = []
            if (durationMs != null) parts.push(formatDuration(durationMs))
            if (inputTokens != null || outputTokens != null) {
              parts.push(`${(inputTokens ?? 0) + (outputTokens ?? 0)} tokens`)
            }
            if (cost != null && cost > 0) parts.push(`$${cost.toFixed(4)}`)
            return (
              <div key={i} className="mt-2 font-mono text-[10px] text-iron/40">
                {parts.join(' · ')}
              </div>
            )
          }
          if (seg.kind === 'thinking') {
            return <ThinkingBlock key={i} text={seg.text} />
          }
          if (seg.kind === 'error') {
            return (
              <ChatResponseError
                key={i}
                onTryAgain={() => onDiscuss('Please retry my last request.')}
              />
            )
          }
          return <ToolActivityGroup key={i} tools={seg.tools} />
        })}
        {!isUser && (
          <FeedbackControls
            messageId={msg.id}
            feedback={msg.feedback ?? null}
            onFeedbackChange={handleFeedbackChange}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread list sidebar
// ---------------------------------------------------------------------------

interface ThreadItemProps {
  thread: ChatThread
  isSelected: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}

const ThreadItem = ({ thread, isSelected, onSelect, onRename, onDelete }: ThreadItemProps) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => {
    setDraft(thread.title || 'New thread')
    setEditing(true)
  }

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitEdit = () => {
    const value = draft.trim()
    if (value.length > 0 && value !== thread.title) {
      onRename(value)
    }
    setEditing(false)
  }

  const title = thread.title || 'New thread'

  return (
    <div
      className={[
        'group flex items-center gap-1 rounded px-2 py-1.5 cursor-pointer',
        isSelected ? 'bg-iron/20 text-fg' : 'text-iron hover:bg-iron/10 hover:text-fg',
      ].join(' ')}
      onClick={onSelect}
      onDoubleClick={startEdit}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="flex-1 rounded bg-iron/10 px-1 font-mono text-[11px] text-fg outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') setEditing(false)
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          {thread.origin === 'alert' && (
            <span
              className={[
                'flex-none text-[10px]',
                thread.alertResolved ? 'opacity-30' : 'text-accent',
              ].join(' ')}
              title={thread.alertResolved ? 'Alert resolved' : 'Active alert'}
            >
              🔔
            </span>
          )}
          <span className="flex-1 truncate font-mono text-[11px]">{title}</span>
          {thread.status === 'running' && (
            <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-iron/60" />
          )}
          <button
            type="button"
            className="flex-none rounded px-1 py-0.5 text-[10px] text-iron/50 opacity-0 transition-opacity hover:bg-red-900/20 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            aria-label="Delete thread"
          >
            ✕
          </button>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live assistant bubble (streaming)
// ---------------------------------------------------------------------------

interface LiveAssistantBubbleProps {
  text: string
  thinking: string | null
  currentTool: string | null
  toolCount: number
  error: string | null
  done: boolean
}

/**
 * Renders the in-progress assistant response while the daemon is streaming.
 * Shows: activity header with tool info, thinking block, streaming text with
 * blinking cursor, and an error banner when the run errored.
 */
const LiveAssistantBubble = ({
  text,
  thinking,
  currentTool,
  toolCount,
  error,
  done,
}: LiveAssistantBubbleProps) => (
  <div className="flex justify-start px-4 py-1">
    <div className="flex-1 text-[13px]">
      {/* Activity header — shows when a tool is running or the run started */}
      {currentTool ? (
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-amber-400" />
          <span className="font-mono text-[11px] text-iron/70">
            Running {currentTool} · {toolCount} tool{toolCount !== 1 ? 's' : ''}
          </span>
        </div>
      ) : !text && !thinking && !error ? (
        <div className="mb-2 flex items-center gap-2">
          {/* Three staggered bouncing dots — livelier than a single static pulse */}
          <span className="flex items-center gap-[3px]">
            <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-iron/50 [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-iron/50 [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-iron/50 [animation-delay:300ms]" />
          </span>
          <span className="font-mono text-[11px] text-iron/50">Thinking…</span>
        </div>
      ) : null}

      {/* Streaming thinking block */}
      {thinking && <ThinkingBlock text={thinking} />}

      {/* Streaming text with blinking cursor */}
      {text && (
        <div className="chat-markdown prose prose-sm prose-invert max-w-none">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          {!done && (
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-fg align-text-bottom"
            />
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mt-1 rounded border border-red-400/40 bg-red-900/10 px-3 py-2 font-mono text-[11px] text-red-400">
          ⚠ {error}
        </div>
      )}
    </div>
  </div>
)

// ---------------------------------------------------------------------------
// Message list
// ---------------------------------------------------------------------------

interface MessageListProps {
  threadId: string
  projectId?: string
  onDiscuss: (prompt: string) => void
}

const MessageList = ({ threadId, projectId, onDiscuss }: MessageListProps) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()

  const handleFeedbackChange = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
  }, [qc, threadId])

  const { data, isLoading } = useQuery({
    queryKey: ['chat-thread', threadId, projectId],
    queryFn: () => fetchChatThread(threadId, projectId),
    refetchInterval: (q) => {
      // Poll while running as a fallback if the SSE bridge is unavailable.
      const status = q.state.data?.thread.status
      return status === 'running' ? 2000 : false
    },
  })

  // Live buffer for this thread — non-null while the daemon is streaming.
  const liveBuffer = useLiveBuffer(threadId)

  // Snapshot the message count the moment the run finishes (`done` becomes
  // true). Used to detect when the subsequent refetch lands with the persisted
  // assistant message so we can clear the live buffer without a visible flash.
  const doneMessageCountRef = useRef<number | null>(null)

  useEffect(() => {
    const messageCount = data?.messages.length ?? 0

    if (!liveBuffer?.done) {
      // Reset the snapshot whenever a fresh run starts.
      doneMessageCountRef.current = null
      return
    }

    if (doneMessageCountRef.current === null) {
      // First render after the run completes: snapshot the current count and
      // trigger a refetch. The live bubble remains visible (with no cursor)
      // until the persisted data arrives.
      doneMessageCountRef.current = messageCount
      void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
      return
    }

    // On subsequent renders: once the query refetch returns more messages
    // (i.e. the persisted assistant reply is now in the data), swap the live
    // bubble for the stable persisted view with no visual jump.
    if (messageCount > doneMessageCountRef.current) {
      clearLiveBuffer(threadId)
    }
  }, [liveBuffer?.done, data?.messages.length, threadId, qc])

  // Scroll to the bottom on new persisted messages or live text growth,
  // but only when the user is already near the bottom (scroll-pin behaviour).
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    // 120 px threshold: auto-scroll only when we were already at (or very near) the bottom.
    if (distanceFromBottom <= 120) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [data?.messages.length, liveBuffer?.text.length])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-iron/50 font-mono text-[11px]">
        Loading…
      </div>
    )
  }

  const messages = data?.messages ?? []
  // Show the live bubble until the buffer is cleared — including while
  // `liveBuffer.done` is true but the persisted message hasn't loaded yet.
  // This prevents a flicker where the bubble disappears before the persisted
  // reply takes its place.
  const showLive = liveBuffer !== null

  if (messages.length === 0 && !showLive) {
    return null
  }

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto py-3">
      {messages.map((msg) => (
        <ChatMessageBubble key={msg.id} msg={msg} onDiscuss={onDiscuss} onFeedbackChange={handleFeedbackChange} />
      ))}
      {showLive && (
        <LiveAssistantBubble
          text={liveBuffer.text}
          thinking={liveBuffer.thinking}
          currentTool={liveBuffer.currentTool}
          toolCount={liveBuffer.toolCount}
          error={liveBuffer.error}
          done={liveBuffer.done}
        />
      )}
      <div ref={bottomRef} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slash palette
// ---------------------------------------------------------------------------

interface SlashPaletteProps {
  filter: string
  onSelect: (prompt: string) => void
}

const SlashPalette = ({ filter, onSelect }: SlashPaletteProps) => {
  const lower = filter.toLowerCase()
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(lower))
  if (matches.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 mb-1 w-full rounded border border-iron/30 bg-bg shadow-lg">
      {matches.map(({ cmd, prompt }) => (
        <button
          key={cmd}
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px] text-iron hover:bg-iron/20 hover:text-fg"
          onMouseDown={(e) => {
            // Prevent textarea blur before click fires.
            e.preventDefault()
            onSelect(prompt)
          }}
        >
          <span className="text-fg">{cmd}</span>
          <span className="truncate text-iron/50">{prompt}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Welcome state (no messages yet in the selected thread)
// ---------------------------------------------------------------------------

interface WelcomeStateProps {
  onChipClick: (prompt: string) => void
}

const WelcomeState = ({ onChipClick }: WelcomeStateProps) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
    <p className="font-mono text-[13px] text-iron/60">
      What would you like to do?
    </p>
    <div className="flex flex-wrap justify-center gap-2">
      {WELCOME_CHIPS.map(({ label, prompt }) => (
        <button
          key={label}
          type="button"
          className="rounded border border-iron/40 px-3 py-1.5 font-mono text-[11px] text-iron transition-colors hover:border-iron/70 hover:bg-iron/20 hover:text-fg active:scale-[0.97]"
          onClick={() => onChipClick(prompt)}
        >
          {label}
        </button>
      ))}
    </div>
  </div>
)

// ---------------------------------------------------------------------------
// Send-error message helper
// ---------------------------------------------------------------------------

/**
 * Maps a thrown error to a user-facing string distinguishing daemon-down from
 * generic failures. Used by both the hero `createAndSend` mutation and the
 * regular `Composer` own send mutation.
 */
function sendErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === 'unreachable') return 'Daemon not running — start it with `mars daemon start`.'
    if (err.kind === 'stale-daemon') return 'Daemon error — try restarting with `mars daemon restart`.'
  }
  return 'Message could not be sent — please try again.'
}

// ---------------------------------------------------------------------------
// Hero composer (used in the no-thread hero state)
// ---------------------------------------------------------------------------

interface HeroComposerProps {
  onSend: (text: string, clearText: () => void) => void
  isPending: boolean
  prefill?: string
  onPrefillConsumed: () => void
}

const HeroComposer = ({ onSend, isPending, prefill, onPrefillConsumed }: HeroComposerProps) => {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (prefill !== undefined) {
      setText(prefill)
      onPrefillConsumed()
      textareaRef.current?.focus()
    }
  }, [prefill, onPrefillConsumed])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isPending) return
    onSend(trimmed, () => setText(''))
  }, [text, isPending, onSend])

  return (
    <div className="relative w-full max-w-2xl">
      <textarea
        ref={textareaRef}
        data-testid="hero-composer"
        className="w-full resize-none rounded-2xl border border-iron/30 bg-surface px-5 py-4 pr-20 font-mono text-[14px] text-fg placeholder:text-iron/40 focus:border-iron/60 focus:outline-none disabled:opacity-50"
        placeholder={isPending ? 'Creating thread…' : 'Message mars… (Enter to send, Shift+Enter for newline)'}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
          }
        }}
        disabled={isPending}
      />
      <button
        type="button"
        data-testid="hero-send"
        className="absolute bottom-3 right-3 rounded-xl border border-iron/40 px-4 py-2 font-mono text-[11px] text-iron transition-colors hover:bg-iron/20 hover:text-fg active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
        onClick={handleSend}
        disabled={isPending || text.trim().length === 0}
      >
        {isPending ? '…' : 'Send'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hero empty state (shown when no thread is selected)
// ---------------------------------------------------------------------------

export interface HeroEmptyStateProps {
  projectId?: string
  onSelectThread: (id: string) => void
  onCreateAndSend: (message: string, clearText: () => void) => void
  isPending: boolean
  /** Non-null when the last send attempt failed; renders an error banner. */
  sendError?: string | null
  /** Opens the projection Thread for an action-queue item id in the sidebar/detail. */
  onOpenQueueItem?: (id: string) => void
}

/**
 * Full-pane hero shown when no thread is selected.
 *
 * Layout: headline → subtitle → large rounded composer → suggestion row.
 * The suggestion row shows the top open action-queue alert first (if any),
 * then the standard quick-action chips. Typing in the composer and hitting
 * Enter (or clicking Send) creates a new thread and posts the first message
 * in one gesture via the `onCreateAndSend` callback.
 */
export const HeroEmptyState = ({
  projectId,
  onSelectThread,
  onCreateAndSend,
  isPending,
  sendError,
  onOpenQueueItem,
}: HeroEmptyStateProps) => {
  const [prefill, setPrefill] = useState<string | undefined>(undefined)

  const { data: alertItems } = useQuery({
    queryKey: ['action-queue', projectId],
    queryFn: () => fetchActionQueue(projectId),
    staleTime: 15_000,
  })

  const { data: threads } = useQuery({
    queryKey: ['chat-threads', projectId],
    queryFn: () => fetchChatThreads(projectId),
    staleTime: 15_000,
  })

  const topAlert = pickTopAlert(alertItems ?? [])
  const alertThread = topAlert
    ? (threads ?? []).find((t) => t.alertItemId === topAlert.id) ?? null
    : null

  const handleAlertClick = useCallback(() => {
    if (alertThread) {
      onSelectThread(alertThread.id)
    } else if (topAlert) {
      onOpenQueueItem?.(topAlert.id)
    }
  }, [alertThread, topAlert, onSelectThread, onOpenQueueItem])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
      <WhileYouWereAwayPanel projectId={projectId ?? null} />
      <div className="text-center">
        <h1
          className="font-mono text-[28px] font-bold text-fg"
          data-testid="hero-headline"
        >
          What should Mars build?
        </h1>
        <p className="mt-2 font-mono text-[13px] text-iron/60">
          Start a conversation or pick a suggestion below.
        </p>
      </div>
      <HeroComposer
        onSend={onCreateAndSend}
        isPending={isPending}
        prefill={prefill}
        onPrefillConsumed={() => setPrefill(undefined)}
      />
      {sendError && (
        <p
          role="alert"
          data-testid="hero-send-error"
          className="font-mono text-[11px] text-red-400"
        >
          {sendError}
        </p>
      )}
      <HeroSuggestions
        topAlert={topAlert}
        onAlertClick={handleAlertClick}
        onChipClick={setPrefill}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  threadId: string
  projectId?: string
  /** Whether the thread is running (disables send). */
  disabled: boolean
  /** Called with the prefill text when a chip or slash command is selected. */
  initialText?: string
  onInitialTextConsumed: () => void
  /**
   * When set, sending routes here instead of posting to `threadId` — used on
   * projection Threads, where the first message creates the conversation.
   * Receives a `clearText` callback the caller should invoke on success so the
   * composer only clears when the send actually succeeded.
   */
  onSendOverride?: (msg: string, clearText: () => void) => void
  /** In-flight state for the override send (create-thread + first message). */
  sendPending?: boolean
  /** External error from an override-send failure; shown inline below the textarea. */
  sendError?: string | null
}

const Composer = ({
  threadId,
  projectId,
  disabled,
  initialText,
  onInitialTextConsumed,
  onSendOverride,
  sendPending = false,
  sendError,
}: ComposerProps) => {
  const [text, setText] = useState('')
  const [showPalette, setShowPalette] = useState(false)
  const [localSendError, setLocalSendError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const qc = useQueryClient()

  // Apply chip / slash-command prefill from welcome state.
  useEffect(() => {
    if (initialText !== undefined) {
      setText(initialText)
      onInitialTextConsumed()
      textareaRef.current?.focus()
    }
  }, [initialText, onInitialTextConsumed])

  const { mutate: send, isPending } = useMutation({
    mutationFn: (msg: string) => postChatMessage(threadId, msg, projectId),
    onMutate: () => setLocalSendError(null),
    onSuccess: () => {
      setText('')
      void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
    },
    onError: (err) => setLocalSendError(sendErrorMessage(err)),
  })

  const { mutate: stop, isPending: isStopping } = useMutation({
    mutationFn: () => stopChatThread(threadId, projectId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
    },
  })

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled || isPending || sendPending) return
    setShowPalette(false)
    setLocalSendError(null)
    if (onSendOverride) {
      onSendOverride(trimmed, () => setText(''))
    } else {
      send(trimmed)
      // setText('') is handled inside send.onSuccess so text survives failure
    }
  }, [text, disabled, isPending, sendPending, onSendOverride, send])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    // Show palette when the input starts with '/' and has no space yet
    const trimmed = value.trimStart()
    setShowPalette(trimmed.startsWith('/') && !trimmed.includes(' '))
  }

  const handleSlashSelect = (prompt: string) => {
    setText(prompt)
    setShowPalette(false)
    textareaRef.current?.focus()
  }

  const isDisabled = disabled || isPending || sendPending

  return (
    <div className="relative border-t border-iron/30 px-4 py-3">
      {showPalette && (
        <SlashPalette
          filter={text.trimStart()}
          onSelect={handleSlashSelect}
        />
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded border border-iron/30 bg-surface px-3 py-2 font-mono text-[12px] text-fg placeholder:text-iron/40 focus:border-iron/60 focus:outline-none disabled:opacity-50"
          placeholder={isDisabled ? 'Running…' : 'Message mars… (Enter to send, Shift+Enter for newline)'}
          rows={3}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            const trimmed = text.trimStart()
            setShowPalette(trimmed.startsWith('/') && !trimmed.includes(' '))
          }}
          onBlur={() => setTimeout(() => setShowPalette(false), 150)}
          disabled={isDisabled}
        />
        {/* Show Stop when thread is running; Send otherwise. */}
        {disabled && !isPending ? (
          <button
            type="button"
            className="flex-none rounded border border-red-400/40 px-3 py-2 font-mono text-[11px] text-red-400 transition-colors hover:bg-red-900/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => stop()}
            disabled={isStopping}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="flex-none rounded border border-iron/40 px-3 py-2 font-mono text-[11px] text-iron transition-colors hover:bg-iron/20 hover:text-fg active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={handleSend}
            disabled={isDisabled || text.trim().length === 0}
          >
            Send
          </button>
        )}
      </div>
      {(sendError || localSendError) && (
        <p
          role="alert"
          data-testid="composer-send-error"
          className="mt-1 font-mono text-[10px] text-red-400"
        >
          {sendError ?? localSendError}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread sidebar
// ---------------------------------------------------------------------------

/** History pagination state passed down from the ChatPage root. */
interface SidebarHistory {
  items: ActionQueueItem[]
  nextCursor: string | null
  isLoadingMore: boolean
  loadMore: () => void
}

const EMPTY_HISTORY: SidebarHistory = {
  items: [],
  nextCursor: null,
  isLoadingMore: false,
  loadMore: () => {},
}

interface ThreadSidebarProps {
  selectedId: string | null
  projectId?: string
  onSelect: (id: string) => void
  /** Selected projection Thread (action-queue item id), if any. */
  selectedQueueItemId?: string | null
  onSelectQueueItem?: (id: string) => void
  /** Open action-queue rows rendered as projection Threads. */
  queueItems?: ActionQueueItem[]
  /** Resolved-rows archive for the History accordion. */
  history?: SidebarHistory
  query?: string
  onQueryChange?: (q: string) => void
  kindFilter?: KindFilter
  onKindFilterChange?: (k: KindFilter) => void
  /** Fires a Decision from the quick pills (optimistic removal + rollback upstream). */
  onQueueAction?: (action: ActionDescriptor, item: ActionQueueItem) => void
  /** First non-null error from the action-queue / projects queries. */
  queueError?: Error | null
  /** True when GET /api/projects succeeded but returned zero projects. */
  projectsEmpty?: boolean
}

/** How long a deleted thread stays undoable before the delete is sent. */
const DELETE_UNDO_WINDOW_MS = 5000

/** A delete that has been made on screen but not yet sent to the server. */
interface PendingThreadDelete {
  id: string
  title: string
  /** True when this thread was the open one, so Undo can re-open it. */
  wasSelected: boolean
}

/**
 * Toast state for the delete flow. `pending` counts down the undo window;
 * `error` reports a delete the server rejected (the row is already back).
 */
type DeleteToast =
  | { kind: 'pending'; title: string }
  | { kind: 'error'; message: string }

export const ThreadSidebar = ({
  selectedId,
  projectId,
  onSelect,
  selectedQueueItemId = null,
  onSelectQueueItem,
  queueItems = [],
  history = EMPTY_HISTORY,
  query = '',
  onQueryChange,
  kindFilter = 'all',
  onKindFilterChange,
  onQueueAction,
  queueError = null,
  projectsEmpty = false,
}: ThreadSidebarProps) => {
  const qc = useQueryClient()
  const [historyOpen, setHistoryOpen] = useState(false)

  const { data } = useQuery({
    queryKey: ['chat-threads', projectId],
    queryFn: () => fetchChatThreads(projectId),
  })

  const { mutate: create } = useMutation({
    mutationFn: () => createChatThread(projectId),
    onSuccess: (thread) => {
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
      onSelect(thread.id)
    },
  })

  const { mutate: rename } = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameChatThread(id, title, projectId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chat-threads'] }),
  })

  // Threads hidden on screen because a delete is pending. Filtering at render
  // time rather than editing the query cache keeps the row hidden even if an
  // unrelated SSE invalidation refetches the list mid-undo-window.
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [toast, setToast] = useState<DeleteToast | null>(null)
  const pendingRef = useRef<PendingThreadDelete | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const unhide = useCallback((id: string) => {
    setHiddenIds((prev) => prev.filter((x) => x !== id))
  }, [])

  /** Send the delete for real. The row is already hidden; reveal it again on failure. */
  const commitDelete = useCallback(
    (p: PendingThreadDelete) => {
      deleteChatThread(p.id, projectId)
        .then(() => {
          unhide(p.id)
          void qc.invalidateQueries({ queryKey: ['chat-threads'] })
        })
        .catch((err: unknown) => {
          unhide(p.id)
          if (p.wasSelected) onSelect(p.id)
          setToast({
            kind: 'error',
            message: `Could not delete “${p.title}”: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          })
        })
    },
    [projectId, qc, unhide, onSelect],
  )

  /** Fire any pending delete immediately, so a second delete never drops the first. */
  const flushPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const p = pendingRef.current
    pendingRef.current = null
    if (p !== null) commitDelete(p)
  }, [commitDelete])

  const startDelete = useCallback(
    (thread: ChatThread) => {
      flushPending()
      const p: PendingThreadDelete = {
        id: thread.id,
        title: thread.title || 'New thread',
        wasSelected: selectedId === thread.id,
      }
      setHiddenIds((prev) => [...prev, p.id])
      if (p.wasSelected) onSelect('')
      pendingRef.current = p
      setToast({ kind: 'pending', title: p.title })
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const current = pendingRef.current
        pendingRef.current = null
        setToast(null)
        if (current !== null) commitDelete(current)
      }, DELETE_UNDO_WINDOW_MS)
    },
    [flushPending, selectedId, onSelect, commitDelete],
  )

  const undoDelete = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const p = pendingRef.current
    pendingRef.current = null
    setToast(null)
    if (p === null) return
    unhide(p.id)
    if (p.wasSelected) onSelect(p.id)
  }, [unhide, onSelect])

  // Commit anything still pending on unmount — navigating away is not an undo.
  // The ref reads are deliberate: this must run exactly once, at teardown.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const p = pendingRef.current
      pendingRef.current = null
      if (p !== null) void deleteChatThread(p.id, projectId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Visible chat threads (delete-pending rows stay hidden).
  const visibleThreads = (data ?? []).filter((t) => !hiddenIds.includes(t.id))

  // Merge live queue rows and chat threads: projection Threads float above
  // regular threads; alert-origin threads backed by a live row merge into a
  // single projection entry. Search / kind filter apply inside the merge.
  const { projections, regular } = mergeSidebarEntries(
    queueItems,
    visibleThreads,
    query,
    kindFilter,
  )

  // Alert-origin unresolved threads sort to the top of the regular list;
  // everything else retains server order (updated_at desc from the backend).
  const threads = [...regular].sort((a, b) => {
    const aAlert = a.origin === 'alert' && !a.alertResolved ? 0 : 1
    const bAlert = b.origin === 'alert' && !b.alertResolved ? 0 : 1
    return aAlert - bAlert
  })

  return (
    <aside className="flex w-64 flex-shrink-0 flex-col border-r border-iron/30 bg-bg">
      <div className="border-b border-iron/30 px-2 py-2">
        <button
          type="button"
          className="w-full rounded border border-iron/30 px-2 py-1 font-mono text-[11px] text-iron hover:bg-iron/20 hover:text-fg"
          onClick={() => create()}
        >
          + New thread
        </button>
        <div
          role="group"
          aria-label="Filter action queue by kind"
          className="mt-2 flex border border-iron/30"
        >
          {(['all', 'alerts', 'drafts'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={kindFilter === f}
              data-testid={`action-queue-filter-${f}`}
              onClick={() => onKindFilterChange?.(f)}
              className={[
                'flex-1 border-r border-iron/30 px-2 py-0.5 font-mono text-[10px] last:border-r-0 focus:outline-none focus:ring-1 focus:ring-iron/50',
                kindFilter === f ? 'bg-iron/20 text-fg' : 'bg-bg text-iron',
              ].join(' ')}
            >
              {f === 'all' ? 'All' : f === 'alerts' ? 'Alerts' : 'Drafts'}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder="Search…"
          aria-label="Search threads and action queue"
          data-testid="action-queue-search"
          className="mt-2 w-full border border-iron/30 bg-bg px-2 py-1 font-mono text-[12px] text-fg placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-iron/50"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-0.5">
        {/* Projection Threads — open queue rows; no delete affordance, they
            evaporate only when the backing row leaves the queue. */}
        {projections.map(({ item, thread }) => (
          <QueueThreadRow
            key={item.id}
            item={item}
            hasConversation={thread !== null}
            active={
              thread !== null
                ? thread.id === selectedId
                : item.id === selectedQueueItemId
            }
            onSelect={() => {
              if (thread !== null) onSelect(thread.id)
              else onSelectQueueItem?.(item.id)
            }}
            onRestart={
              item.actions.some((a) => a.op === 'restart')
                ? () => {
                    const restart = item.actions.find((a) => a.op === 'restart')
                    if (restart) onQueueAction?.(restart, item)
                  }
                : null
            }
            restartPending={false}
            restartError={null}
            onAction={(action, actionItem) => onQueueAction?.(action, actionItem)}
          />
        ))}
        {/* Queue status surfaces — errors and empty-registry guidance, kept in
            the sidebar where the projection Threads live. */}
        {queueError ? (
          <FallbackSurface error={queueError} of="action queue" variant="pane" />
        ) : projectsEmpty && queueItems.length === 0 ? (
          <div
            className="px-2 py-3 font-mono text-[11px] text-iron"
            data-testid="no-projects-registered"
          >
            <p className="text-fg">No projects registered.</p>
            <p className="mt-1">
              Run <code className="rounded bg-iron/20 px-1">mars init</code> inside
              your repo — it registers the project automatically.
            </p>
            <p className="mt-1 text-muted">
              Or register an existing repo:{' '}
              <code className="rounded bg-iron/20 px-1">mars project add &lt;repo&gt;</code>
            </p>
          </div>
        ) : queueItems.length === 0 && !query.trim() ? (
          <p className="px-2 py-1 font-mono text-[10px] text-iron/40">No items.</p>
        ) : null}
        {threads.length === 0 && projections.length === 0 && (
          <p className="px-2 py-3 font-mono text-[10px] text-iron/40">
            {query.trim() ? 'No matches' : 'No threads yet'}
          </p>
        )}
        {threads.map((t) => (
          <ThreadItem
            key={t.id}
            thread={t}
            isSelected={t.id === selectedId}
            onSelect={() => onSelect(t.id)}
            onRename={(title) => rename({ id: t.id, title })}
            onDelete={() => startDelete(t)}
          />
        ))}
      </div>

      {/* History accordion — the resolved-rows archive, collapsed by default. */}
      <div data-testid="history-accordion">
        <button
          type="button"
          aria-expanded={historyOpen}
          aria-controls="section-body-history"
          onClick={() => setHistoryOpen((v) => !v)}
          className="flex w-full items-center justify-between border-t border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted hover:bg-iron/5"
        >
          <span>{historyLabel(history.items.length, history.nextCursor !== null)}</span>
          <span aria-hidden="true">{historyOpen ? '▾' : '▸'}</span>
        </button>
        {historyOpen && (
          <div id="section-body-history" className="max-h-56 overflow-y-auto">
            {history.items.length === 0 ? (
              <p className="px-3 py-2 font-mono text-[11px] text-muted">
                No resolved items.
              </p>
            ) : (
              history.items.map((item) => (
                <div
                  key={item.id}
                  data-testid="history-row"
                  role="button"
                  tabIndex={0}
                  aria-current={item.id === selectedQueueItemId ? 'true' : undefined}
                  className={[
                    'cursor-pointer px-3 py-2 transition-colors',
                    item.id === selectedQueueItemId ? 'bg-iron/20' : 'hover:bg-iron/10',
                  ].join(' ')}
                  onClick={() => onSelectQueueItem?.(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectQueueItem?.(item.id)
                    }
                  }}
                >
                  <div className="flex items-baseline gap-2">
                    {item.kind !== 'failed-task' && (
                      <span className="shrink-0 font-mono text-[9px] uppercase text-muted">
                        {kindBadgeLabel(item.kind)}
                      </span>
                    )}
                    <span className="break-all font-mono text-[10px] text-muted">
                      {item.entityId}
                    </span>
                  </div>
                  <div className="mt-0.5 break-words font-mono text-[11px] text-muted">
                    {(item.resolution?.resolution ?? item.title) || '(no title)'}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted">
                    {item.resolution
                      ? relativeTime(item.resolution.resolvedAt)
                      : relativeTime(item.at)}
                  </div>
                </div>
              ))
            )}
            {history.nextCursor !== null ? (
              <button
                type="button"
                data-testid="history-load-more"
                disabled={history.isLoadingMore}
                onClick={history.loadMore}
                className="w-full border-t border-iron/20 px-3 py-1.5 font-mono text-[10px] uppercase text-muted hover:bg-iron/5 disabled:opacity-50"
              >
                {history.isLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* Delete toast — the row is already gone on screen; the request is not sent
          until the undo window closes. Fixed so it never shifts the sidebar. */}
      {toast !== null && (
        <div
          data-testid="thread-delete-undo-toast"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 border border-iron/40 bg-bg px-4 py-2 font-mono text-[11px] text-fg shadow-lg"
        >
          {toast.kind === 'pending' ? (
            <>
              <span className="max-w-[280px] truncate">Deleted “{toast.title}”</span>
              <button
                type="button"
                onClick={undoDelete}
                className="border border-iron/40 px-2 py-0.5 font-mono text-[10px] uppercase text-iron transition hover:bg-iron/10 active:scale-[0.97]"
              >
                Undo
              </button>
            </>
          ) : (
            <>
              <span className="max-w-[360px] text-red-400">{toast.message}</span>
              <button
                type="button"
                onClick={() => setToast(null)}
                aria-label="Dismiss"
                className="border border-iron/40 px-2 py-0.5 font-mono text-[10px] uppercase text-iron transition hover:bg-iron/10 active:scale-[0.97]"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// ChatPage root
// ---------------------------------------------------------------------------

export const ChatPage = () => {
  const rawProjectId = useFocusedProjectId()
  const projectId = rawProjectId ?? undefined
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readAqStateFromUrl().thread)
  // Projection-Thread selection (an action-queue item id) plus the sidebar
  // filter state — all three restore from the chat URL hash on F5.
  const [selectedQueueItemId, setSelectedQueueItemId] = useState<string | null>(
    () => readAqStateFromUrl().item,
  )
  const [query, setQuery] = useState<string>(() => readAqStateFromUrl().q)
  const [kindFilter, setKindFilter] = useState<KindFilter>(() => readAqStateFromUrl().kind)
  const [prefill, setPrefill] = useState<string | undefined>(undefined)

  // ---------------------------------------------------------------------------
  // Responsive breakpoints
  // ---------------------------------------------------------------------------
  // Rail: auto-expand at xl (1280 px+). Below 1024 px the three-column layout
  // is too cramped; using the xl threshold means the rail collapses at both
  // 768 px and 1024 px (matching the verify spec) and only opens at 1280 px+.
  const isXlScreen = useMediaQuery('(min-width: 1280px)')
  // Sidebar: hide below 769 px (standard md breakpoint boundary) and replace
  // with a hamburger/sheet toggle.
  const isMdScreen = useMediaQuery('(min-width: 769px)')

  // Rail collapse: viewport drives the default; the toggle provides a per-
  // session override that resets whenever the viewport crosses the xl boundary.
  const [railCollapsed, setRailCollapsed] = useState(!isXlScreen)
  useEffect(() => {
    setRailCollapsed(!isXlScreen)
  }, [isXlScreen])

  // Mobile sidebar sheet
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Auto-close the overlay when the viewport expands to md+
  useEffect(() => {
    if (isMdScreen) setSidebarOpen(false)
  }, [isMdScreen])

  // Capture the epoch ms when this ChatPage first mounts so the ContextRail
  // can highlight tasks that appeared during this session.
  const sessionStartedAt = useRef(Date.now()).current
  const qc = useQueryClient()

  // Live queue rows + resolved-rows archive for the sidebar and detail pane.
  const {
    items: queueItems,
    error: queueError,
    projectsError,
    projectsEmpty,
  } = useActionQueue()
  const {
    items: historyItems,
    nextCursor: historyNextCursor,
    isLoadingMore: historyLoadingMore,
    loadMore: loadMoreHistory,
  } = useActionQueueHistory()

  // Threads at the root so a deep-linked queue item can resolve to its merged
  // alert-origin conversation. React Query dedupes this against the sidebar's
  // identical query — no extra request.
  const { data: threadsData } = useQuery({
    queryKey: ['chat-threads', projectId],
    queryFn: () => fetchChatThreads(projectId),
  })

  // Debounced URL write-back — mirrors selection, kind filter, and search so
  // F5 restores the exact view. Uses replaceState (no hashchange event) to
  // avoid disturbing the app-level hash router.
  const urlWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (urlWriteTimerRef.current !== null) clearTimeout(urlWriteTimerRef.current)
    urlWriteTimerRef.current = setTimeout(() => {
      writeAqStateToUrl({ item: selectedQueueItemId, kind: kindFilter, q: query, thread: selectedThreadId })
    }, 300)
    return () => {
      if (urlWriteTimerRef.current !== null) clearTimeout(urlWriteTimerRef.current)
    }
  }, [selectedQueueItemId, kindFilter, query, selectedThreadId])

  // Selection is exclusive: a conversation or a projection Thread, never both.
  const handleSelectThread = useCallback((id: string) => {
    setSelectedThreadId(id || null)
    setSelectedQueueItemId(null)
  }, [])

  const handleSelectQueueItem = useCallback((id: string) => {
    setSelectedQueueItemId(id)
    setSelectedThreadId(null)
  }, [])

  // Deep link: when the selected queue item is backed by an alert-origin
  // conversation, open the conversation instead (the merged sidebar entry).
  useEffect(() => {
    if (selectedQueueItemId === null) return
    const thread = (threadsData ?? []).find(
      (t) => t.origin === 'alert' && t.alertItemId === selectedQueueItemId,
    )
    if (thread) {
      setSelectedThreadId(thread.id)
      setSelectedQueueItemId(null)
    }
  }, [selectedQueueItemId, threadsData])

  /**
   * Fires a Decision from the sidebar quick pills: optimistic removal of the
   * row from the cache, rollback on error, reconcile on settle — the inline
   * resolver semantics (no two-step confirm; the detail ActionBar covers that).
   */
  const handleQueueAction = useCallback(
    async (action: ActionDescriptor, actionItem: ActionQueueItem) => {
      await qc.cancelQueries({ queryKey: ['action-queue'] })
      const snapshot = qc.getQueryData<ActionQueueItem[]>(['action-queue', rawProjectId])
      if (snapshot) {
        qc.setQueryData(
          ['action-queue', rawProjectId],
          snapshot.filter((i) => i.id !== actionItem.id),
        )
      }
      try {
        const entityId = PROCESS_LEVEL_OPS.has(action.op) ? undefined : actionItem.entityId
        await invokeAction(action.op, entityId)
      } catch {
        if (snapshot) {
          qc.setQueryData(['action-queue', rawProjectId], snapshot)
        }
      } finally {
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
        void qc.invalidateQueries({ queryKey: ['progress'] })
      }
    },
    [qc, rawProjectId],
  )

  // Create a new thread and post the first message in one gesture — used by
  // the hero composer so the user never has to click "+ New thread" separately.
  const [sendError, setSendError] = useState<string | null>(null)
  const { mutate: createAndSend, isPending: isCreatingThread } = useMutation({
    mutationFn: async (message: string) => {
      const thread = await createChatThread(projectId)
      await postChatMessage(thread.id, message, projectId)
      return thread
    },
    onMutate: () => setSendError(null),
    onSuccess: (thread) => {
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
      void qc.invalidateQueries({ queryKey: ['chat-thread', thread.id] })
      setSelectedThreadId(thread.id)
      setSelectedQueueItemId(null)
    },
    onError: (err) => setSendError(sendErrorMessage(err)),
  })

  const { data: threadDetail } = useQuery({
    queryKey: ['chat-thread', selectedThreadId, projectId],
    queryFn: () => fetchChatThread(selectedThreadId!, projectId),
    enabled: selectedThreadId !== null,
    refetchInterval: (q) => {
      const status = q.state.data?.thread.status
      return status === 'running' ? 2000 : false
    },
  })

  // Subscribe to live buffer so welcome state hides as soon as streaming starts.
  const liveBufferForThread = useLiveBuffer(selectedThreadId ?? '')

  const isRunning = threadDetail?.thread.status === 'running'
  const hasMessages =
    (threadDetail?.messages.length ?? 0) > 0 || liveBufferForThread !== null

  const handleChipClick = useCallback((prompt: string) => {
    setPrefill(prompt)
  }, [])

  const handleInsertPrompt = useCallback((prompt: string) => {
    setPrefill(prompt)
  }, [])

  // Resolve the selected projection Thread against live rows first, then the
  // history archive (a resolved history row renders its Resolution block).
  const selectedQueueItem = useMemo(() => {
    if (selectedQueueItemId === null) return null
    return (
      queueItems.find((i) => i.id === selectedQueueItemId) ??
      historyItems.find((i) => i.id === selectedQueueItemId) ??
      null
    )
  }, [selectedQueueItemId, queueItems, historyItems])

  // "Resolved" when the pinned row vanished from the live queue (and isn't a
  // history selection) — the projection evaporated via entity mutation.
  const queueSelectionResolved =
    selectedQueueItem === null && isResolvedSelection(selectedQueueItemId, queueItems)

  return (
    <div className="flex h-full overflow-hidden">
      {/* Thread sidebar — in-flow on md+, hidden on mobile with overlay sheet */}
      {isMdScreen && (
        <ThreadSidebar
          selectedId={selectedThreadId}
          projectId={projectId}
          onSelect={handleSelectThread}
          selectedQueueItemId={selectedQueueItemId}
          onSelectQueueItem={handleSelectQueueItem}
          queueItems={queueItems}
          history={{
            items: historyItems,
            nextCursor: historyNextCursor,
            isLoadingMore: historyLoadingMore,
            loadMore: loadMoreHistory,
          }}
          query={query}
          onQueryChange={setQuery}
          kindFilter={kindFilter}
          onKindFilterChange={setKindFilter}
          onQueueAction={handleQueueAction}
          queueError={queueError ?? projectsError}
          projectsEmpty={projectsEmpty}
        />
      )}

      {/* Mobile sidebar overlay — backdrop + sliding sheet */}
      {!isMdScreen && sidebarOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          {/* Sheet */}
          <div className="fixed inset-y-0 left-0 z-50 flex flex-col shadow-xl">
            <ThreadSidebar
              selectedId={selectedThreadId}
              projectId={projectId}
              onSelect={(id) => {
                handleSelectThread(id)
                setSidebarOpen(false)
              }}
              selectedQueueItemId={selectedQueueItemId}
              onSelectQueueItem={(id) => {
                handleSelectQueueItem(id)
                setSidebarOpen(false)
              }}
              queueItems={queueItems}
              history={{
                items: historyItems,
                nextCursor: historyNextCursor,
                isLoadingMore: historyLoadingMore,
                loadMore: loadMoreHistory,
              }}
              query={query}
              onQueryChange={setQuery}
              kindFilter={kindFilter}
              onKindFilterChange={setKindFilter}
              onQueueAction={handleQueueAction}
              queueError={queueError ?? projectsError}
              projectsEmpty={projectsEmpty}
            />
          </div>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar — hamburger button */}
        {!isMdScreen && (
          <div className="flex items-center border-b border-iron/30 px-3 py-2">
            <button
              type="button"
              aria-label="Open sidebar"
              onClick={() => setSidebarOpen(true)}
              className="mr-3 font-mono text-[16px] text-iron hover:text-fg"
            >
              ☰
            </button>
          </div>
        )}
        {selectedThreadId ? (
          <>
            {hasMessages ? (
              <MessageList
                threadId={selectedThreadId}
                projectId={projectId}
                onDiscuss={(prompt) => setPrefill(prompt)}
              />
            ) : (
              <WelcomeState onChipClick={handleChipClick} />
            )}
            <Composer
              threadId={selectedThreadId}
              projectId={projectId}
              disabled={isRunning}
              initialText={prefill}
              onInitialTextConsumed={() => setPrefill(undefined)}
            />
          </>
        ) : queueSelectionResolved ? (
          <div
            data-testid="resolved-pane"
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <p className="font-mono text-[13px] text-fg">This item has been resolved.</p>
            <p className="font-mono text-[11px] text-iron">
              It was removed from the action queue.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                className="border border-iron/40 px-3 py-1 font-mono text-[11px] text-iron hover:bg-iron/10"
                onClick={() => {
                  const id = selectedQueueItemId!
                  window.location.hash = taskHash(
                    id.includes(':') ? id.split(':').slice(1).join(':') : id,
                    'chat',
                  )
                }}
              >
                View task →
              </button>
              <button
                type="button"
                className="border border-iron/40 px-3 py-1 font-mono text-[11px] text-iron hover:bg-iron/10"
                onClick={() => setSelectedQueueItemId(null)}
              >
                ← Back to chat
              </button>
            </div>
          </div>
        ) : selectedQueueItem ? (
          <>
            <div className="min-h-0 flex-1 overflow-hidden">
              <QueueThreadDetail
                key={selectedQueueItem.id}
                item={selectedQueueItem}
                onNavigateToTask={(taskId: string) => {
                  const found = queueItems.find((i) => i.entityId === taskId)
                  if (found) {
                    setSelectedQueueItemId(found.id)
                  } else {
                    window.location.hash = taskHash(taskId, 'chat')
                  }
                }}
              />
            </div>
            {/* Composer — start the conversation on this projection Thread.
                Sending creates the thread and posts the first message. */}
            {selectedQueueItem.resolution == null && (
              <Composer
                threadId=""
                projectId={projectId}
                disabled={false}
                initialText={prefill}
                onInitialTextConsumed={() => setPrefill(undefined)}
                onSendOverride={(msg, clearText) => createAndSend(msg, { onSuccess: () => clearText() })}
                sendPending={isCreatingThread}
                sendError={sendError}
              />
            )}
          </>
        ) : (
          <HeroEmptyState
            projectId={projectId}
            onSelectThread={handleSelectThread}
            onCreateAndSend={(msg, clearText) => createAndSend(msg, { onSuccess: () => clearText() })}
            isPending={isCreatingThread}
            sendError={sendError}
            onOpenQueueItem={handleSelectQueueItem}
          />
        )}
      </div>

      <ContextRail
        projectId={projectId}
        sessionStartedAt={sessionStartedAt}
        onInsertPrompt={handleInsertPrompt}
        collapsed={railCollapsed}
        onToggleCollapse={() => setRailCollapsed((v) => !v)}
      />
    </div>
  )
}
