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

import { useState, useRef, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { ChatThread, ChatMessage, ChatSegmentToolUse, ChatSegmentAlert, ChatSegmentResult, ActionQueueItem, ChatFeedback } from '@/shared/schemas'
import { ContextRail } from '@/widgets/chat/ContextRail'
import { useLiveBuffer, clearLiveBuffer } from '@/shared/chatBuffer'
import { formatDuration } from '@/shared/time'

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

/**
 * Rich card rendered for `alert` segments in proactive alert-origin threads.
 * Displays the alert title, whyNow explanation, action verb buttons, and a
 * "Discuss" button that lets the user type a follow-up into the thread.
 */
const AlertCard = ({
  alert,
  onDiscuss,
}: {
  alert: ChatSegmentAlert
  onDiscuss: (prompt: string) => void
}) => {
  const isResolved = alert.resolved ?? false
  const [pendingOp, setPendingOp] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const buttonClass = (style: 'primary' | 'destructive' | 'default') => {
    const base = 'rounded px-3 py-1 font-mono text-[11px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
    if (style === 'primary') return `${base} border-accent/60 bg-accent/20 text-accent hover:bg-accent/30`
    if (style === 'destructive') return `${base} border-red-400/40 bg-red-900/10 text-red-400 hover:bg-red-900/20`
    return `${base} border-iron/30 text-iron hover:bg-iron/20`
  }

  const handleAction = async (op: string) => {
    if (pendingOp) return
    setPendingOp(op)
    setActionError(null)
    try {
      await invokeAction(op, alert.entityId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingOp(null)
    }
  }

  const handleDiscuss = () => {
    onDiscuss(`Help me resolve this: ${alert.title} (${alert.entityId})`)
  }

  return (
    <div
      className={[
        'my-2 rounded-lg border p-3 text-[12px]',
        isResolved
          ? 'border-iron/20 bg-surface opacity-60'
          : 'border-accent/30 bg-accent/5',
      ].join(' ')}
    >
      {/* Header */}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[13px]">🔔</span>
        <span className="font-mono text-[11px] font-semibold text-fg">{alert.title}</span>
        {isResolved && (
          <span className="ml-auto rounded bg-iron/20 px-1.5 py-0.5 font-mono text-[10px] text-iron/60">
            Resolved
          </span>
        )}
      </div>

      {/* Entity id — monospace link label */}
      <p className="mb-1 font-mono text-[10px] text-iron/50 truncate">{alert.entityId}</p>

      {/* Why now */}
      <p className="mb-2 font-mono text-[11px] text-iron leading-relaxed">{alert.whyNow}</p>

      {/* Action buttons */}
      {!isResolved && alert.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {alert.actions.map((action) => (
            <button
              key={action.op}
              type="button"
              className={buttonClass(action.style)}
              title={action.op}
              disabled={pendingOp !== null}
              onClick={() => void handleAction(action.op)}
            >
              {pendingOp === action.op ? '…' : action.label}
            </button>
          ))}
        </div>
      )}

      {/* Action error */}
      {actionError && (
        <p className="mb-2 font-mono text-[10px] text-red-400">{actionError}</p>
      )}

      {/* Discuss button */}
      <button
        type="button"
        className="rounded border border-iron/30 px-2 py-0.5 font-mono text-[10px] text-iron hover:bg-iron/20"
        onClick={handleDiscuss}
      >
        Discuss…
      </button>
    </div>
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
              <AlertCard
                key={i}
                alert={seg.alert}
                onDiscuss={onDiscuss}
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
          <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-iron/50" />
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
// Hero composer (used in the no-thread hero state)
// ---------------------------------------------------------------------------

interface HeroComposerProps {
  onSend: (text: string) => void
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
    onSend(trimmed)
    setText('')
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
  onCreateAndSend: (message: string) => void
  isPending: boolean
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
    } else {
      window.location.hash = '#/action-queue'
    }
  }, [alertThread, onSelectThread])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
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
}

const Composer = ({
  threadId,
  projectId,
  disabled,
  initialText,
  onInitialTextConsumed,
}: ComposerProps) => {
  const [text, setText] = useState('')
  const [showPalette, setShowPalette] = useState(false)
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
    },
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
    if (!trimmed || disabled || isPending) return
    send(trimmed)
    setText('')
    setShowPalette(false)
  }, [text, disabled, isPending, send])

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

  const isDisabled = disabled || isPending

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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread sidebar
// ---------------------------------------------------------------------------

interface ThreadSidebarProps {
  selectedId: string | null
  projectId?: string
  onSelect: (id: string) => void
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

export const ThreadSidebar = ({ selectedId, projectId, onSelect }: ThreadSidebarProps) => {
  const qc = useQueryClient()

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

  // Alert-origin unresolved threads sort to the top; everything else retains
  // server order (already sorted by updated_at desc from the backend).
  const threads = (data ?? []).filter((t) => !hiddenIds.includes(t.id)).sort((a, b) => {
    const aAlert = a.origin === 'alert' && !a.alertResolved ? 0 : 1
    const bAlert = b.origin === 'alert' && !b.alertResolved ? 0 : 1
    return aAlert - bAlert
  })

  return (
    <aside className="flex w-52 flex-shrink-0 flex-col border-r border-iron/30 bg-bg">
      <div className="border-b border-iron/30 px-2 py-2">
        <button
          type="button"
          className="w-full rounded border border-iron/30 px-2 py-1 font-mono text-[11px] text-iron hover:bg-iron/20 hover:text-fg"
          onClick={() => create()}
        >
          + New thread
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-0.5">
        {threads.length === 0 && (
          <p className="px-2 py-3 font-mono text-[10px] text-iron/40">No threads yet</p>
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
  const projectId = useFocusedProjectId() ?? undefined
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<string | undefined>(undefined)
  const [railCollapsed, setRailCollapsed] = useState(false)
  // Capture the epoch ms when this ChatPage first mounts so the ContextRail
  // can highlight tasks that appeared during this session.
  const sessionStartedAt = useRef(Date.now()).current
  const qc = useQueryClient()

  // Create a new thread and post the first message in one gesture — used by
  // the hero composer so the user never has to click "+ New thread" separately.
  const { mutate: createAndSend, isPending: isCreatingThread } = useMutation({
    mutationFn: async (message: string) => {
      const thread = await createChatThread(projectId)
      await postChatMessage(thread.id, message, projectId)
      return thread
    },
    onSuccess: (thread) => {
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
      void qc.invalidateQueries({ queryKey: ['chat-thread', thread.id] })
      setSelectedThreadId(thread.id)
    },
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

  return (
    <div className="flex h-full overflow-hidden">
      <ThreadSidebar
        selectedId={selectedThreadId}
        projectId={projectId}
        onSelect={(id) => setSelectedThreadId(id || null)}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
        ) : (
          <HeroEmptyState
            projectId={projectId}
            onSelectThread={(id) => setSelectedThreadId(id)}
            onCreateAndSend={(msg) => createAndSend(msg)}
            isPending={isCreatingThread}
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
