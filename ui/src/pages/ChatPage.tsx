/**
 * ChatPage — default landing screen for mars.
 *
 * Layout: narrow threads sidebar (create, rename on double-click, delete with
 * confirm) + main area (`ConversationView` transcript + composer).
 *
 * Rendering runs on the Vercel AI SDK: `useChat` (via `useMarsChat`) is the
 * single source of the on-screen transcript. Persisted history is mapped in
 * through `chatMessageToUIMessage` and reconciled on refetch; the live reply
 * streams through `MarsChatTransport`. Each `UIMessage` is rendered by
 * `MessageView` via shadcn AI Elements:
 *   text       → Response (Streamdown)
 *   reasoning  → Reasoning / ReasoningTrigger / ReasoningContent
 *   tool-*     → Tool / ToolHeader / ToolContent / ToolInput / ToolOutput
 * plus Mars-only surfaces with no first-class AI-SDK part — alert cards,
 * attachments, the interrupted-response banner, and the usage footer.
 *
 * Welcome state (no messages): quick-action Suggestions + slash palette on `/`
 * in the composer as canned prompt prefills (not RPC calls).
 */

import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useQuery, useMutation } from '@tanstack/react-query'
import { isStaticToolUIPart, type ToolUIPart } from 'ai'
import { applyLiveEvent, emptyLiveBuffer, type LiveBuffer } from '@/shared/chatBuffer'
import {
  fetchChatThreads,
  fetchChatThread,
  createChatThread,
  postChatMessage,
  uploadAttachment,
  renameChatThread,
  deleteChatThread,
  setMessageFeedback,
  clearMessageFeedback,
  fetchChatHistory,
  fetchCodexAuthState,
  fetchProjectMeta,
  fetchSessionAdrs,
  refreshCodexAuth,
  ApiError,
  type AttachmentInfo,
} from '@/shared/api'
import { useFocusedProjectId, useFocusedProject } from '@/shared/useFocusedProject'
import type { ChatThread, ChatSegmentAlert, ChatSegmentAttachment, ActionQueueItem, ChatFeedback, ChatThreadDetail } from '@/shared/schemas'
import type { MarsUIMessage } from '@/shared/marsChatTransport'
import { useMarsChat } from '@/shared/useMarsChat'
import { chatMessageToUIMessage, transcriptSignature } from '@/shared/chatMessageMapping'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { Response } from '@/components/ai-elements/response'
import { Reasoning, ReasoningTrigger, ReasoningContent } from '@/components/ai-elements/reasoning'
import { ToolGroup, type ToolGroupEntryData } from '@/components/ai-elements/tool'
// Loader removed — ThinkingIndicator replaces it in ChatConversation
import { Suggestions, Suggestion } from '@/components/ai-elements/suggestion'
import {
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input'
import { PaperclipIcon, MicIcon, SquareIcon, XIcon, PauseIcon } from 'lucide-react'
import { AgentConfigPanel } from '@/widgets/chat/AgentConfigPanel'
import { AlertCard } from '@/widgets/chat/AlertCard'
import { ContextRail } from '@/widgets/chat/ContextRail'
import { ChatHero, type HeroDelta } from '@/widgets/chat/ChatHero'
import { priorityBadgeClass } from '@/widgets/chat/QueueThreadRow'
import { QueueThreadDetail } from '@/widgets/chat/QueueThreadDetail'
import {
  filterOpen,
  filterThreadsByTitle,
  isResolvedSelection,
  sortByUrgencyThenAge,
} from '@/widgets/chat/queueThreads'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useActionQueueHistory } from '@/entities/actionQueue/useActionQueueHistory'
import { startThreadFromAlert } from '@/entities/alerts/api'
import { kindBadgeLabel } from '@/shared/actionQueueDetail'
import { readAqStateFromUrl, writeAqStateToUrl } from '@/shared/actionQueueUrlState'
import { taskHash } from '@/shared/routing'
import { linkifyTaskIds } from '@/shared/linkifyTaskIds'
import { formatDuration } from '@/shared/time'
import { resolveMediaKind, fileMediaKind, relativeTime, smartTitle } from './chatPageUtils'
import { OpeningNextMoves } from '@/widgets/chat/OpeningNextMoves'
import { PastSubjectsColumn } from '@/widgets/chat/PastSubjectsColumn'
import type { DisplayRow } from '@/widgets/chat/OpeningNextMoves'
import { useTasks } from '@/hooks/useTasks'
import { SkeletonList } from '@/components/Skeleton'

// ---------------------------------------------------------------------------
// Welcome state: quick-action chips and slash palette
// ---------------------------------------------------------------------------

