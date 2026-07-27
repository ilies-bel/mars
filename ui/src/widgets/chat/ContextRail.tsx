/**
 * ContextRail — collapsible right-hand panel on ChatPage.
 *
 * Stacked panels:
 *   - Focus           : the active thread's title and status chip.
 *   - Session context: artifacts/cards created during the current chat session
 *                      (files, created task chips) plus the project vision from
 *                      VISION.md. This is the primary panel, open by default.
 *   - Glossary        : searchable term list from /api/glossary; definition +
 *                       avoid-aliases on expand.
 *   - Skills          : list from /api/skills; clicking a skill inserts its slash
 *                       prompt into the composer via `onInsertPrompt`.
 *
 * The rail is responsive via a controlled `collapsed` prop: callers render an
 * icon strip at narrow widths and restore the full rail at wider ones.
 * Panels lazy-load and degrade gracefully when the daemon is unreachable.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchGlossary, fetchSkills, fetchAdrs, fetchChatThread, fetchVision } from '@/shared/api'
import { SkeletonList } from '@/components/Skeleton'
import { parseCreatedTaskIds } from './parseCreatedTaskIds'
import { useThreadFocus } from './useThreadFocus'

import type { GlossaryTerm, Skill, ChatSegmentAttachment, AdrEntry, ChatThreadDetail, ProgressTask } from '@/shared/schemas'
import type { ThreadFocusResult } from './useThreadFocus'

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

/**
 * Status chip label and colour.
 */
const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  queued: { label: 'queued', className: 'text-status-queued/80' },
  running: { label: 'running', className: 'text-status-running' },
  verifying: { label: 'verifying', className: 'text-status-verifying' },
  merging: { label: 'merging', className: 'text-success/80' },
  'vega-reconciling': { label: 'reconciling', className: 'text-warn' },
  failed: { label: 'failed', className: 'text-error' },
  blocked: { label: 'blocked', className: 'text-muted-foreground' },
  under_investigation: { label: 'investigating', className: 'text-warn' },
  draft: { label: 'draft', className: 'text-muted-foreground' },
  idle: { label: 'idle', className: 'text-muted-foreground/60' },
  throttled: { label: 'throttled', className: 'text-warn' },
}

const statusChip = (status: string) =>
  STATUS_CHIP[status] ?? { label: status, className: 'text-muted-foreground' }

// ---------------------------------------------------------------------------
// Focus panel — shows the active thread title and status
// ---------------------------------------------------------------------------

interface FocusPanelProps {
  threadDetail?: ChatThreadDetail | null
  isStreaming?: boolean
  focusResult?: ThreadFocusResult
}

const FocusPanel = ({ threadDetail, isStreaming, focusResult }: FocusPanelProps) => {
  // Linked entity: render kind badge + entity title + optional status chip.
  if (focusResult && focusResult.kind !== 'none' && focusResult.entity) {
    const { kind, entity, sourceLabel } = focusResult

    if ('cluster' in entity) {
      // ProgressTask entity
      const task = entity as ProgressTask
      const chip = statusChip(task.status)
      return (
        <div className="flex flex-col gap-1 px-3 py-2">
          <span
            className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60"
            data-testid="focus-panel-kind-badge"
          >
            {kind}
          </span>
          <span
            className="font-mono text-[10px] leading-snug text-foreground/80 line-clamp-2"
            data-testid="focus-panel-title"
          >
            {task.intent ?? task.prompt}
          </span>
          <span
            className={`font-mono text-[10px] uppercase ${chip.className}`}
            data-testid="focus-panel-status-chip"
          >
            {chip.label}
          </span>
        </div>
      )
    }

    // ActionQueueItem entity (alert or proposal)
    const badgeLabel = kind === 'proposal' ? 'proposal' : sourceLabel
    return (
      <div className="flex flex-col gap-1 px-3 py-2">
        <span
          className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60"
          data-testid="focus-panel-kind-badge"
        >
          {badgeLabel}
        </span>
        <span
          className="font-mono text-[10px] leading-snug text-foreground/80 line-clamp-2"
          data-testid="focus-panel-title"
        >
          {entity.title}
        </span>
      </div>
    )
  }

  // Fallback: unlinked thread — show thread title and status chip (slice 1 behaviour).
  if (!threadDetail) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground/60">
        No active thread
      </p>
    )
  }
  const title = threadDetail.thread.title ?? 'New thread'
  // When the client is actively streaming, show 'running' even if the server
  // hasn't updated the thread status yet.
  const status: string = isStreaming ? 'running' : threadDetail.thread.status
  const chip = statusChip(status)
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <span
        className="font-mono text-[10px] leading-snug text-foreground/80"
        data-testid="focus-panel-title"
      >
        {title}
      </span>
      <span
        className={`font-mono text-[10px] uppercase ${chip.className}`}
        data-testid="focus-panel-status-chip"
      >
        {chip.label}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project vision panel
