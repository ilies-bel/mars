/**
 * ContextRail — collapsible right-hand panel on ChatPage.
 *
 * Three stacked panels:
 *   - Live tasks  : non-done tasks from the existing progress view; rows
 *                   that appeared after `sessionStartedAt` get a "new" accent.
 *                   Click → `#/task/<id>?from=chat` drawer overlay.
 *   - Glossary    : searchable term list from /api/glossary; definition +
 *                   avoid-aliases on expand.
 *   - Skills      : list from /api/skills; clicking a skill inserts its slash
 *                   prompt into the composer via `onInsertPrompt`.
 *
 * The rail is responsive via a controlled `collapsed` prop: callers render an
 * icon strip at narrow widths and restore the full rail at wider ones.
 * Panels lazy-load and degrade gracefully when the daemon is unreachable.
 */

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchGlossary, fetchSkills, fetchAdrs, fetchChatThread } from '@/shared/api'
import { useProgress } from '@/hooks/useProgress'
import { SkeletonList } from '@/components/Skeleton'
import { parseCreatedTaskIds } from './parseCreatedTaskIds'

import type { GlossaryTerm, Skill, ChatSegmentAttachment, AdrEntry } from '@/shared/schemas'
import type { ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 24-hour window for retaining "done" rows in the LIVE TASKS panel. */
const DONE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Sort priority for the LIVE TASKS panel — lower number surfaces first.
 * Active statuses lead; stale "done"/"dropped" rows trail.
 */
const STATUS_PRIORITY: Record<string, number> = {
  running: 0,
  verifying: 1,
  merging: 2,
  'vega-reconciling': 3,
  queued: 4,
  draft: 5,
  blocked: 6,
  under_investigation: 7,
  failed: 8,
  done: 9,
  dropped: 10,
}

/**
 * Relative age string — keeps rows compact (e.g. "2m", "1h", "3d").
 */
const relativeAge = (isoString: string): string => {
  const diffMs = Date.now() - Date.parse(isoString)
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h`
  return `${Math.floor(diffHrs / 24)}d`
}

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
}

const statusChip = (status: string) =>
  STATUS_CHIP[status] ?? { label: status, className: 'text-muted-foreground' }

// ---------------------------------------------------------------------------
// Live tasks panel
// ---------------------------------------------------------------------------

interface LiveTasksPanelProps {
  sessionStartedAt: number
}

const LiveTasksPanel = ({ sessionStartedAt }: LiveTasksPanelProps) => {
  const { tasks, error } = useProgress()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  /**
   * Filtered + sorted task list for this panel:
   * - Drop "done"/"dropped" rows whose `updatedAt` is older than 24 h.
   * - Sort by status priority (running first), then by `updatedAt` desc
   *   within the same priority group.
   */
  const liveTasks = useMemo((): ProgressTask[] | null => {
    if (tasks === null) return null
    const cutoff = Date.now() - DONE_WINDOW_MS
    return tasks
      .filter(
        (t) =>
          t.cluster !== 'Done' || Date.parse(t.updatedAt) >= cutoff,
      )
      .sort((a, b) => {
        const pa = STATUS_PRIORITY[a.status] ?? 99
        const pb = STATUS_PRIORITY[b.status] ?? 99
        if (pa !== pb) return pa - pb
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [tasks])

  if (error) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-error/70">
        Tasks unavailable
      </p>
    )
  }

  if (liveTasks === null) {
    return (
      <SkeletonList
        rows={2}
        rowClassName="mx-3 h-11 mb-0.5"
        label="Loading tasks"
      />
    )
  }

  if (liveTasks.length === 0) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground/60">
        No active tasks
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-0.5 py-1">
      {liveTasks.map((task: ProgressTask) => {
        const isNew = Date.parse(task.createdAt) >= sessionStartedAt
        const chip = statusChip(task.status)
        const isExpanded = expandedId === task.id

        return (
          <li key={task.id}>
            <div
              className={`group flex w-full flex-col gap-0.5 rounded px-2 py-1.5 transition-colors hover:bg-primary/10 ${isNew ? 'border-l-2 border-highlight/60 pl-[6px]' : ''}`}
            >
              <span className="flex items-baseline justify-between gap-1 min-w-0">
                {/* Status chip: link to Progress page filtered by this status */}
                <a
                  href={`#/progress?q=${encodeURIComponent(chip.label)}`}
                  className={`shrink-0 font-mono text-[10px] uppercase ${chip.className} hover:underline`}
                  title={`Filter progress by ${chip.label}`}
                  aria-label={`Filter tasks by status: ${chip.label}`}
                  data-testid="context-rail-status-link"
                >
                  {chip.label}
                </a>
                {isNew && (
                  <span className="shrink-0 font-mono text-[9px] uppercase text-highlight/70">
                    new
                  </span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {relativeAge(task.createdAt)}
                </span>
              </span>
              {/* Description: click to expand/collapse; title reveals full text on hover */}
              <button
                type="button"
                className={`min-w-0 w-full break-words font-mono text-[10px] text-foreground/80 leading-snug text-left ${isExpanded ? '' : 'line-clamp-2'}`}
                onClick={() => setExpandedId(isExpanded ? null : task.id)}
                title={task.prompt}
                data-testid="context-rail-description"
                aria-expanded={isExpanded}
              >
                {task.prompt}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
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
  /** Epoch ms when the current chat session started (for "new task" highlight). */
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
  sessionStartedAt,
  onInsertPrompt,
  collapsed = false,
  onToggleCollapse,
}: ContextRailProps) => {
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

      <PanelSection title="Session artifacts" defaultOpen={false}>
        <SessionArtifactsPanel threadId={threadId} projectId={projectId} />
      </PanelSection>

      <PanelSection title="Live tasks" defaultOpen={true}>
        <LiveTasksPanel sessionStartedAt={sessionStartedAt} />
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