const WELCOME_CHIPS = [
  { label: 'Groom the action queue', prompt: 'Groom the action queue' },
  { label: 'Grill an idea', prompt: 'Grill this idea into a PRD: ' },
  { label: 'Enqueue a task', prompt: 'Enqueue a task: ' },
  // 'What happened today?' streams a canned release-notes reply client-side
  // (see WhatHappenedTodayView) instead of prefilling the composer.
  { label: "What happened today?", prompt: 'What happened today?', action: 'what-happened' },
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

const KIND_ICON: Record<string, string> = {
  'failed-task': '⚠️',
  'stale-worktree': '🗑️',
  'draft-proposal': '💡',
  'awaiting-validation': '🔍',
  'arc-failed': '⛓️',
}

export interface HeroSuggestionsProps {
  /** Open alerts, already ranked with the most urgent item first. */
  alerts: ActionQueueItem[]
  /** Opens an alert's conversation when it exists, or its queue projection. */
  onAlertClick: (alert: ActionQueueItem) => void
  /** Called when the user clicks a quick-action chip; receives the prefill prompt. */
  onChipClick: (prompt: string) => void
  /** Called when the user clicks the "What happened today?" chip — streams a canned release-notes reply. */
  onWhatHappened: () => void
}

/**
 * Suggestion row rendered below the hero composer.
 *
 * The most important alert becomes the opening card in the hero; the next few
 * actionable conversations remain one click away before the normal shortcuts.
 */
export const HeroSuggestions = ({ alerts, onAlertClick, onChipClick, onWhatHappened }: HeroSuggestionsProps) => {
  const [topAlert, ...otherAlerts] = alerts

  return (
    <div className="w-full max-w-2xl space-y-3">
      {topAlert && (
        <article
          className="rounded-lg border border-primary/25 bg-card p-4 text-left shadow-sm"
          data-testid="hero-alert-preview"
          aria-label="Most important conversation"
        >
          <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <span aria-hidden="true" className="text-[13px]">{KIND_ICON[topAlert.kind] ?? '🔔'}</span>
            <span>Mars</span>
            <span aria-hidden="true">·</span>
            <span>{kindBadgeLabel(topAlert.kind)}</span>
            <span className={`ml-auto uppercase ${priorityBadgeClass(topAlert.priority)}`}>{topAlert.priority}</span>
          </div>
          <h2 className="mt-2 font-mono text-[14px] font-semibold text-foreground">{topAlert.title}</h2>
          <p className="mt-1 line-clamp-2 font-mono text-[12px] leading-relaxed text-primary">{topAlert.body}</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="truncate font-mono text-[10px] text-muted-foreground">{topAlert.entityId}</span>
            <button
              type="button"
              data-testid="hero-alert-open"
              className="shrink-0 rounded-md border border-primary/40 px-3 py-1.5 font-mono text-[10px] uppercase text-foreground transition-colors hover:bg-primary/10 active:scale-[0.98]"
              onClick={() => onAlertClick(topAlert)}
            >
              Open conversation
            </button>
          </div>
        </article>
      )}

      {otherAlerts.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Other conversations needing attention">
          {otherAlerts.slice(0, 1).map((alert) => {
            const base = alert.title.includes(' — ')
              ? alert.title.slice(0, alert.title.indexOf(' — '))
              : alert.title
            const chipLabel = base.length > 40 ? `${base.slice(0, 40)}…` : base
            return (
              <button
                key={alert.id}
                type="button"
                data-testid="hero-alert-option"
                title={alert.title}
                className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-primary/25 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10 hover:text-foreground active:scale-[0.98]"
                onClick={() => onAlertClick(alert)}
              >
                <span aria-hidden="true">{KIND_ICON[alert.kind] ?? '🔔'}</span>
                <span className="truncate">{chipLabel}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        {WELCOME_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className="rounded-full border border-primary/25 px-3.5 py-1.5 font-mono text-[11px] text-primary transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-foreground active:scale-[0.98]"
            onClick={() =>
              'action' in chip && chip.action === 'what-happened'
                ? onWhatHappened()
                : onChipClick(chip.prompt)
            }
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message part → AI Element rendering
// ---------------------------------------------------------------------------

type UIPart = MarsUIMessage['parts'][number]

/** Render an arbitrary tool output value inside the AI-Elements ToolOutput. */
const ToolResultBox = ({ value }: { value: unknown }) => (
  <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
    {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
  </pre>
)

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
      goal={alert.goal}
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
              : 'text-primary/40 hover:text-primary',
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
              : 'text-primary/40 hover:text-primary',
          ].join(' ')}
          onClick={() => void handleDown()}
        >
          <ThumbDownSvg />
        </button>
        {localNote && localRating === 'down' && (
          <span
            className="max-w-[200px] truncate font-mono text-[10px] text-primary/50"
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
          className="w-full max-w-xs rounded border border-primary/30 bg-card px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-primary/40 focus:border-primary/60 focus:outline-none"
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

/**
 * Renders an attachment segment in the transcript:
 *  - image  → inline <img> with max-height; click opens full size in new tab
 *  - audio  → <audio controls>
 *  - video  → <video controls>
 *  - other  → plain download link
 */
export const AttachmentDisplay = ({ attachment }: { attachment: ChatSegmentAttachment }) => {
  const src = `/api/chat/uploads/${encodeURIComponent(attachment.path)}`
  const kind = resolveMediaKind(attachment)

  if (kind === 'image') {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="attachment-image"
        className="my-1 block"
      >
        <img
          src={src}
          alt={attachment.name}
          className="max-h-64 rounded border border-primary/20 object-contain"
        />
      </a>
    )
  }
  if (kind === 'audio') {
    return (
      <div className="my-1" data-testid="attachment-audio">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls src={src} className="w-full max-w-sm" />
        <p className="mt-0.5 font-mono text-[10px] text-primary/60 truncate">{attachment.name}</p>
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div className="my-1" data-testid="attachment-video">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video controls src={src} className="max-h-64 w-full rounded border border-primary/20 object-contain" />
        <p className="mt-0.5 font-mono text-[10px] text-primary/60 truncate">{attachment.name}</p>
      </div>
    )
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="attachment-other"
      className="my-1 flex items-center gap-1.5 font-mono text-[11px] text-accent underline"
    >
      📎 {attachment.name}
    </a>
  )
}

/** A safe, compact recovery surface for an interrupted assistant response. */
const ChatResponseError = ({ onTryAgain, message }: { onTryAgain: () => void; message?: string }) => (
  <div
    role="alert"
    className="my-2 flex items-start gap-3 rounded-md border border-error/25 bg-error/5 px-3 py-2.5 text-[13px] text-foreground"
  >
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-error text-[10px] font-bold leading-none text-white"
    >
      !
    </span>
    <div className="min-w-0 leading-relaxed">
      <p className="font-medium">Response interrupted</p>
      <p className="text-muted-foreground">{message || 'Codex could not finish this reply. Send another message to try again.'}</p>
      <button
        type="button"
        className="mt-1.5 text-[12px] font-medium text-error underline decoration-error/40 underline-offset-2 transition-colors hover:text-foreground"
        onClick={onTryAgain}
      >
        Try again
      </button>
    </div>
  </div>
)

/** Subtle usage footer: duration · tokens · cost, from message metadata. */
const ResultFooter = ({ usage }: { usage: NonNullable<MarsUIMessage['metadata']>['usage'] }) => {
  if (!usage) return null
  const { durationMs, inputTokens, outputTokens, cost } = usage
  const parts: string[] = []
  if (durationMs != null) parts.push(formatDuration(durationMs))
  if (inputTokens != null || outputTokens != null) {
    parts.push(`${(inputTokens ?? 0) + (outputTokens ?? 0)} tokens`)
  }
  if (cost != null && cost > 0) parts.push(`$${cost.toFixed(4)}`)
  if (parts.length === 0) return null
  return <div className="mt-2 font-mono text-[10px] text-muted-foreground">{parts.join(' · ')}</div>
}

// ---------------------------------------------------------------------------
// Shared segment renderers — used by both renderPart (persisted) and
// LiveAssistantBubble (live stream) so the two paths look identical.
// ---------------------------------------------------------------------------

/**
 * Renders a thinking / chain-of-thought section using the AI-Elements
 * Reasoning collapsible. `isStreaming` keeps the block open and animating
 * while the model is still writing its chain-of-thought.
 */
export const ThinkingBlock = ({
  text,
  isStreaming = false,
}: {
  text: string
  isStreaming?: boolean
}): ReactNode => (
  <Reasoning isStreaming={isStreaming}>
    <ReasoningTrigger />
    <ReasoningContent>{text}</ReasoningContent>
  </Reasoning>
)

/** Shape of a single tool entry passed to ToolActivityGroup. */
type ToolActivityEntry = {
  toolUseId: string
  /** Tool name without the `tool-` prefix, e.g. `"Bash"`. */
  toolName: string
  input: unknown
  /** AI-SDK state string that controls the badge/icon in ToolHeader. */
  toolState: ToolUIPart['state']
  /** Pre-rendered output node (shown only when state is output-available). */
  output?: ReactNode
  errorText?: string
}

/**
 * Renders one or more tool calls as a compact, collapsible unit.
 * Single tool: a direct Tool block. Multiple tools: one summary header that
 * collapses to reveal individual rows (each independently collapsible).
 */
export const ToolActivityGroup = ({
  tools,
}: {
  tools: ToolActivityEntry[]
}): ReactNode => (
  <ToolGroup
    tools={tools.map((t): ToolGroupEntryData => ({
      id: t.toolUseId,
      toolType: `tool-${t.toolName}` as ToolUIPart['type'],
      state: t.toolState,
      input: t.input,
      output: t.output,
      errorText: t.errorText,
    }))}
  />
)

/** Render one `UIMessage` part as its AI Element. Returns null for inert parts. */
const renderPart = (
  part: UIPart,
  key: number,
  onRetry: () => void,
): ReactNode => {
  if (part.type === 'text') {
    return <Response key={key}>{linkifyTaskIds(part.text)}</Response>
  }
  if (part.type === 'reasoning') {
    return (
      <ThinkingBlock key={key} text={part.text} isStreaming={part.state === 'streaming'} />
    )
  }
  if (isStaticToolUIPart(part)) {
    return (
      <ToolActivityGroup
        key={key}
        tools={[{
          toolUseId: part.toolCallId,
          toolName: part.type.replace(/^tool-/, ''),
          input: part.input,
          toolState: part.state,
          output: part.state === 'output-available' ? <ToolResultBox value={part.output} /> : undefined,
          errorText: part.state === 'output-error' ? part.errorText : undefined,
        }]}
      />
    )
  }
  if (part.type === 'data-proposedToolCall') {
    return (
      <div
        key={key}
        data-testid="proposed-tool-call"
        className="my-2 rounded-md border border-highlight/30 bg-highlight/5 px-3 py-2 font-mono text-[12px]"
      >
        <p className="font-semibold text-highlight uppercase tracking-wide text-[10px]">
          Proposed — awaiting your confirmation
        </p>
        <p className="mt-1 text-foreground">{part.data.toolName}</p>
        {part.data.input != null && (
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground leading-relaxed">
            {JSON.stringify(part.data.input, null, 2)}
          </pre>
        )}
      </div>
    )
  }
  if (part.type === 'data-alert') {
    return <AlertCardFromSegment key={key} alert={part.data} />
  }
  if (part.type === 'data-attachment') {
    return <AttachmentDisplay key={key} attachment={part.data} />
  }
  if (part.type === 'data-chatError') {
    return (
      <ChatResponseError key={key} onTryAgain={onRetry} message={part.data.message} />
    )
  }
  return null
}

/**
 * A single chat message rendered through AI Elements. Persisted history and the
 * live streamed reply share this component — both arrive as a `MarsUIMessage`
 * (history via `chatMessageToUIMessage`, live via the transport).
 */
export const MessageView = ({
  message,
  onRetry,
  onFeedbackChange,
}: {
  message: MarsUIMessage
  /** Called when the user clicks "Try again" on an interrupted response; directly
   *  retries the last user request without inserting a synthetic prompt. */
  onRetry: () => void
  /** Called after a feedback write so the parent can invalidate its query cache. */
  onFeedbackChange?: () => void
}) => {
  const isUser = message.role === 'user'
  const parts = message.parts
  const feedback = message.metadata?.feedback ?? null
  const usage = message.metadata?.usage
  const handleFeedbackChange = useCallback(() => {
    onFeedbackChange?.()
  }, [onFeedbackChange])

  // A pure-alert assistant message renders its AlertCard(s) directly — AlertCard
  // owns its own card chrome, so wrapping it in MessageContent would double-box.
  const isAlertOnly =
    !isUser && parts.length > 0 && parts.every((p) => p.type === 'data-alert')

  if (isAlertOnly) {
    return (
      <div className="group flex flex-col gap-2 px-1 py-2" data-message-role={message.role}>
        {parts.map((p, i) => renderPart(p, i, onRetry))}
        {!isUser && (
          <FeedbackControls
            messageId={message.id}
            feedback={feedback}
            onFeedbackChange={handleFeedbackChange}
          />
        )}
      </div>
    )
  }

  return (
    <Message from={message.role} data-message-role={message.role}>
      {/* Assistant messages sit inside a subtle bordered card; user messages use
          the default contained pill from MessageContent variant='contained'.
          The usage footer (ResultFooter) is placed outside the bordered box as a
          sibling so token/cost/duration metadata is visually associated with the
          message but not inside its bordered background content area. */}
      <div className="flex flex-col">
        <MessageContent
          variant={isUser ? 'contained' : 'flat'}
          className={!isUser ? 'border border-primary/20 bg-card px-3 py-2' : undefined}
        >
          {parts.map((p, i) => renderPart(p, i, onRetry))}
          {!isUser && (
            <FeedbackControls
              messageId={message.id}
              feedback={feedback}
              onFeedbackChange={handleFeedbackChange}
            />
          )}
        </MessageContent>
        <ResultFooter usage={usage} />
      </div>
    </Message>
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

  const title = smartTitle(thread.title)

  // Derive the alert kind from the alertItemId prefix (e.g. 'failed-task:mars-123' → 'failed-task')
  const alertKind = thread.alertItemId
    ? thread.alertItemId.split(':')[0] ?? null
    : null

  // Type-specific icon: alert threads get a category icon; user threads get a chat bubble.
  const typeIcon = thread.origin === 'alert'
    ? (KIND_ICON[alertKind ?? ''] ?? '🔔')
    : '💬'
  const iconDimmed = thread.origin === 'alert' && thread.alertResolved

  return (
    <div
      className={[
        'group flex items-center gap-1 rounded px-2 py-1.5 cursor-pointer border-b border-primary/10',
        isSelected ? 'bg-primary/20 text-foreground' : 'text-primary hover:bg-primary/10 hover:text-foreground',
      ].join(' ')}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={startEdit}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="flex-1 rounded bg-primary/10 px-1 font-mono text-[11px] text-foreground outline-none"
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
          <span
            className={[
              'flex-none text-[11px]',
              iconDimmed ? 'opacity-30' : '',
            ].join(' ')}
            title={
              thread.origin === 'alert'
                ? thread.alertResolved
                  ? 'Alert resolved'
                  : `Alert: ${alertKind ?? 'unknown'}`
                : 'Conversation'
            }
            aria-label={thread.origin === 'alert' ? (alertKind ?? 'alert') : 'conversation'}
          >
            {typeIcon}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{title}</span>
          {thread.updatedAt && (
            <span className="ml-1 flex-none font-mono text-[10px] text-muted-foreground">
              {relativeTime(thread.updatedAt)}
            </span>
          )}
          {thread.attentionStatus === 'ready' && (
            <span
              data-testid="ready-badge"
              className="h-1.5 w-1.5 flex-none rounded-full bg-green-500"
              title="New response"
            />
          )}
          {(thread.attentionStatus === 'generating' || thread.status === 'running') && thread.attentionStatus !== 'ready' && (
            <span
              className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-primary/60"
              title={thread.status === 'throttled' ? 'Retrying…' : undefined}
            />
          )}
          <button
            type="button"
            className="flex-none rounded px-1 py-0.5 text-[10px] text-primary/50 opacity-0 transition-opacity hover:bg-red-900/20 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
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
// Conversation — AI-Elements transcript driven by useChat
// ---------------------------------------------------------------------------

/**
 * Pulsing "Thinking…" indicator shown while a reply is in-flight but before
 * the first streaming token arrives.  Covers two cases:
 *   - client-initiated send: status === 'submitted'
 *   - daemon-initiated run: serverRunning && !isBusy (thread.status === 'running'
 *     but the SSE stream has not yet started)
 */
export const ThinkingIndicator = () => (
  <div role="status" aria-live="polite" className="flex items-center gap-2 px-4 py-2">
    {/* Three staggered bouncing dots — livelier than a single static pulse */}
    <span className="flex items-center gap-[3px]" aria-hidden="true">
      <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-primary/50 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-primary/50 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-primary/50 [animation-delay:300ms]" />
    </span>
    <span className="font-mono text-[11px] text-primary/50">Thinking…</span>
  </div>
)

// ---------------------------------------------------------------------------
// LiveAssistantBubble — ordered-segment rendering of the streaming reply
// ---------------------------------------------------------------------------

/**
 * Renders a live assistant message from a `LiveBuffer` so the streaming layout
 * matches the persisted layout produced by `chatMessageToUIMessage` + `MessageView`.
 *
 * Segments are rendered in arrival order:
 *   - TextSegment     → Response (Streamdown markdown)
 *   - ThinkingSegment → ThinkingBlock (collapsible reasoning)
 *   - ToolGroupSegment → ToolActivityGroup (one Tool block per call)
 *
 * A blinking cursor is appended at the bottom while the buffer is not yet done.
 */
export const LiveAssistantBubble = ({ buffer }: { buffer: LiveBuffer }): ReactNode => (
  <Message from="assistant" data-message-role="assistant">
    <MessageContent variant="flat" className="border border-primary/20 bg-card px-3 py-2">
      {buffer.segments.length === 0 && !buffer.done ? (
        // No segments yet — show the bouncing-dot placeholder (same as ThinkingIndicator).
        <ThinkingIndicator />
      ) : (
        buffer.segments.map((seg, i) => {
          if (seg.type === 'text') {
            return <Response key={i}>{linkifyTaskIds(seg.text)}</Response>
          }
          if (seg.type === 'thinking') {
            return <ThinkingBlock key={i} text={seg.text} isStreaming={!buffer.done} />
          }
          if (seg.type === 'tool_group') {
            return (
              <ToolActivityGroup
                key={i}
                tools={seg.tools.map((t) => ({
                  toolUseId: t.toolUseId,
                  toolName: t.toolName,
                  input: t.input,
                  toolState: t.state as ToolUIPart['state'],
                  output: t.state === 'output-available' ? <ToolResultBox value={t.output} /> : undefined,
                  errorText: t.state === 'output-error' ? t.errorText : undefined,
                }))}
              />
            )
          }
          return null
        })
      )}
      {buffer.error && (
        <div role="alert" className="my-2 rounded border border-red-400/40 bg-red-950/20 px-3 py-2 font-mono text-[12px] text-red-200">
          <span className="font-semibold">Codex could not respond.</span>{' '}{buffer.error}
        </div>
      )}
      {!buffer.done && buffer.segments.length > 0 && (
        <span
          className="ml-0.5 inline-block h-3 w-0.5 animate-pulse rounded-sm bg-foreground/60"
          aria-hidden="true"
        />
      )}
    </MessageContent>
  </Message>
)

interface ChatConversationProps {
  threadId: string
  projectId?: string
  /** Prefill flowing into the composer (chip / slash / discuss). */
  prefill?: string
  onPrefillConsumed: () => void
  /** Insert a prompt into the composer (welcome chips + "try again"). */
  onInsertPrompt: (prompt: string) => void
  /** Called whenever the live buffer for this thread changes. Used to lift
   * the buffer up to ChatPage so ContextRail can render the activity panel. */
  onLiveBufferChange?: (buf: LiveBuffer | null) => void
}

/**
 * The in-thread transcript + composer. `useChat` (via `useMarsChat`) is the
 * single source of rendered messages: persisted history is mapped in as
 * `initialMessages` and reconciled on refetch, and the live streamed reply
 * arrives through the same `MarsChatTransport`. The old `chatBuffer` live path
 * is gone.
 */
const ChatConversation = ({
  threadId,
  projectId,
  prefill,
  onPrefillConsumed,
  onInsertPrompt,
  onLiveBufferChange,
}: ChatConversationProps) => {
  const qc = useQueryClient()

  const { data: threadDetail, isLoading } = useQuery({
    queryKey: ['chat-thread', threadId, projectId],
    queryFn: () => fetchChatThread(threadId, projectId),
  })

  const persisted = useMemo(
    () => (threadDetail?.messages ?? []).map(chatMessageToUIMessage),
    [threadDetail],
  )

  const { messages, status, sendMessage, stop, error, setMessages, resumeStream } = useMarsChat({
    threadId,
    projectId,
    initialMessages: persisted,
  })

  // Reconcile persisted history into useChat when a refetch actually changed it,
  // but never mid-stream — useChat owns the transcript while a reply streams.
  const appliedSigRef = useRef<string>(' ')
  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') return
    const sig = transcriptSignature(threadDetail?.messages ?? [])
    if (sig === appliedSigRef.current) return
    appliedSigRef.current = sig
    setMessages(persisted)
  }, [threadDetail, status, persisted, setMessages])

  const handleFeedbackChange = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
  }, [qc, threadId])

  const isBusy = status === 'streaming' || status === 'submitted'
  const serverRunning = threadDetail?.thread.status === 'running'

  // Queued-next message: captured while a run is active, auto-submitted when ready.
  const [queued, setQueued] = useState<{ text: string; attachments?: AttachmentInfo[] } | null>(null)
  // Local prefill for restoring text when the user cancels a queued message.
  const [localPrefill, setLocalPrefill] = useState<string | undefined>(undefined)
  // Pending indicator: show from the moment a send lands until the first stream
  // token arrives (submitted), and also whenever the daemon has an active run
  // that the client hasn't started streaming yet (server-initiated run, idle).
  const showThinking = status === 'submitted' || (serverRunning && !isBusy)

  // Attach live to a daemon-initiated run the client did NOT start (an
  // alert-origin thread whose run began server-side). `resumeStream` opens the
  // daemon's ui-stream in resume mode; when there is no active run it 204s and
  // this is a no-op. Guarded to fire at most once per running-period per thread,
  // and never while the client is already streaming its own send (`isBusy`), so
  // it can't double-consume. The history refetch remains the fallback.
  const resumedThreadRef = useRef<string | null>(null)
  useEffect(() => {
    if (!serverRunning) {
      if (resumedThreadRef.current === threadId) resumedThreadRef.current = null
      return
    }
    if (isBusy || resumedThreadRef.current === threadId) return
    resumedThreadRef.current = threadId
    void resumeStream().catch(() => {
      if (resumedThreadRef.current === threadId) resumedThreadRef.current = null
    })
  }, [threadId, serverRunning, isBusy, resumeStream])

  const handleSend = useCallback(
    async (text: string, attachments?: AttachmentInfo[]) => {
      await sendMessage(
        { text },
        attachments && attachments.length > 0 ? { body: { attachments } } : undefined,
      )
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
    },
    [sendMessage, qc],
  )

  // Auto-submit the queued message when the run finishes (status transitions
  // from streaming/submitted → ready). The prev-status ref tracks transitions
  // so re-renders that don't change status don't double-fire.
  const prevStatusRef = useRef<string>(status)
  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = status
    if (
      (prevStatus === 'streaming' || prevStatus === 'submitted') &&
      status === 'ready' &&
      queued !== null
    ) {
      void handleSend(queued.text, queued.attachments)
      setQueued(null)
    }
  }, [status, queued, handleSend])

  // Stopping a run settles the transport (via the abort signal's onAbort handler,
  // which sends a finish chunk and calls stopChatThread on the daemon) and then
  // invalidates the persisted-history query so the reconciliation effect can
  // replace the partial streamed content in useChat with the daemon-persisted
  // reply once the refetch lands. This is the equivalent of clearLiveBuffer in
  // the old SSE-buffer architecture: it unblocks the reconciliation path so the
  // stale streaming state does not persist across the next send or window focus.
  const handleStop = useCallback(() => {
    void stop()
    void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] })
    void qc.invalidateQueries({ queryKey: ['chat-threads'] })
  }, [stop, qc, threadId])

  // Direct retry: resubmit the last real user message without touching the
  // composer or inserting any synthetic "Please retry…" prompt into the transcript.
  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUserMsg) return
    const text = lastUserMsg.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('\n')
      .trim()
    if (!text) return
    void handleSend(text)
  }, [messages, handleSend])

  // Suppress welcome chips while we're waiting for a reply — a brand-new
  // thread with a running/submitted state should show ThinkingIndicator, not
  // the empty-state chips.
  const showWelcome = !isLoading && messages.length === 0 && !showThinking

  // Cumulative token count across all assistant messages in this thread.
  const totalTokens = useMemo(
    () =>
      messages.reduce((sum, m) => {
        const usage = m.metadata?.usage
        return sum + (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      }, 0),
    [messages],
  )

  // Build a LiveBuffer from the AI SDK's streaming parts so LiveAssistantBubble
  // can render them in arrival order (text ↔ tool ↔ text interleaving).
  // Only computed while actively streaming; null otherwise.
  const liveBuffer = useMemo((): LiveBuffer | null => {
    if (status !== 'streaming') return null
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return null
    return last.parts.reduce<LiveBuffer>((buf, part) => {
      if (part.type === 'text') {
        return applyLiveEvent(buf, { type: 'text', text: part.text })
      }
      if (part.type === 'reasoning') {
        return applyLiveEvent(buf, { type: 'thinking', text: part.text })
      }
      if (isStaticToolUIPart(part)) {
        const toolName = part.type.replace(/^tool-/, '')
        let b = applyLiveEvent(buf, {
          type: 'tool_use',
          toolUseId: part.toolCallId,
          toolName,
          input: part.input,
        })
        if (part.state === 'input-available') {
          b = applyLiveEvent(b, { type: 'tool_input_available', toolUseId: part.toolCallId })
        } else if (part.state === 'output-available') {
          b = applyLiveEvent(b, { type: 'tool_result', toolUseId: part.toolCallId, output: part.output })
        } else if (part.state === 'output-error') {
          b = applyLiveEvent(b, { type: 'tool_result', toolUseId: part.toolCallId, errorText: part.errorText })
        }
        return b
      }
      return buf
    }, emptyLiveBuffer())
  }, [messages, status])

  const liveMessageId = liveBuffer != null ? messages[messages.length - 1]?.id : null

  // Lift the live buffer to ChatPage so the ContextRail activity panel can
  // render in-flight tool calls. Fires on every liveBuffer change, including
  // null (when streaming ends or this thread mounts fresh).
  useEffect(() => {
    onLiveBufferChange?.(liveBuffer)
  }, [liveBuffer, onLiveBufferChange])

  return (
    <>
      <Conversation className="flex-1">
        <ConversationContent>
          {showWelcome ? (
            <ConversationEmptyState>
              <p className="font-mono text-[13px] text-muted-foreground">
                What would you like to do?
              </p>
              <Suggestions className="justify-center">
                {WELCOME_CHIPS.map(({ label, prompt }) => (
                  <Suggestion key={label} suggestion={prompt} onClick={onInsertPrompt}>
                    {label}
                  </Suggestion>
                ))}
              </Suggestions>
            </ConversationEmptyState>
          ) : (
            <>
              {messages.map((m) =>
                m.id === liveMessageId && liveBuffer != null ? (
                  <LiveAssistantBubble key={m.id} buffer={liveBuffer} />
                ) : (
                  <MessageView
                    key={m.id}
                    message={m}
                    onRetry={handleRetry}
                    onFeedbackChange={handleFeedbackChange}
                  />
                )
              )}
              {showThinking && <ThinkingIndicator />}
              {error && !messages.at(-1)?.parts?.some(p => p.type === 'data-chatError') && (
                <ChatResponseError
                  onTryAgain={handleRetry}
                />
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer
        threadId={threadId}
        projectId={projectId}
        disabled={false}
        isBusy={isBusy || serverRunning}
        onSend={handleSend}
        onStop={handleStop}
        initialText={localPrefill ?? prefill}
        onInitialTextConsumed={() => {
          if (localPrefill !== undefined) {
            setLocalPrefill(undefined)
          } else {
            onPrefillConsumed()
          }
        }}
        threadTokens={totalTokens > 0 ? totalTokens : null}
        onQueueNext={(text, att) => setQueued({ text, attachments: att })}
        queuedNext={queued ? { text: queued.text, attachmentCount: queued.attachments?.length ?? 0 } : null}
        onCancelQueued={() => {
          if (queued) {
            setLocalPrefill(queued.text)
            setQueued(null)
          }
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Slash palette
// ---------------------------------------------------------------------------

interface SlashPaletteProps {
  matches: ReadonlyArray<{ cmd: string; prompt: string }>
  activeIndex: number
  onSelect: (prompt: string) => void
  onActivate: (index: number) => void
}

const SlashPalette = ({ matches, activeIndex, onSelect, onActivate }: SlashPaletteProps) => {
  if (matches.length === 0) return null

  return (
    <div
      role="listbox"
      className="absolute bottom-full left-0 mb-1 w-full rounded border border-primary/30 bg-background shadow-lg"
    >
      {matches.map(({ cmd, prompt }, index) => (
        <button
          key={cmd}
          role="option"
          aria-selected={index === activeIndex}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px] ${
            index === activeIndex
              ? 'bg-primary/20 text-foreground'
              : 'text-primary hover:bg-primary/20 hover:text-foreground'
          }`}
          onMouseDown={(e) => {
            // Prevent textarea blur before click fires.
            e.preventDefault()
            onSelect(prompt)
          }}
          onMouseEnter={() => onActivate(index)}
        >
          <span className="text-foreground">{cmd}</span>
          <span className="truncate text-primary/50">{prompt}</span>
        </button>
      ))}
    </div>
  )
}

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

export interface HeroComposerProps {
  /** Called with text, the raw File objects, and a clearState callback the
   *  caller must invoke on success (files are uploaded AFTER thread creation,
   *  so the hero passes Files rather than attachment ids). */
  onSend: (text: string, files: File[], clearState: () => void) => void
  isPending: boolean
  prefill?: string
  onPrefillConsumed: () => void
}

export const HeroComposer = ({ onSend, isPending, prefill, onPrefillConsumed }: HeroComposerProps) => {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** True while the mic is recording / dictating. */
  const [micActive, setMicActive] = useState(false)
  /** Voice-note blob recorded via MediaRecorder (null until recording stops). */
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)

  const speechAvailable = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  useEffect(() => {
    if (prefill === undefined) return
    setText(prefill)
    onPrefillConsumed()
    textareaRef.current?.focus()
  }, [prefill, onPrefillConsumed])

  // Revoke object URLs on unmount to avoid memory leaks.
  useEffect(() => {
    return () => {
      for (const a of attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('audio/') || f.type.startsWith('video/'),
    )
    setAttachments((prev) => [
      ...prev,
      ...arr.map((file) => ({
        localId: `${Date.now()}-${Math.random()}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      })),
    ])
  }, [])

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.localId === localId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((a) => a.localId !== localId)
    })
  }, [])

  const handleAttachVoiceNote = useCallback(() => {
    if (!voiceBlob) return
    const file = new File([voiceBlob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' })
    addFiles([file])
    setVoiceBlob(null)
  }, [voiceBlob, addFiles])

  const handleMicToggle = useCallback(async () => {
    if (micActive) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      recorderRef.current?.stop()
      recorderRef.current = null
      setMicActive(false)
      return
    }
    setMicActive(true)
    setVoiceBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: BlobPart[] = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        setVoiceBlob(blob)
        for (const track of stream.getTracks()) track.stop()
      }
      recorder.start()
      recorderRef.current = recorder
    } catch {
      // Microphone permission denied or not available — fall back to recognition-only.
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition: any = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'
    let committed = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = event.results[i] as any
        if (result.isFinal) {
          committed += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      setText(committed + interim)
    }
    recognition.onend = () => {
      setMicActive(false)
      recognitionRef.current = null
    }
    recognition.start()
    recognitionRef.current = recognition
  }, [micActive])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    // Allow sending with just attachments (empty text) or just text.
    if ((!trimmed && attachments.length === 0) || isPending) return
    onSend(trimmed, attachments.map((a) => a.file), () => {
      setText('')
      setAttachments([])
      setVoiceBlob(null)
    })
  }, [text, attachments, isPending, onSend])

  return (
    <div className="w-full max-w-2xl">
      {/* Voice-note CTA — shown after mic stops */}
      {voiceBlob && !micActive && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Voice note recorded</span>
          <PromptInputButton
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            onClick={handleAttachVoiceNote}
          >
            Send as voice note
          </PromptInputButton>
          <button
            type="button"
            className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setVoiceBlob(null)}
          >
            Discard
          </button>
        </div>
      )}
      {/* AI-Elements PromptInput shell. */}
      <div className="w-full divide-y divide-border overflow-hidden rounded-2xl border bg-background shadow-sm">
        {/* Hidden file input — wired to addFiles. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,video/*"
          multiple
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {/* Attachment preview chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3" data-testid="attachment-chips">
            {attachments.map((a) => (
              <div
                key={a.localId}
                data-testid="attachment-chip"
                className="group relative flex items-center gap-2 rounded-md border bg-accent/50 py-1 pr-1 pl-2 text-xs"
              >
                {a.previewUrl ? (
                  <img
                    src={a.previewUrl}
                    alt={a.file.name}
                    className="size-8 rounded object-cover"
                  />
                ) : (
                  <span className="text-sm">
                    {fileMediaKind(a.file) === 'audio' ? '🎵' : '🎬'}
                  </span>
                )}
                <span className="max-w-[120px] truncate text-muted-foreground">
                  {a.file.name}
                </span>
                <button
                  type="button"
                  data-testid="remove-attachment"
                  aria-label={`Remove ${a.file.name}`}
                  className="ml-0.5 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => removeAttachment(a.localId)}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <PromptInputTextarea
          ref={textareaRef}
          data-testid="hero-composer"
          className="min-h-24 text-[14px]"
          placeholder={isPending ? 'Creating thread…' : 'Message mars… (Enter to send, Shift+Enter for newline)'}
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
        <PromptInputToolbar>
          <PromptInputTools>
            {/* Attach button */}
            <PromptInputButton
              data-testid="attach-btn"
              aria-label="Attach file"
              title="Attach image, audio or video"
              disabled={isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon className="size-4" />
            </PromptInputButton>

            {/* Mic button — hidden when Web Speech API is unavailable */}
            {speechAvailable && (
              <PromptInputButton
                data-testid="mic-btn"
                aria-label={micActive ? 'Stop dictation' : 'Start dictation'}
                title={micActive ? 'Click to stop dictation' : 'Dictate into the composer'}
                className={micActive ? 'text-destructive hover:text-destructive' : undefined}
                onClick={() => void handleMicToggle()}
              >
                {micActive ? <SquareIcon className="size-4" /> : <MicIcon className="size-4" />}
              </PromptInputButton>
            )}
          </PromptInputTools>
          <PromptInputSubmit
            type="button"
            data-testid="hero-send"
            status={isPending ? 'submitted' : undefined}
            disabled={isPending || (text.trim().length === 0 && attachments.length === 0)}
            onClick={handleSend}
          />
        </PromptInputToolbar>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ComposerProps {
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
   *
   * Attachments cannot be uploaded on this path (the thread id needed to
   * upload them is not yet known) and are cleared alongside the text.
   */
  onSendOverride?: (msg: string, clearText: () => void) => void
  /** In-flight state for the override send (create-thread + first message). */
  sendPending?: boolean
  /** External error from an override-send failure; shown inline below the textarea. */
  sendError?: string | null
  /**
   * Ordinary-thread send. Attachments are uploaded here first (the composer owns
   * the File objects), then the resulting ids are handed off. Wired by
   * `ChatConversation` to `useChat.sendMessage`, which drives the
   * `MarsChatTransport` (postChatMessage lives inside the transport now).
   */
  onSend?: (text: string, attachments?: AttachmentInfo[]) => Promise<void>
  /** Stop the in-flight run. Wired to `useChat.stop` (aborts + stopChatThread). */
  onStop?: () => void
  /** True while a reply is streaming / the thread is running — shows the Stop button. */
  isBusy?: boolean
  /** Cumulative token count (input + output) for all messages in this thread. */
  threadTokens?: number | null
  /** Called when a message is queued while a run is active (isBusy). */
  onQueueNext?: (text: string, attachments?: AttachmentInfo[]) => void
  /** The currently queued next message, or null if none. Renders a preview chip. */
  queuedNext?: { text: string; attachmentCount: number } | null
  /** Called when the user cancels the queued message chip. Should restore the text to the composer. */
  onCancelQueued?: () => void
  /**
   * When true, renders a Pause button beside Stop while the thread is busy.
   * Set this only when the transport supports pause/resume; leave false (default)
   * when the current transport has no pause capability.
   */
  canPause?: boolean
  /** Called when the user clicks the Pause button. Only relevant when canPause is true. */
  onPause?: () => void
}

/** A pending file attachment in the composer before it is uploaded. */
interface PendingAttachment {
  /** Stable local key for React rendering. */
  localId: string
  file: File
  /** Object-URL for image thumbnail previews — null for audio/video. */
  previewUrl: string | null
}

export const Composer = ({
  threadId,
  projectId,
  disabled,
  initialText,
  onInitialTextConsumed,
  onSendOverride,
  sendPending = false,
  sendError,
  onSend,
  onStop,
  isBusy = false,
  threadTokens,
  onQueueNext,
  queuedNext,
  onCancelQueued,
  canPause = false,
  onPause,
}: ComposerProps) => {
  const [text, setText] = useState('')
  const [showPalette, setShowPalette] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = useMemo(() => {
    if (!showPalette) return [] as ReadonlyArray<{ cmd: string; prompt: string }>
    const lower = text.trimStart().toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(lower))
  }, [showPalette, text])
  const [localSendError, setLocalSendError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isUploading, setIsUploading] = useState(false)
  /** True while the mic is recording / dictating. */
  const [micActive, setMicActive] = useState(false)
  /** Voice-note blob recorded via MediaRecorder (null until recording stops). */
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)

  // Detect Web Speech API availability once on mount.
  const speechAvailable = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  // Apply chip / slash-command prefill from welcome state.
  useEffect(() => {
    if (initialText === undefined) return
    setText(initialText)
    onInitialTextConsumed()
    textareaRef.current?.focus()
  }, [initialText, onInitialTextConsumed])

  // Revoke object URLs when attachments are removed to avoid memory leaks.
  useEffect(() => {
    return () => {
      for (const a of attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) =>
      f.type.startsWith('image/') || f.type.startsWith('audio/') || f.type.startsWith('video/'),
    )
    setAttachments((prev) => [
      ...prev,
      ...arr.map((file) => ({
        localId: `${Date.now()}-${Math.random()}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      })),
    ])
  }, [])

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.localId === localId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((a) => a.localId !== localId)
    })
  }, [])

  const { mutate: send, isPending } = useMutation({
    // The override path (projection threads) is handled directly in handleSend,
    // so this mutation only runs for the ordinary send-to-threadId case. It
    // uploads attachments (the composer owns the Files), then hands text + ids
    // to `onSend`, which drives useChat/the transport (postChatMessage now lives
    // inside the transport).
    mutationFn: async (msg: string) => {
      let uploadedAttachments: AttachmentInfo[] | undefined
      if (attachments.length > 0 && threadId) {
        setIsUploading(true)
        try {
          uploadedAttachments = await Promise.all(
            attachments.map((a) => uploadAttachment(threadId, a.file, projectId)),
          )
        } finally {
          setIsUploading(false)
        }
      }
      await onSend?.(msg, uploadedAttachments)
    },
    onMutate: () => setLocalSendError(null),
    onSuccess: () => {
      setText('')
      setAttachments([])
      setVoiceBlob(null)
    },
    onError: (err) => setLocalSendError(sendErrorMessage(err)),
  })

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    // Allow sending with just attachments (empty text) or just text.
    if (!trimmed && attachments.length === 0) return
    if (isPending || sendPending || isUploading) return

    // Queue path: when the thread is busy and a queue callback is provided,
    // capture the message (uploading any attachments eagerly) instead of sending.
    if (isBusy && onQueueNext) {
      setShowPalette(false)
      setLocalSendError(null)
      let uploadedAttachments: AttachmentInfo[] | undefined
      if (attachments.length > 0 && threadId) {
        setIsUploading(true)
        try {
          uploadedAttachments = await Promise.all(
            attachments.map((a) => uploadAttachment(threadId, a.file, projectId)),
          )
        } catch (err) {
          setLocalSendError(sendErrorMessage(err))
          return
        } finally {
          setIsUploading(false)
        }
      }
      onQueueNext(trimmed, uploadedAttachments)
      setText('')
      setAttachments([])
      return
    }

    if (isBusy) return  // busy but no queue callback — block send as before

    setShowPalette(false)
    setLocalSendError(null)
    if (onSendOverride) {
      onSendOverride(trimmed, () => {
        setText('')
        setAttachments([])
        setVoiceBlob(null)
      })
    } else if (onSend) {
      send(trimmed)
      // setText('') / attachment clearing handled inside send.onSuccess so inputs survive failure
    }
  }, [text, attachments, isBusy, isPending, sendPending, isUploading, onQueueNext, threadId, projectId, onSendOverride, onSend, send])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPalette && matches.length > 0) {
      if (e.key === 'Tab') {
        e.preventDefault()
        handleSlashSelect(matches[activeIndex]!.prompt)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSlashSelect(matches[activeIndex]!.prompt)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowPalette(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    const trimmed = value.trimStart()
    const shouldShow = trimmed.startsWith('/') && !trimmed.includes(' ')
    setShowPalette(shouldShow)
    if (shouldShow) setActiveIndex(0)
  }

  const handleSlashSelect = (prompt: string) => {
    setText(prompt)
    setShowPalette(false)
    textareaRef.current?.focus()
  }

  // Drag-and-drop onto the composer container.
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }

  // Paste images from the clipboard.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      addFiles(files)
      // Only prevent default when there are actual files to attach, to avoid
      // blocking normal text paste.
      e.preventDefault()
    }
  }

  // Mic: toggle dictation via Web Speech API + MediaRecorder.
  const handleMicToggle = useCallback(async () => {
    if (micActive) {
      // Stop both recognition and recorder.
      recognitionRef.current?.stop()
      recognitionRef.current = null
      recorderRef.current?.stop()
      recorderRef.current = null
      setMicActive(false)
      return
    }

    setMicActive(true)
    setVoiceBlob(null)

    // Start MediaRecorder for the voice-note feature.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: BlobPart[] = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        setVoiceBlob(blob)
        // Stop all tracks to release the microphone.
        for (const track of stream.getTracks()) track.stop()
      }
      recorder.start()
      recorderRef.current = recorder
    } catch {
      // Microphone permission denied or not available — fall back to recognition-only.
    }

    // Start SpeechRecognition for live dictation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition: any = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'

    let committed = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = event.results[i] as any
        if (result.isFinal) {
          committed += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      setText(committed + interim)
    }
    recognition.onend = () => {
      setMicActive(false)
      recognitionRef.current = null
    }
    recognition.start()
    recognitionRef.current = recognition
  }, [micActive])

  /** Attach the recorded voice blob as a voice-note attachment. */
  const handleAttachVoiceNote = useCallback(() => {
    if (!voiceBlob) return
    const file = new File([voiceBlob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' })
    addFiles([file])
    setVoiceBlob(null)
  }, [voiceBlob, addFiles])

  const isDisabled = isPending || sendPending || isUploading

  return (
    <div
      data-testid="composer"
      className="relative border-t border-border px-4 py-3"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {showPalette && (
        <SlashPalette
          matches={matches}
          activeIndex={activeIndex}
          onSelect={handleSlashSelect}
          onActivate={setActiveIndex}
        />
      )}

      {/* Voice-note CTA — shown after mic stops */}
      {voiceBlob && !micActive && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Voice note recorded</span>
          <PromptInputButton
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            onClick={handleAttachVoiceNote}
          >
            Send as voice note
          </PromptInputButton>
          <button
            type="button"
            className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setVoiceBlob(null)}
          >
            Discard
          </button>
        </div>
      )}

      {/* AI-Elements PromptInput shell. Mars owns attachment/send/mic state, so
          the vendored PromptInput *form* wrapper (and its internal file-input +
          attachment context) is not used — its exact classNames are applied to
          a plain container and the presentational subcomponents are composed on
          top, preserving the upload path and the composer test's file-input
          contract. */}
      <div className="w-full divide-y divide-border overflow-hidden rounded-xl border bg-background shadow-sm">
        {/* Hidden file input — the only file input in the composer, wired to Mars addFiles. */}
        <input
          ref={fileInputRef}
          type="file"
          data-testid="file-input"
          accept="image/*,audio/*,video/*"
          multiple
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            // Reset so re-selecting the same file fires onChange again.
            e.target.value = ''
          }}
        />

        {/* Queued-next chip — shown when a message is waiting to be sent after the current run finishes. */}
        {queuedNext && (
          <div
            data-testid="queued-next-chip"
            className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-muted-foreground"
          >
            <span className="flex-1 truncate font-mono opacity-70">{queuedNext.text}</span>
            {queuedNext.attachmentCount > 0 && (
              <span className="font-mono text-[10px] opacity-60">{queuedNext.attachmentCount} att.</span>
            )}
            <button
              type="button"
              data-testid="queued-next-cancel"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              onClick={onCancelQueued}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Attachment preview chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3" data-testid="attachment-chips">
            {attachments.map((a) => (
              <div
                key={a.localId}
                data-testid="attachment-chip"
                className="group relative flex items-center gap-2 rounded-md border bg-accent/50 py-1 pr-1 pl-2 text-xs"
              >
                {a.previewUrl ? (
                  <img
                    src={a.previewUrl}
                    alt={a.file.name}
                    className="size-8 rounded object-cover"
                  />
                ) : (
                  <span className="text-sm">
                    {fileMediaKind(a.file) === 'audio' ? '🎵' : '🎬'}
                  </span>
                )}
                <span className="max-w-[120px] truncate text-muted-foreground">
                  {a.file.name}
                </span>
                <button
                  type="button"
                  data-testid="remove-attachment"
                  aria-label={`Remove ${a.file.name}`}
                  className="ml-0.5 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => removeAttachment(a.localId)}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <PromptInputTextarea
          ref={textareaRef}
          placeholder='Message mars… (Enter to send, Shift+Enter for newline)'
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => {
            const trimmed = text.trimStart()
            const shouldShow = trimmed.startsWith('/') && !trimmed.includes(' ')
            setShowPalette(shouldShow)
            if (shouldShow) setActiveIndex(0)
          }}
          onBlur={() => setTimeout(() => setShowPalette(false), 150)}
          disabled={isDisabled}
        />

        <PromptInputToolbar>
          <PromptInputTools>
            {/* Attach button */}
            <PromptInputButton
              data-testid="attach-btn"
              aria-label="Attach file"
              title="Attach image, audio or video"
              disabled={disabled || isDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon className="size-4" />
            </PromptInputButton>

            {/* Mic button — hidden when Web Speech API is unavailable */}
            {speechAvailable && (
              <PromptInputButton
                data-testid="mic-btn"
                aria-label={micActive ? 'Stop dictation' : 'Start dictation'}
                title={micActive ? 'Click to stop dictation' : 'Dictate into the composer'}
                className={micActive ? 'text-destructive hover:text-destructive' : undefined}
                onClick={() => void handleMicToggle()}
              >
                {micActive ? <SquareIcon className="size-4" /> : <MicIcon className="size-4" />}
              </PromptInputButton>
            )}
          </PromptInputTools>

          {/* Show Stop (and optionally Pause) while a reply streams / the thread runs; Send otherwise. */}
          {isBusy && !isPending ? (
            <>
              {canPause && (
                <PromptInputButton
                  data-testid="pause-btn"
                  aria-label="Pause"
                  variant="outline"
                  onClick={() => onPause?.()}
                >
                  <PauseIcon className="size-4" />
                  Pause
                </PromptInputButton>
              )}
              <PromptInputButton
                data-testid="stop-btn"
                aria-label="Stop"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => onStop?.()}
              >
                <SquareIcon className="size-4" />
                Stop
              </PromptInputButton>
            </>
          ) : (
            <PromptInputSubmit
              type="button"
              data-testid="send-btn"
              status={isUploading ? 'submitted' : undefined}
              disabled={disabled || isDisabled || (text.trim().length === 0 && attachments.length === 0)}
              onClick={handleSend}
            />
          )}
        </PromptInputToolbar>
      </div>

      {threadTokens != null && threadTokens > 0 && (
        <p
          data-testid="thread-token-count"
          className="mt-1 font-mono text-[10px] text-muted-foreground"
        >
          {threadTokens.toLocaleString()} tokens
        </p>
      )}

      {(sendError || localSendError) && (
        <p
          role="alert"
          data-testid="composer-send-error"
          className="mt-1 text-[10px] text-destructive"
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

interface ThreadSidebarProps {
  selectedId: string | null
  projectId?: string
  onSelect: (id: string) => void
  query?: string
  onQueryChange?: (q: string) => void
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
  query = '',
  onQueryChange,
}: ThreadSidebarProps) => {
  const qc = useQueryClient()

  const { data, isPending } = useQuery({
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

  // Visible chat threads (delete-pending rows stay hidden), filtered to open
  // threads only (resolved projections evaporate), title-searched, then sorted
  // by urgency → age → id. Alerts live on the top-bar Bell, not here.
  // Computed above startDelete so the delete handler can advance the selection
  // to the next thread in this exact sorted order.
  const visibleThreads = (data ?? []).filter((t) => !hiddenIds.includes(t.id))
  const openThreads = filterOpen(visibleThreads)
  const threads = sortByUrgencyThenAge(filterThreadsByTitle(openThreads, query))

  const startDelete = useCallback(
    (thread: ChatThread) => {
      flushPending()
      const p: PendingThreadDelete = {
        id: thread.id,
        title: thread.title || 'New thread',
        wasSelected: selectedId === thread.id,
      }
      setHiddenIds((prev) => [...prev, p.id])
      if (p.wasSelected) {
        const idx = threads.findIndex((t) => t.id === thread.id)
        const next = threads[idx + 1] ?? threads[idx - 1]
        onSelect(next?.id ?? '')
      }
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
    [flushPending, selectedId, onSelect, commitDelete, threads],
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

  const { data: historyData } = useQuery({
    queryKey: ['chat-history', projectId],
    queryFn: () => fetchChatHistory(projectId),
  })

  const historyThreads = historyData ?? []

  return (
    <aside className="flex w-64 flex-shrink-0 flex-col border-r border-primary/30 bg-background">
      <div className="border-b border-primary/30 px-2 py-2">
        <button
          type="button"
          className="w-full rounded border border-primary/30 px-2 py-1 font-mono text-[11px] text-primary hover:bg-primary/20 hover:text-foreground"
          onClick={() => create()}
        >
          + New thread
        </button>
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder="Search…"
          aria-label="Search threads"
          data-testid="thread-search"
          className="mt-2 w-full border border-primary/30 bg-background px-2 py-1 font-mono text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1 py-1 space-y-0.5">
        {isPending ? (
          <SkeletonList
            rows={3}
            rowClassName="mx-2 h-7 mb-1"
            label="Loading threads"
          />
        ) : threads.length === 0 ? (
          <p
            className="px-2 py-3 font-mono text-[10px] text-primary/40"
            data-testid="empty-rail"
          >
            {query.trim() ? 'No matches' : "You're all clear"}
          </p>
        ) : null}
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

        {historyThreads.length > 0 && (
          <details data-testid="chat-history-section" className="mt-2">
            <summary className="cursor-pointer px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-primary/40 hover:text-primary/60">
              History
            </summary>
            <div className="space-y-0.5 pt-0.5">
              {historyThreads.map((t) => (
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
          </details>
        )}
      </div>

      {/* Agent configuration — read-only view of the model, system prompt,
          tools, skills, and MCP servers backing every conversation. */}
      <div className="border-t border-primary/30 px-2 py-2">
        <AgentConfigPanel projectId={projectId} />
      </div>

      {/* Delete toast — the row is already gone on screen; the request is not sent
          until the undo window closes. Fixed so it never shifts the sidebar. */}
      {toast !== null && (
        <div
          data-testid="thread-delete-undo-toast"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 border border-primary/40 bg-background px-4 py-2 font-mono text-[11px] text-foreground shadow-lg"
        >
          {toast.kind === 'pending' ? (
            <>
              <span className="max-w-[280px] truncate">Deleted “{toast.title}”</span>
              <button
                type="button"
                onClick={undoDelete}
                className="border border-primary/40 px-2 py-0.5 font-mono text-[10px] uppercase text-primary transition hover:bg-primary/10 active:scale-[0.97]"
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
                className="border border-primary/40 px-2 py-0.5 font-mono text-[10px] uppercase text-primary transition hover:bg-primary/10 active:scale-[0.97]"
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
  const { projects, setFocusedProjectId } = useFocusedProject()
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readAqStateFromUrl().thread)
  // Projection-Thread selection (an action-queue item id) plus the sidebar
  // filter state — all three restore from the chat URL hash on F5.
  const [selectedQueueItemId, setSelectedQueueItemId] = useState<string | null>(
    () => readAqStateFromUrl().item,
  )
  const [query, setQuery] = useState<string>(() => readAqStateFromUrl().q)
  const [prefill, setPrefill] = useState<string | undefined>(undefined)
  // Client-only "What happened today?" delta view. Shown inline (no modal) in
  // place of the hero empty state; cleared when the user navigates to any
  // thread/item. Also triggered by the idle-return hook when the operator comes
  // back after 5+ minutes away so they see a summary without any blocking dialog.
  const [whatHappenedActive, setWhatHappenedActive] = useState(false)
  // Placeholder delta — replaced by a real API fetch in a later slice. Kept
  // here so ChatHero renders with an empty state until the data layer lands.
  const [heroDelta] = useState<HeroDelta>({
    merges: [],
    recoveries: [],
    recipes: [],
    throttles: [],
    evaporated: [],
  })

  // Idle-return detection: when the page becomes visible again after being
  // hidden for 5+ minutes, show the delta inline so the operator sees a recap
  // without any modal blocking the composer. Replaces the old #/release-notes
  // hash-triggered modal flow.
  const hiddenAtRef = useRef<number | null>(null)
  useEffect(() => {
    const IDLE_MS = 5 * 60 * 1000 // 5 minutes
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return
      if (document.hidden) {
        hiddenAtRef.current = Date.now()
      } else if (hiddenAtRef.current !== null) {
        const elapsed = Date.now() - hiddenAtRef.current
        hiddenAtRef.current = null
        if (elapsed >= IDLE_MS && !selectedThreadId && !selectedQueueItemId) {
          setWhatHappenedActive(true)
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Capture the epoch ms when this ChatPage first mounts so the right rail can
  // keep its tasks and ADRs scoped to this operator session.
  const sessionStartedAt = useRef(Date.now()).current
  const qc = useQueryClient()

  // Live queue rows + resolved-rows archive back the main-pane detail / resolved
  // views (still reachable from the hero's alert preview). The chat sidebar no
  // longer surfaces the action queue.
  const { items: queueItems } = useActionQueue()
  const { items: historyItems } = useActionQueueHistory()

  // Task snapshot used to surface blocked tasks that are not yet projected into
  // the action queue (e.g. tasks waiting on a blocker that hasn't failed yet).
  const { snapshot: taskSnapshot } = useTasks()

  const sessionTaskIds = useMemo(
    () =>
      taskSnapshot
        ? Object.values(taskSnapshot.columns)
            .flat()
            .filter((task) => Date.parse(task.createdAt) >= sessionStartedAt)
            .map((task) => task.id)
        : [],
    [taskSnapshot, sessionStartedAt],
  )

  // Threads at the root so a deep-linked queue item can resolve to its merged
  // alert-origin conversation. React Query dedupes this against the sidebar's
  // identical query — no extra request.
  const { data: threadsData } = useQuery({
    queryKey: ['chat-threads', projectId],
    queryFn: () => fetchChatThreads(projectId),
  })

  // The history endpoint is the daemon's evaporated-thread projection for the
  // current session. Render it in the feed immediately above the active Subject.
  const { data: pastThreads = [] } = useQuery({
    queryKey: ['chat-history', projectId],
    queryFn: () => fetchChatHistory(projectId),
    staleTime: 30_000,
  })

  // Thread detail for the active thread, shared with ContextRail so the Focus
  // panel can display the title and status. React Query dedupes this against
  // ChatConversation's identical query — no extra network request.
  const { data: activeThreadDetail } = useQuery<ChatThreadDetail>({
    queryKey: ['chat-thread', selectedThreadId, projectId],
    queryFn: () => fetchChatThread(selectedThreadId!, projectId),
    enabled: !!selectedThreadId,
    staleTime: 30_000,
  })
  const activeIsStreaming = activeThreadDetail?.thread.status !== 'idle'

  const threadAttachments = useMemo(
    () =>
      activeThreadDetail?.messages.flatMap((message) =>
        message.segments.filter((segment): segment is ChatSegmentAttachment => segment.type === 'attachment'),
      ) ?? [],
    [activeThreadDetail],
  )

  const { data: sessionAdrs = [] } = useQuery({
    queryKey: ['project-adrs', projectId, sessionStartedAt],
    queryFn: () => fetchSessionAdrs(sessionStartedAt, projectId ?? undefined),
    staleTime: 30_000,
  })

  const { data: projectMeta = { vision: null, theme: null } } = useQuery({
    queryKey: ['project-context', projectId],
    queryFn: () => fetchProjectMeta(projectId ?? undefined),
    staleTime: 120_000,
  })

  // Live buffer lifted from ChatConversation for the ContextRail activity panel.
  // Resets to null whenever the selected thread changes (ChatConversation remounts
  // with key={selectedThreadId} and fires onLiveBufferChange(null) on mount).
  const [activeLiveBuffer, setActiveLiveBuffer] = useState<LiveBuffer | null>(null)

  // Debounced URL write-back — mirrors selection, kind filter, and search so
  // F5 restores the exact view. Uses replaceState (no hashchange event) to
  // avoid disturbing the app-level hash router.
  const urlWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (urlWriteTimerRef.current !== null) clearTimeout(urlWriteTimerRef.current)
    urlWriteTimerRef.current = setTimeout(() => {
      writeAqStateToUrl({ item: selectedQueueItemId, kind: 'all', q: query, thread: selectedThreadId, project: projectId ?? null })
    }, 300)
    return () => {
      if (urlWriteTimerRef.current !== null) clearTimeout(urlWriteTimerRef.current)
    }
  }, [selectedQueueItemId, query, selectedThreadId])

  // Sync thread selection from the URL on `hashchange` so a cross-page
  // navigation (e.g. pulling an Alert into a thread from the Bell, which sets
  // `#/chat?thread=<id>`) selects the thread even when ChatPage is already
  // mounted. Own selection writes use replaceState (no event), so this never
  // loops; guarding on a present thread id keeps the existing "click Chat nav"
  // behaviour unchanged.
  useEffect(() => {
    const onHashChange = () => {
      const { thread } = readAqStateFromUrl()
      if (thread) {
        setSelectedThreadId(thread)
        setSelectedQueueItemId(null)
        setWhatHappenedActive(false)
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Hydrate focused project from the URL's ?project= param once the project
  // list has loaded. This makes shareable links (/#/chat?project=<id>&thread=<id>)
  // land on the right project context even if localStorage has a different one.
  const urlProjectApplied = useRef(false)
  useEffect(() => {
    if (urlProjectApplied.current || projects.length === 0) return
    urlProjectApplied.current = true
    const { project } = readAqStateFromUrl()
    if (project && projects.some((p) => p.projectId === project)) {
      setFocusedProjectId(project)
    }
  }, [projects, setFocusedProjectId])

  // Selection is exclusive: a conversation or a projection Thread, never both.
  const handleSelectThread = useCallback((id: string) => {
    setSelectedThreadId(id || null)
    setSelectedQueueItemId(null)
    setWhatHappenedActive(false)
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

  // Create a new thread, upload any selected attachments, and post the first
  // message in one gesture — used by the hero composer and projection Threads.
  // Files are uploaded AFTER thread creation (the id is required for the upload
  // endpoint). On failure nothing is cleared; the caller's clearState callback
  // is only invoked on success.
  const [sendError, setSendError] = useState<string | null>(null)
  const { mutate: createAndSend, isPending: isCreatingThread } = useMutation({
    mutationFn: async ({ message, files }: { message: string; files: File[] }) => {
      const thread = await createChatThread(projectId)
      let uploadedAttachments: AttachmentInfo[] | undefined
      if (files.length > 0) {
        uploadedAttachments = await Promise.all(
          files.map((f) => uploadAttachment(thread.id, f, projectId)),
        )
      }
      await postChatMessage(thread.id, message, projectId, uploadedAttachments)
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

  // Global Codex auth state — one banner covers all throttled threads.
  const { data: codexAuthState } = useQuery({
    queryKey: ['codex-auth', projectId],
    queryFn: () => fetchCodexAuthState(projectId),
    refetchInterval: 30_000,
  })
  const { mutate: retryCodexAuth } = useMutation({
    mutationFn: () => refreshCodexAuth(projectId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['codex-auth'] }),
  })

  // Tracks the thread opened inline beneath the opening block when the user
  // clicks a next-move chip. Kept separate from selectedThreadId so the
  // opening block is never unmounted.
  const [activeSubjectThreadId, setActiveSubjectThreadId] = useState<string | null>(null)

  // Opens a Subject inline when a chip is picked. Arc-failed rows (alerts)
  // reuse the daemon-deduped thread via startThreadFromAlert; other rows get
  // a fresh generic thread.
  const handleOpenSubject = useCallback(async (row: ActionQueueItem) => {
    let threadId: string
    if (row.kind === 'arc-failed') {
      const result = await startThreadFromAlert(row.entityId)
      threadId = result.threadId
    } else {
      const thread = await createChatThread(projectId)
      threadId = thread.id
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
    }
    setActiveSubjectThreadId(threadId)
  }, [projectId, qc])

  // Seeded opening message: when actionable items exist show a compact,
  // grouped queue summary so the operator sees real pending work at a glance.
  // Supplement action-queue rows with tasks that have status 'blocked' and are
  // not already represented by a queue item (matched by entityId). This ensures
  // the opening never falsely claims "nothing's pressing" when blocked tasks
  // are waiting for attention.
  const blockedTaskRows: DisplayRow[] = (taskSnapshot?.columns.in_progress ?? [])
    .filter((t) => t.status === 'blocked')
    .filter((t) => !queueItems.some((q) => q.entityId === t.id))
    .map((t) => ({
      id: t.id,
      kind: 'blocked',
      title: t.title,
      humanSummary: 'Waiting on a blocker task.',
    }))
  const openingRows: DisplayRow[] = [...queueItems, ...blockedTaskRows]
  const hasActionableItems = openingRows.length > 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Global Codex auth banner — one banner for all throttled threads */}
      {codexAuthState?.needsAuth && (
        <div
          data-testid="codex-auth-banner"
          className="flex items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2 font-mono text-[11px] text-warn"
        >
          <span>Codex sign-in required — all threads are paused.</span>
          <button
            type="button"
            className="ml-auto border border-warn/40 px-2 py-0.5 text-[10px] uppercase hover:bg-warn/10 active:scale-[0.97]"
            onClick={() => retryCodexAuth()}
          >
            Re-authenticate
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Thread sidebar — in-flow on md+, hidden on mobile with overlay sheet */}
      {isMdScreen && (
        <ThreadSidebar
          selectedId={selectedThreadId}
          projectId={projectId}
          onSelect={handleSelectThread}
          query={query}
          onQueryChange={setQuery}
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
              query={query}
              onQueryChange={setQuery}
            />
          </div>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar — hamburger button */}
        {!isMdScreen && (
          <div className="flex items-center border-b border-primary/30 px-3 py-2">
            <button
              type="button"
              aria-label="Open sidebar"
              onClick={() => setSidebarOpen(true)}
              className="mr-3 font-mono text-[16px] text-primary hover:text-foreground"
            >
              ☰
            </button>
          </div>
        )}
        {selectedThreadId ? (
          <ChatConversation
            key={selectedThreadId}
            threadId={selectedThreadId}
            projectId={projectId}
            prefill={prefill}
            onPrefillConsumed={() => setPrefill(undefined)}
            onInsertPrompt={handleInsertPrompt}
            onLiveBufferChange={setActiveLiveBuffer}
          />
        ) : queueSelectionResolved ? (
          <div
            data-testid="resolved-pane"
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <p className="font-mono text-[13px] text-foreground">This item has been resolved.</p>
            <p className="font-mono text-[11px] text-primary">
              It was removed from the action queue.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                className="border border-primary/40 px-3 py-1 font-mono text-[11px] text-primary hover:bg-primary/10"
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
                className="border border-primary/40 px-3 py-1 font-mono text-[11px] text-primary hover:bg-primary/10"
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
                onSendOverride={(msg, clearText) => createAndSend({ message: msg, files: [] }, { onSuccess: () => clearText() })}
                sendPending={isCreatingThread}
                sendError={sendError}
              />
            )}
          </>
        ) : whatHappenedActive ? (
          <ChatHero delta={heroDelta} onBack={() => setWhatHappenedActive(false)} />
        ) : (
          // Seeded feed: Mars speaks first. No hero screen — the feed is
          // already populated on first paint.
          <div className="flex h-full flex-col" data-testid="seeded-feed">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div
                data-testid="mars-opening-message"
                className="flex flex-col gap-1"
              >
                <span className="font-mono text-[11px] text-primary">mars</span>
                {!selectedThreadId && hasActionableItems ? (
                  <OpeningNextMoves
                    rows={openingRows}
                    onPick={(row) => {
                      if (row.kind === 'blocked') {
                        // Blocked tasks are not in the action queue; navigate to
                        // the task detail page so the operator can inspect the
                        // blocker chain and decide what to do next.
                        window.location.hash = taskHash(row.id, 'chat')
                        return
                      }
                      // Real queue rows open their Subject inline, in the same
                      // scroll, so the opening block is never unmounted.
                      const item = queueItems.find((q) => q.id === row.id)
                      if (item) void handleOpenSubject(item)
                    }}
                  />
                ) : (
                  <p className="font-mono text-[14px] text-foreground">
                    Nothing&apos;s pressing right now — what would you like to
                    work on?
                  </p>
                )}
              </div>
              <PastSubjectsColumn pastThreads={pastThreads} projectId={projectId} />
              {activeSubjectThreadId && (
                <div
                  data-testid="active-subject"
                  data-thread-id={activeSubjectThreadId}
                  className="mt-4 flex flex-col"
                >
                  <ChatConversation
                    key={activeSubjectThreadId}
                    threadId={activeSubjectThreadId}
                    projectId={projectId}
                    onPrefillConsumed={() => {}}
                    onInsertPrompt={handleInsertPrompt}
                    onLiveBufferChange={setActiveLiveBuffer}
                  />
                </div>
              )}
            </div>
            {!activeSubjectThreadId && (
              <div className="flex justify-center px-6 pb-6">
                <HeroComposer
                  onSend={(msg, files, clearState) =>
                    createAndSend({ message: msg, files }, { onSuccess: () => clearState() })
                  }
                  isPending={isCreatingThread}
                  prefill={prefill}
                  onPrefillConsumed={() => setPrefill(undefined)}
                />
              </div>
            )}
            {sendError && (
              <p
                role="alert"
                data-testid="hero-send-error"
                className="pb-2 text-center font-mono text-[11px] text-red-400"
              >
                {sendError}
              </p>
            )}
          </div>
        )}
      </div>

      <ContextRail
        projectId={projectId}
        tasks={sessionTaskIds}
        files={threadAttachments}
        adrs={sessionAdrs}
        meta={projectMeta}
        threadId={selectedThreadId ?? undefined}
        activeThreadId={selectedThreadId ?? undefined}
        threadDetail={activeThreadDetail}
        isStreaming={activeIsStreaming}
        liveBuffer={activeLiveBuffer}
        sessionStartedAt={sessionStartedAt}
        onInsertPrompt={handleInsertPrompt}
        collapsed={railCollapsed}
        onToggleCollapse={() => setRailCollapsed((v) => !v)}
      />
      </div>
    </div>
  )
}