// ---------------------------------------------------------------------------

/** Lines from VISION.md to surface as "next conversation subjects" when the
 * vision is absent or very short. Generic prompts that help the user bootstrap
 * a project vision conversation with the operator. */
const NEXT_SUBJECT_SUGGESTIONS = [
  'What is the long-term goal of this project?',
  'What are the non-goals and explicit constraints?',
  'Which open questions need a human decision before the next milestone?',
]

interface ProjectVisionPanelProps {
  projectId?: string
}

export const ProjectVisionPanel = ({ projectId }: ProjectVisionPanelProps) => {
  const [expanded, setExpanded] = useState(false)

  const { data: content, isLoading, isError } = useQuery({
    queryKey: ['vision', projectId ?? ''],
    queryFn: () => fetchVision(projectId),
    staleTime: 120_000,
  })

  if (isLoading) {
    return (
      <SkeletonList
        rows={2}
        rowClassName="mx-3 h-4 mb-1"
        label="Loading vision"
      />
    )
  }

  // Error or unavailable: surface the first next-subject suggestion so the
  // panel stays useful even without a VISION.md.
  if (isError || content === null || content === undefined || content.trim() === '') {
    return (
      <div className="px-3 py-2">
        <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-1">
          Next conversation subject
        </p>
        <ul className="flex flex-col gap-1">
          {NEXT_SUBJECT_SUGGESTIONS.map((s) => (
            <li
              key={s}
              className="font-mono text-[10px] leading-snug text-foreground/70"
              data-testid="vision-next-subject"
            >
              → {s}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // Vision available: show a trimmed excerpt with expand/collapse.
  const PREVIEW_LENGTH = 300
  const isLong = content.length > PREVIEW_LENGTH
  const displayed = expanded || !isLong ? content : content.slice(0, PREVIEW_LENGTH).trimEnd() + '…'

  return (
    <div className="px-3 py-2">
      <pre
        className="whitespace-pre-wrap font-mono text-[10px] leading-snug text-foreground/80 break-words"
        data-testid="vision-content"
      >
        {displayed}
      </pre>
      {isLong && (
        <button
          type="button"
          className="mt-1 font-mono text-[9px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
          data-testid="vision-expand-toggle"
        >
          {expanded ? 'show less' : 'show all'}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Glossary panel
// ---------------------------------------------------------------------------

const GlossaryPanel = () => {
  const [filter, setFilter] = useState('')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['glossary'],
    queryFn: fetchGlossary,
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground animate-pulse">
        Loading…
      </p>
    )
  }

  if (isError || !data) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-error/70">
        Glossary unavailable
      </p>
    )
  }

  const lowerFilter = filter.toLowerCase()
  const visible: GlossaryTerm[] = filter
    ? data.filter(
        (t) =>
          t.term.toLowerCase().includes(lowerFilter) ||
          t.definition.toLowerCase().includes(lowerFilter),
      )
    : data

  if (data.length === 0) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground/60">
        No terms defined yet
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pt-1">
        <input
          type="search"
          placeholder="Search terms…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full rounded border border-primary/30 bg-card px-2 py-1 font-mono text-[10px] text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none"
        />
      </div>
      {visible.length === 0 ? (
        <p className="px-3 py-1 font-mono text-[10px] text-muted-foreground/60">No matches</p>
      ) : (
        <ul className="flex flex-col gap-0.5 py-1">
          {visible.map((term) => (
            <li key={term.term}>
              <details className="px-2">
                <summary className="cursor-pointer list-none rounded px-1 py-1 font-mono text-[10px] text-foreground hover:bg-primary/10 [&::-webkit-details-marker]:hidden">
                  {term.term}
                </summary>
                <div className="pb-1 pl-1 pr-1 pt-0.5">
                  <p className="font-mono text-[10px] leading-snug text-foreground/80">
                    {term.definition}
                  </p>
                  {term.avoid.length > 0 && (
                    <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                      avoid:{' '}
                      <span className="text-primary/60">
                        {term.avoid.join(', ')}
                      </span>
                    </p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skills panel
// ---------------------------------------------------------------------------

interface SkillsPanelProps {
  onInsertPrompt: (prompt: string) => void
}

const SkillsPanel = ({ onInsertPrompt }: SkillsPanelProps) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['skills'],
    queryFn: fetchSkills,
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground animate-pulse">
        Loading…
      </p>
    )
  }

  if (isError || !data) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-error/70">
        Skills unavailable
      </p>
    )
  }

  if (data.length === 0) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground/60">
        No skills found
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-0.5 py-1">
      {data.map((skill: Skill) => (
        <li key={skill.name}>
          <button
            type="button"
            className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-primary/10"
            onClick={() => onInsertPrompt(`/${skill.name} `)}
            title={`Insert /${skill.name} into composer`}
          >
            <span className="font-mono text-[10px] font-semibold text-foreground">
              /{skill.name}
            </span>
            {skill.description && (
              <span className="font-mono text-[10px] text-muted-foreground leading-snug">
                {skill.description.length > 80
                  ? skill.description.slice(0, 77) + '…'
                  : skill.description}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Session artifacts panel
// ---------------------------------------------------------------------------

export interface SessionArtifactsPanelProps {
  threadId?: string
  projectId?: string
}

export const SessionArtifactsPanel = ({ threadId, projectId }: SessionArtifactsPanelProps) => {
  const [showAllAdrs, setShowAllAdrs] = useState(false)

  // Fetch thread data (messages) only when a thread is selected.
  const { data: threadDetail, isLoading: threadLoading } = useQuery({
    queryKey: ['chat-thread', threadId ?? ''],
    queryFn: () => fetchChatThread(threadId!, projectId),
    enabled: !!threadId,
    staleTime: 30_000,
  })

  // ADRs are global — always fetch.
  const { data: adrsData, isLoading: adrsLoading } = useQuery({
    queryKey: ['adrs', projectId ?? ''],
    queryFn: () => fetchAdrs(projectId),
    staleTime: 60_000,
  })

  const messages = threadDetail?.messages ?? []
  const attachments: ChatSegmentAttachment[] = messages.flatMap((m) =>
    m.segments.filter((s): s is ChatSegmentAttachment => s.type === 'attachment'),
  )
  const taskIds = parseCreatedTaskIds(messages)
  const adrs: AdrEntry[] = adrsData ?? []
  const visibleAdrs = showAllAdrs ? adrs : adrs.slice(0, 5)

  return (
    <div className="flex flex-col">
      {/* --- Files --- */}
      <div className="px-3 pt-2 pb-1">
        <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-1">
          Files
        </p>
        {!threadId ? (
          <p className="font-mono text-[10px] text-muted-foreground/50">No thread selected</p>
        ) : threadLoading ? (
          <p className="font-mono text-[10px] text-muted-foreground animate-pulse">Loading…</p>
        ) : attachments.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground/50">No files uploaded</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {attachments.map((att, i) => (
              <li key={`${att.path}-${i}`} className="flex items-center gap-1">
                <span className="font-mono text-[10px] text-foreground/70 truncate" title={att.name}>
                  {att.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- Created tasks --- */}
      <div className="px-3 pt-1 pb-1">
        <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-1">
          Created tasks
        </p>
        {!threadId ? (
          <p className="font-mono text-[10px] text-muted-foreground/50">No thread selected</p>
        ) : threadLoading ? (
          <p className="font-mono text-[10px] text-muted-foreground animate-pulse">Loading…</p>
        ) : taskIds.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground/50">No tasks created</p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {taskIds.map((id) => (
              <li key={id}>
                <a
                  href={`#/task/${encodeURIComponent(id)}?from=chat`}
                  className="inline-block rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80 hover:bg-primary/30 transition-colors"
                  title={id}
                  data-testid="session-artifacts-task-chip"
                >
                  {id}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- ADRs --- */}
      <div className="px-3 pt-1 pb-2">
        <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-1">
          Recent ADRs
        </p>
        {adrsLoading ? (
          <p className="font-mono text-[10px] text-muted-foreground animate-pulse">Loading…</p>
        ) : adrs.length === 0 ? (
          <p className="font-mono text-[10px] text-muted-foreground/50">No ADRs yet</p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {visibleAdrs.map((adr) => (
                <li key={adr.number} className="font-mono text-[10px] text-foreground/80 leading-snug">
                  <span className="text-muted-foreground/60 mr-1">#{adr.number}</span>
                  <span className="line-clamp-1" title={adr.title}>
                    {adr.title}
                  </span>
                </li>
              ))}
            </ul>
            {adrs.length > 5 && (
              <button
                type="button"
                className="mt-1 font-mono text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAllAdrs((v) => !v)}
                data-testid="session-artifacts-adrs-toggle"
              >
                {showAllAdrs ? 'show less' : `show all (${adrs.length})`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel section wrapper
// ---------------------------------------------------------------------------

interface PanelSectionProps {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}

const PanelSection = ({ title, defaultOpen = true, children }: PanelSectionProps) => {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-b border-primary/20">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="text-[9px]">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ContextRail root
// ---------------------------------------------------------------------------

export interface ContextRailProps {
  projectId?: string
  /** The currently selected chat thread. Used to scope session-artifact data. */
  threadId?: string
  /** The id of the active thread (used to gate Focus panel display). */
  activeThreadId?: string
  /** Thread detail for the active thread, including title and status. */
  threadDetail?: ChatThreadDetail | null
  /** True when the client is actively streaming a reply for the active thread. */
  isStreaming?: boolean
  /** Epoch ms when the current chat session started (unused after removing Live
   * tasks panel; kept in props for API stability while callers adapt). */
  sessionStartedAt: number
  /** Called when a skill row is clicked; inserts the prompt into the composer. */
  onInsertPrompt: (prompt: string) => void
  /** When true the rail collapses to a narrow icon strip. */
  collapsed?: boolean
  /** Callback to toggle the collapsed state from outside. */
  onToggleCollapse?: () => void
}

export const ContextRail = ({
  projectId,
  threadId,
  activeThreadId,
  threadDetail,
  isStreaming,
  onInsertPrompt,
  collapsed = false,
  onToggleCollapse,
}: ContextRailProps) => {
  const focusResult = useThreadFocus(threadDetail?.thread)
  if (collapsed) {
    return (
      <aside
        className="flex w-8 flex-shrink-0 flex-col items-center border-l border-primary/30 bg-background py-2 gap-3"
        aria-label="Context rail (collapsed)"
      >
        <button
          type="button"
          className="rounded p-1 font-mono text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-foreground transition-colors"
          onClick={() => onToggleCollapse?.()}
          title="Expand context rail"
          aria-label="Expand context rail"
        >
          ◂
        </button>
      </aside>
    )
  }

  return (
    <aside
      className="flex w-56 flex-shrink-0 flex-col border-l border-primary/30 bg-background overflow-y-auto"
      aria-label="Context rail"
    >
      <div className="flex items-center justify-between border-b border-primary/20 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Context
        </span>
        <button
          type="button"
          className="rounded p-0.5 font-mono text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-foreground transition-colors"
          onClick={() => onToggleCollapse?.()}
          title="Collapse context rail"
          aria-label="Collapse context rail"
        >
          ▸
        </button>
      </div>

      <PanelSection title="Focus" defaultOpen={true}>
        <FocusPanel
          threadDetail={activeThreadId ? threadDetail : null}
          isStreaming={isStreaming}
          focusResult={activeThreadId ? focusResult : undefined}
        />
      </PanelSection>

      <PanelSection title="Session artifacts" defaultOpen={true}>
        <SessionArtifactsPanel threadId={threadId} projectId={projectId} />
      </PanelSection>

      <PanelSection title="Project vision" defaultOpen={true}>
        <ProjectVisionPanel projectId={projectId} />
      </PanelSection>

      <PanelSection title="Glossary" defaultOpen={false}>
        <GlossaryPanel />
      </PanelSection>

      <PanelSection title="Skills" defaultOpen={false}>
        <SkillsPanel onInsertPrompt={onInsertPrompt} />
      </PanelSection>
    </aside>
  )
}
