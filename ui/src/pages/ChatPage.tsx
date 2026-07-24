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
  fetchActionQueue,
  createChatThread,
  postChatMessage,
  uploadAttachment,
  renameChatThread,
  deleteChatThread,
  setMessageFeedback,
  clearMessageFeedback,
  ApiError,
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { ChatThread, ChatSegmentAlert, ChatSegmentAttachment, ActionQueueItem, ChatFeedback } from '@/shared/schemas'
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
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
// Loader removed — ThinkingIndicator replaces it in ChatConversation
import { Suggestions, Suggestion } from '@/components/ai-elements/suggestion'
import {
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input'
import { PaperclipIcon, MicIcon, SquareIcon, XIcon } from 'lucide-react'
import { AlertCard } from '@/widgets/chat/AlertCard'
import { ContextRail } from '@/widgets/chat/ContextRail'
import { WhileYouWereAwayPanel } from '@/widgets/WhileYouWereAwayPanel'
import { WhatHappenedTodayView } from '@/widgets/chat/WhatHappenedTodayView'
import { priorityBadgeClass } from '@/widgets/chat/QueueThreadRow'
import { QueueThreadDetail } from '@/widgets/chat/QueueThreadDetail'
import {
  filterThreadsByTitle,
  isResolvedSelection,
} from '@/widgets/chat/queueThreads'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useActionQueueHistory } from '@/entities/actionQueue/useActionQueueHistory'
import { useAlerts, useStartThreadFromAlert } from '@/entities/alerts'
import { kindBadgeLabel } from '@/shared/actionQueueDetail'
import { readAqStateFromUrl, writeAqStateToUrl } from '@/shared/actionQueueUrlState'
import { taskHash } from '@/shared/routing'
import { formatDuration } from '@/shared/time'
import { resolveMediaKind, fileMediaKind } from './chatPageUtils'

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

