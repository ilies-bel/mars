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
  createChatThread,
  postChatMessage,
  renameChatThread,
  deleteChatThread,
} from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { ChatThread, ChatMessage, ChatSegmentToolUse, ChatSegmentAlert } from '@/shared/schemas'
import { ContextRail } from '@/widgets/chat/ContextRail'

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
// Segment grouping helpers
// ---------------------------------------------------------------------------

type ToolGroup = { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
type FlatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | ToolGroup
  | { kind: 'alert'; alert: ChatSegmentAlert }

/**
 * Collapses consecutive tool_use segments into a single ToolGroup so the UI
 * can render them as a collapsible activity row.
 */
export const groupMessageSegments = (msg: ChatMessage): FlatSegment[] => {
  const out: FlatSegment[] = []
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
      currentTools.push(seg)
    } else {
      flushTools()
      if (seg.type === 'text') {
        out.push({ kind: 'text', text: seg.text })
      } else if (seg.type === 'alert') {
        out.push({ kind: 'alert', alert: seg })
      } else {
        // thinking
        out.push({ kind: 'thinking', text: seg.text })
      }
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
  onDiscuss: () => void
}) => {
  const isResolved = alert.resolved ?? false

  const buttonClass = (style: 'primary' | 'destructive' | 'default') => {
    const base = 'rounded px-3 py-1 font-mono text-[11px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
    if (style === 'primary') return `${base} border-accent/60 bg-accent/20 text-accent hover:bg-accent/30`
    if (style === 'destructive') return `${base} border-red-400/40 bg-red-900/10 text-red-400 hover:bg-red-900/20`
    return `${base} border-iron/30 text-iron hover:bg-iron/20`
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
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Discuss button */}
      <button
        type="button"
        className="rounded border border-iron/30 px-2 py-0.5 font-mono text-[10px] text-iron hover:bg-iron/20"
        onClick={onDiscuss}
      >
        Discuss…
      </button>
    </div>
  )
}

/** A single chat message rendered with segment grouping. */
const ChatMessageBubble = ({ msg }: { msg: ChatMessage }) => {
  const segments = groupMessageSegments(msg)
  const isUser = msg.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-4 py-1`}>
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
                // Discuss button: focus composer — no-op for now since the
                // composer is in a parent component; a future pass can wire
                // this via a context or callback prop.
                onDiscuss={() => {}}
              />
            )
          }
          if (seg.kind === 'thinking') {
            return <ThinkingBlock key={i} text={seg.text} />
          }
          return <ToolActivityGroup key={i} tools={seg.tools} />
        })}
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => {
    setDraft(thread.title ?? 'New thread')
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

  const title = thread.title ?? 'New thread'

  if (confirmDelete) {
    return (
      <div className="flex flex-col gap-1 rounded border border-red-400/30 bg-red-900/10 p-2 text-[11px]">
        <span className="font-mono text-iron">Delete &ldquo;{title}&rdquo;?</span>
        <div className="flex gap-1">
          <button
            type="button"
            className="flex-1 rounded border border-red-400/40 px-2 py-0.5 font-mono text-[10px] text-red-400 hover:bg-red-900/20"
            onClick={() => { setConfirmDelete(false); onDelete() }}
          >
            Delete
          </button>
          <button
            type="button"
            className="flex-1 rounded border border-iron/30 px-2 py-0.5 font-mono text-[10px] text-iron hover:bg-iron/20"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

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
            className="hidden flex-none rounded px-1 py-0.5 text-[10px] text-iron/50 hover:bg-red-900/20 hover:text-red-400 group-hover:block"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true) }}
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
// Message list
// ---------------------------------------------------------------------------

interface MessageListProps {
  threadId: string
  projectId?: string
}

const MessageList = ({ threadId, projectId }: MessageListProps) => {
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['chat-thread', threadId, projectId],
    queryFn: () => fetchChatThread(threadId, projectId),
    refetchInterval: (q) => {
      // Poll faster while a response is running.
      const status = q.state.data?.thread.status
      return status === 'running' ? 2000 : false
    },
  })

  // Scroll to bottom when new messages arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [data?.messages.length])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-iron/50 font-mono text-[11px]">
        Loading…
      </div>
    )
  }

  const messages = data?.messages ?? []

  if (messages.length === 0) {
    return null
  }

  return (
    <div className="flex-1 overflow-y-auto py-3">
      {messages.map((msg) => (
        <ChatMessageBubble key={msg.id} msg={msg} />
      ))}
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
        <button
          type="button"
          className="flex-none rounded border border-iron/40 px-3 py-2 font-mono text-[11px] text-iron transition-colors hover:bg-iron/20 hover:text-fg active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          onClick={handleSend}
          disabled={isDisabled || text.trim().length === 0}
        >
          Send
        </button>
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

const ThreadSidebar = ({ selectedId, projectId, onSelect }: ThreadSidebarProps) => {
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

  const { mutate: remove } = useMutation({
    mutationFn: (id: string) => deleteChatThread(id, projectId),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: ['chat-threads'] })
      if (selectedId === id) onSelect('')
    },
  })

  // Alert-origin unresolved threads sort to the top; everything else retains
  // server order (already sorted by updated_at desc from the backend).
  const threads = (data ?? []).slice().sort((a, b) => {
    const aAlert = a.origin === 'alert' && !a.alertResolved ? 0 : 1
    const bAlert = b.origin === 'alert' && !b.alertResolved ? 0 : 1
    return aAlert - bAlert
  })

  return (
    <aside className="flex w-52 flex-col border-r border-iron/30 bg-bg">
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
            onDelete={() => remove(t.id)}
          />
        ))}
      </div>
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

  const { data: threadDetail } = useQuery({
    queryKey: ['chat-thread', selectedThreadId, projectId],
    queryFn: () => fetchChatThread(selectedThreadId!, projectId),
    enabled: selectedThreadId !== null,
    refetchInterval: (q) => {
      const status = q.state.data?.thread.status
      return status === 'running' ? 2000 : false
    },
  })

  const isRunning = threadDetail?.thread.status === 'running'
  const hasMessages = (threadDetail?.messages.length ?? 0) > 0

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

      <div className="flex flex-1 flex-col overflow-hidden">
        {selectedThreadId ? (
          <>
            {hasMessages ? (
              <MessageList threadId={selectedThreadId} projectId={projectId} />
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
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <p className="font-mono text-[13px] text-iron/50">
              Select or create a thread to start chatting
            </p>
          </div>
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