const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
  high: 0,
  normal: 1,
  low: 2,
}

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
          className="border border-iron/40 bg-surface p-4 text-left"
          data-testid="hero-alert-preview"
          aria-label="Most important conversation"
        >
          <div className="flex items-center gap-2 font-mono text-[10px] text-muted">
            <span aria-hidden="true" className="text-[13px]">{KIND_ICON[topAlert.kind] ?? '🔔'}</span>
            <span>Mars</span>
            <span aria-hidden="true">·</span>
            <span>{kindBadgeLabel(topAlert.kind)}</span>
            <span className={`ml-auto uppercase ${priorityBadgeClass(topAlert.priority)}`}>{topAlert.priority}</span>
          </div>
          <h2 className="mt-2 font-mono text-[14px] font-semibold text-fg">{topAlert.title}</h2>
          <p className="mt-1 line-clamp-2 font-mono text-[12px] leading-relaxed text-iron">{topAlert.body}</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="truncate font-mono text-[10px] text-muted">{topAlert.entityId}</span>
            <button
              type="button"
              data-testid="hero-alert-open"
              className="shrink-0 border border-iron/50 px-3 py-1.5 font-mono text-[10px] uppercase text-fg transition-colors hover:bg-iron/15 active:scale-[0.98]"
              onClick={() => onAlertClick(topAlert)}
            >
              Open conversation
            </button>
          </div>
        </article>
      )}

      {otherAlerts.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Other conversations needing attention">
          {otherAlerts.slice(0, 3).map((alert) => (
            <button
              key={alert.id}
              type="button"
              data-testid="hero-alert-option"
              className="flex min-w-0 max-w-full items-center gap-1.5 border border-iron/30 px-2.5 py-1.5 font-mono text-[11px] text-iron transition-colors hover:bg-iron/10 hover:text-fg active:scale-[0.98]"
              onClick={() => onAlertClick(alert)}
            >
              <span aria-hidden="true">{KIND_ICON[alert.kind] ?? '🔔'}</span>
              <span className="max-w-[220px] truncate">{alert.title}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-2">
        {WELCOME_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className="border border-iron/40 px-3 py-1.5 font-mono text-[11px] text-iron transition-colors hover:border-iron/70 hover:bg-iron/15 hover:text-fg active:scale-[0.98]"
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
          className="max-h-64 rounded border border-iron/20 object-contain"
        />
      </a>
    )
  }
  if (kind === 'audio') {
    return (
      <div className="my-1" data-testid="attachment-audio">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls src={src} className="w-full max-w-sm" />
        <p className="mt-0.5 font-mono text-[10px] text-iron/60 truncate">{attachment.name}</p>
      </div>
    )
  }
  if (kind === 'video') {
    return (
      <div className="my-1" data-testid="attachment-video">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video controls src={src} className="max-h-64 w-full rounded border border-iron/20 object-contain" />
        <p className="mt-0.5 font-mono text-[10px] text-iron/60 truncate">{attachment.name}</p>
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
 * Renders one or more tool calls as a vertical stack of AI-Elements Tool
 * blocks. Multiple tools can live in a single group when they arrived
 * consecutively in the stream (parallel tool calls).
 */
export const ToolActivityGroup = ({
  tools,
}: {
  tools: ToolActivityEntry[]
}): ReactNode => (
  <>
    {tools.map((tool) => (
      <Tool key={tool.toolUseId}>
        <ToolHeader
          type={`tool-${tool.toolName}` as ToolUIPart['type']}
          state={tool.toolState}
        />
        <ToolContent>
          <ToolInput input={tool.input} />
          <ToolOutput output={tool.output} errorText={tool.errorText} />
        </ToolContent>
      </Tool>
    ))}
  </>
)

/** Render one `UIMessage` part as its AI Element. Returns null for inert parts. */
const renderPart = (
  part: UIPart,
  key: number,
  onDiscuss: (prompt: string) => void,
): ReactNode => {
  if (part.type === 'text') {
    return <Response key={key}>{part.text}</Response>
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
  if (part.type === 'data-alert') {
    return <AlertCardFromSegment key={key} alert={part.data} />
  }
  if (part.type === 'data-attachment') {
    return <AttachmentDisplay key={key} attachment={part.data} />
  }
  if (part.type === 'data-chatError') {
    return (
      <ChatResponseError key={key} onTryAgain={() => onDiscuss('Please retry my last request.')} />
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
  onDiscuss,
  onFeedbackChange,
}: {
  message: MarsUIMessage
  onDiscuss: (prompt: string) => void
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
        {parts.map((p, i) => renderPart(p, i, onDiscuss))}
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
          the default contained pill from MessageContent variant='contained'. */}
      <MessageContent
        variant={isUser ? 'contained' : 'flat'}
        className={!isUser ? 'border border-iron/20 bg-surface px-3 py-2' : undefined}
      >
        {parts.map((p, i) => renderPart(p, i, onDiscuss))}
        <ResultFooter usage={usage} />
        {!isUser && (
          <FeedbackControls
            messageId={message.id}
            feedback={feedback}
            onFeedbackChange={handleFeedbackChange}
          />
        )}
      </MessageContent>
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
      <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-iron/50 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-iron/50 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 flex-none animate-bounce rounded-full bg-iron/50 [animation-delay:300ms]" />
    </span>
    <span className="font-mono text-[11px] text-iron/50">Thinking…</span>
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
    <MessageContent variant="flat" className="border border-iron/20 bg-surface px-3 py-2">
      {buffer.segments.length === 0 && !buffer.done ? (
        // No segments yet — show the bouncing-dot placeholder (same as ThinkingIndicator).
        <ThinkingIndicator />
      ) : (
        buffer.segments.map((seg, i) => {
          if (seg.type === 'text') {
            return <Response key={i}>{seg.text}</Response>
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
                  toolState: (
                    t.state === 'done' ? 'output-available'
                    : t.state === 'error' ? 'output-error'
                    : 'input-streaming'
                  ) as ToolUIPart['state'],
                  output: t.state === 'done' ? <ToolResultBox value={t.output} /> : undefined,
                  errorText: t.state === 'error' ? t.errorText : undefined,
                }))}
              />
            )
          }
          return null
        })
      )}
      {!buffer.done && buffer.segments.length > 0 && (
        <span
          className="ml-0.5 inline-block h-3 w-0.5 animate-pulse rounded-sm bg-fg/60"
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
    async (text: string, attachmentIds?: string[]) => {
      await sendMessage(
        { text },
        attachmentIds && attachmentIds.length > 0 ? { body: { attachmentIds } } : undefined,
      )
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
    },
    [sendMessage, qc],
  )

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

  // Suppress welcome chips while we're waiting for a reply — a brand-new
  // thread with a running/submitted state should show ThinkingIndicator, not
  // the empty-state chips.
  const showWelcome = !isLoading && messages.length === 0 && !showThinking

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
        if (part.state === 'output-available') {
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
                    onDiscuss={onInsertPrompt}
                    onFeedbackChange={handleFeedbackChange}
                  />
                )
              )}
              {showThinking && <ThinkingIndicator />}
              {error && (
                <ChatResponseError
                  onTryAgain={() => onInsertPrompt('Please retry my last request.')}
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
        disabled={serverRunning || isBusy}
        isBusy={isBusy || serverRunning}
        onSend={handleSend}
        onStop={handleStop}
        initialText={prefill}
        onInitialTextConsumed={onPrefillConsumed}
      />
    </>
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
    <div className="w-full max-w-2xl">
      {/* AI-Elements PromptInput shell (HeroComposer owns its own text state). */}
      <div className="w-full divide-y divide-border overflow-hidden rounded-2xl border bg-background shadow-sm">
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
          <PromptInputTools />
          <PromptInputSubmit
            type="button"
            data-testid="hero-send"
            status={isPending ? 'submitted' : undefined}
            disabled={isPending || text.trim().length === 0}
            onClick={handleSend}
          />
        </PromptInputToolbar>
      </div>
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
  /** Opens the client-side "What happened today?" streamed release-notes view. */
  onWhatHappened: () => void
}

/**
 * Full-pane hero shown when no thread is selected.
 *
 * Layout: headline → subtitle → large rounded composer → conversation choices.
 * The highest-priority alert is shown as a full conversation preview and the
 * next few alerts remain available as compact choices. Typing in the composer
 * and hitting Enter (or clicking Send) creates a new thread and posts the
 * first message in one gesture via the `onCreateAndSend` callback.
 */
export const HeroEmptyState = ({
  projectId,
  onSelectThread,
  onCreateAndSend,
  isPending,
  sendError,
  onOpenQueueItem,
  onWhatHappened,
}: HeroEmptyStateProps) => {
  const [prefill, setPrefill] = useState<string | undefined>(undefined)

  // Arc-rooted Alerts (ADR-0054) back the subtle "Next action" shortcut: it
  // grabs the top Alert and pulls it into a thread. `alerts[0]` mirrors the
  // daemon's `nextActionAlert` default (the derivation lists arc failures ahead
  // of stale-worktree housekeeping). Hidden when there are no alerts.
  const { alerts } = useAlerts()
  const topAlert = alerts[0] ?? null
  const { mutate: pullAlert, isPending: pullPending } = useStartThreadFromAlert()

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

  const rankedAlerts = useMemo(
    () => [...(alertItems ?? [])].sort((a, b) => {
      const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      return priority !== 0 ? priority : b.at.localeCompare(a.at)
    }),
    [alertItems],
  )

  const handleAlertClick = useCallback((alert: ActionQueueItem) => {
    const alertThread = (threads ?? []).find((t) => t.alertItemId === alert.id) ?? null
    if (alertThread) {
      onSelectThread(alertThread.id)
    } else {
      onOpenQueueItem?.(alert.id)
    }
  }, [threads, onSelectThread, onOpenQueueItem])

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
      {topAlert && (
        <button
          type="button"
          data-testid="hero-next-action"
          disabled={pullPending}
          onClick={() =>
            pullAlert(topAlert.arcId, {
              onSuccess: ({ threadId }) => onSelectThread(threadId),
            })
          }
          title={topAlert.reason}
          className="max-w-2xl truncate border border-iron/30 px-3 py-1.5 font-mono text-[11px] text-iron transition-colors hover:border-iron/60 hover:bg-iron/10 hover:text-fg active:scale-[0.98] disabled:opacity-50"
        >
          Next: {topAlert.goal}
        </button>
      )}
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
        alerts={rankedAlerts}
        onAlertClick={handleAlertClick}
        onChipClick={setPrefill}
        onWhatHappened={onWhatHappened}
      />
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
  onSend?: (text: string, attachmentIds?: string[]) => Promise<void>
  /** Stop the in-flight run. Wired to `useChat.stop` (aborts + stopChatThread). */
  onStop?: () => void
  /** True while a reply is streaming / the thread is running — shows the Stop button. */
  isBusy?: boolean
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
}: ComposerProps) => {
  const [text, setText] = useState('')
  const [showPalette, setShowPalette] = useState(false)
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
    if (initialText !== undefined) {
      setText(initialText)
      onInitialTextConsumed()
      textareaRef.current?.focus()
    }
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
      let attachmentIds: string[] | undefined
      if (attachments.length > 0 && threadId) {
        setIsUploading(true)
        try {
          const results = await Promise.all(
            attachments.map((a) => uploadAttachment(threadId, a.file, projectId)),
          )
          attachmentIds = results.map((r) => r.id)
        } finally {
          setIsUploading(false)
        }
      }
      await onSend?.(msg, attachmentIds)
    },
    onMutate: () => setLocalSendError(null),
    onSuccess: () => {
      setText('')
      setAttachments([])
      setVoiceBlob(null)
    },
    onError: (err) => setLocalSendError(sendErrorMessage(err)),
  })

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    // Allow sending with just attachments (empty text) or just text.
    if ((!trimmed && attachments.length === 0) || disabled || isPending || sendPending || isUploading) return
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
  }, [text, attachments.length, disabled, isPending, sendPending, isUploading, onSendOverride, onSend, send])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    const trimmed = value.trimStart()
    setShowPalette(trimmed.startsWith('/') && !trimmed.includes(' '))
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

  const isDisabled = disabled || isPending || sendPending || isUploading

  return (
    <div
      data-testid="composer"
      className="relative border-t border-border px-4 py-3"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {showPalette && (
        <SlashPalette
          filter={text.trimStart()}
          onSelect={handleSlashSelect}
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
          placeholder={isDisabled ? 'Running…' : 'Message mars… (Enter to send, Shift+Enter for newline)'}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => {
            const trimmed = text.trimStart()
            setShowPalette(trimmed.startsWith('/') && !trimmed.includes(' '))
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
              disabled={isDisabled}
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

          {/* Show Stop while a reply streams / the thread runs; Send otherwise. */}
          {isBusy && !isPending ? (
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
          ) : (
            <PromptInputSubmit
              type="button"
              data-testid="send-btn"
              status={isUploading ? 'submitted' : undefined}
              disabled={isDisabled || (text.trim().length === 0 && attachments.length === 0)}
              onClick={handleSend}
            />
          )}
        </PromptInputToolbar>
      </div>

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

  // Visible chat threads (delete-pending rows stay hidden), title-searched.
  // The chat sidebar is a plain list of conversation threads — alerts live on
  // the top-bar Bell, not here.
  const visibleThreads = (data ?? []).filter((t) => !hiddenIds.includes(t.id))
  const threads = filterThreadsByTitle(visibleThreads, query)

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
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder="Search…"
          aria-label="Search threads"
          data-testid="thread-search"
          className="mt-2 w-full border border-iron/30 bg-bg px-2 py-1 font-mono text-[12px] text-fg placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-iron/50"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-0.5">
        {threads.length === 0 && (
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
  const [prefill, setPrefill] = useState<string | undefined>(undefined)
  // Client-only "What happened today?" release-notes stream. Shown in place of
  // the hero empty state; cleared when the user navigates to any thread/item.
  const [whatHappenedActive, setWhatHappenedActive] = useState(false)

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

  // Live queue rows + resolved-rows archive back the main-pane detail / resolved
  // views (still reachable from the hero's alert preview). The chat sidebar no
  // longer surfaces the action queue.
  const { items: queueItems } = useActionQueue()
  const { items: historyItems } = useActionQueueHistory()

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
      writeAqStateToUrl({ item: selectedQueueItemId, kind: 'all', q: query, thread: selectedThreadId })
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

  // Selection is exclusive: a conversation or a projection Thread, never both.
  const handleSelectThread = useCallback((id: string) => {
    setSelectedThreadId(id || null)
    setSelectedQueueItemId(null)
    setWhatHappenedActive(false)
  }, [])

  const handleSelectQueueItem = useCallback((id: string) => {
    setSelectedQueueItemId(id)
    setSelectedThreadId(null)
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
          <ChatConversation
            key={selectedThreadId}
            threadId={selectedThreadId}
            projectId={projectId}
            prefill={prefill}
            onPrefillConsumed={() => setPrefill(undefined)}
            onInsertPrompt={handleInsertPrompt}
          />
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
        ) : whatHappenedActive ? (
          <WhatHappenedTodayView onBack={() => setWhatHappenedActive(false)} />
        ) : (
          <HeroEmptyState
            projectId={projectId}
            onSelectThread={handleSelectThread}
            onCreateAndSend={(msg, clearText) => createAndSend(msg, { onSuccess: () => clearText() })}
            isPending={isCreatingThread}
            sendError={sendError}
            onOpenQueueItem={handleSelectQueueItem}
            onWhatHappened={() => setWhatHappenedActive(true)}
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
