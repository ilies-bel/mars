/**
 * ContextRail — collapsible right-hand panel on ChatPage.
 *
 * Stacked panels:
 *   - Focus           : the active thread's title and status chip.
 *   - Project context: thread artifacts, open operator alerts, ADRs, and
 *                      project vision/theme.
 *   - Glossary        : searchable term list from /api/glossary; definition +
 *                       avoid-aliases on expand.
 *
 * The rail is responsive via a controlled `collapsed` prop: callers render an
 * icon strip at narrow widths and restore the full rail at wider ones.
 * Panels lazy-load and degrade gracefully when the daemon is unreachable.
 */

import { useState, useMemo, type RefObject } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAdrs, fetchGlossary, fetchTasksForThread } from '@/shared/api'
import { kindBadgeLabel } from '@/shared/actionQueueDetail'
import { useThreadFocus } from './useThreadFocus'
import { buildActivityFeed } from './activityFeed'
import { dispatchAlertVerb, verbButtonClass } from './alertVerbs'
import { priorityBadgeClass } from './QueueThreadRow'
import type { OpenWorkItem } from './openWork'

import type { GlossaryTerm, ChatSegmentAttachment, ChatThreadDetail, ProgressTask, ActionQueueItem, AdrEntry, DraftFeature } from '@/shared/schemas'
import type { ThreadFocusResult } from './useThreadFocus'
import type { LiveBuffer } from '@/shared/chatBuffer'
import type { ActivityEntry } from './activityFeed'

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
// Done criteria subsection (rendered inside FocusPanel when kind='task')
// ---------------------------------------------------------------------------

const DoneCriteriaSection = ({ task }: { task: ProgressTask }) => {
  // Flat fields take precedence; fall back to nested spec fields when absent.
  const criteria = task.doneCriteria ?? task.spec?.doneCriteria
  const verify = task.verify ?? task.spec?.verifyCmd

  if (!criteria?.length && !verify) return null

  return (
    <details className="mt-1">
      <summary className="cursor-pointer list-none font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60 hover:text-foreground transition-colors [&::-webkit-details-marker]:hidden">
        Done criteria ▸
      </summary>
      <div className="pt-1">
        {criteria && criteria.length > 0 && (
          <ul className="flex flex-col gap-0.5" data-testid="done-criteria-list">
            {criteria.map((c, i) => (
              <li
                key={i}
                className="font-mono text-[10px] leading-snug text-foreground/80"
                data-testid="done-criteria-item"
              >
                ☐ {c}
              </li>
            ))}
          </ul>
        )}
        {verify && (
          <code
            className="mt-1 block font-mono text-[9px] text-foreground/70 break-all"
            data-testid="done-criteria-verify"
          >
            {verify}
          </code>
        )}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Focus verbs row — verb buttons for alert-linked threads (second entry point)
// ---------------------------------------------------------------------------

interface FocusVerbsRowProps {
  item: ActionQueueItem
  threadId: string
  resolved: boolean
}

const FocusVerbsRow = ({ item, threadId, resolved }: FocusVerbsRowProps) => {
  const queryClient = useQueryClient()
  const verbs = item.verbs ?? []

  if (verbs.length === 0) return null

  const handleVerb = async (op: string) => {
    await dispatchAlertVerb(item.id, item.entityId, op)
    void queryClient.invalidateQueries({ queryKey: ['action-queue'] })
    void queryClient.invalidateQueries({ queryKey: ['chat-thread', threadId] })
  }

  return (
    <div className="flex flex-wrap gap-1.5 mt-1" data-testid="focus-verbs-row">
      {verbs.map((verb) => (
        <button
          key={verb.op}
          type="button"
          className={verbButtonClass(verb.style)}
          disabled={resolved}
          onClick={() => void handleVerb(verb.op)}
          data-testid={`focus-verb-${verb.op}`}
        >
          {verb.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Focus panel — shows the active thread title and status
// ---------------------------------------------------------------------------

interface FocusPanelProps {
  threadDetail?: ChatThreadDetail | null
  isStreaming?: boolean
  focusResult?: ThreadFocusResult
  threadId?: string
}

const FocusPanel = ({ threadDetail, isStreaming, focusResult, threadId }: FocusPanelProps) => {
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
          <DoneCriteriaSection task={task} />
        </div>
      )
    }

    // ActionQueueItem entity (alert or proposal)
    const badgeLabel = kind === 'proposal' ? 'proposal' : sourceLabel
    const alertItem = entity as ActionQueueItem
    const alertResolved = threadDetail?.thread.alertResolved ?? false
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
          {alertItem.title}
        </span>
        {kind === 'alert' && threadId && (
          <FocusVerbsRow item={alertItem} threadId={threadId} resolved={alertResolved} />
        )}
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
// Thread artifact rail
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  vision: string | null
  theme: string | null
}

export interface ArtifactsRailProps {
  tasks: string[]
  files: ChatSegmentAttachment[]
  meta: ProjectMeta
  projectId?: string
}

interface RailSectionProps {
  title: string
  children: React.ReactNode
}

const RailSection = ({ title, children }: RailSectionProps) => (
  <section className="border-b border-primary/20 px-3 py-2" aria-label={title}>
    <h2 className="mb-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
      {title}
    </h2>
    {children}
  </section>
)

const emptyArtifacts = (text: string) => (
  <p className="font-mono text-[10px] text-muted-foreground/50">{text}</p>
)

interface RailPileProps {
  title: string
  count: number
  children: (visibleCount: number) => React.ReactNode
}

const RailPile = ({ title, count, children }: RailPileProps) => {
  const [expanded, setExpanded] = useState(false)
  const showToggle = count > 3
  const visibleCount = expanded ? count : Math.min(count, 3)

  return (
    <RailSection title={title}>
      {children(visibleCount)}
      {showToggle && (
        <button
          type="button"
          className="mt-1 font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less ▴' : `See all ${count} ▾`}
        </button>
      )}
    </RailSection>
  )
}

interface AlertsPileProps {
  items: OpenWorkItem[]
  onOpenWork?: (item: OpenWorkItem) => void
}

const AlertsPile = ({ items, onOpenWork }: AlertsPileProps) => (
  <RailPile title="Alerts" count={items.length}>
    {(visibleCount) =>
      items.length === 0 ? (
        emptyArtifacts('No alerts')
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.slice(0, visibleCount).map((item) => (
            <li key={`${item.source}:${item.id}`}>
              <button
                type="button"
                className="flex w-full items-center gap-1 text-left font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                onClick={() => onOpenWork?.(item)}
                data-testid="context-rail-alert-row"
              >
                {item.source === 'alert' ? (
                  <>
                    <span className={`shrink-0 uppercase ${priorityBadgeClass(item.item.priority)}`}>
                      {item.item.priority} · {kindBadgeLabel(item.item.kind)}
                    </span>
                    <span className="min-w-0 truncate">{item.item.title}</span>
                  </>
                ) : (
                  <>
                    <span className={`shrink-0 uppercase ${priorityBadgeClass(item.priority >= 3 ? 'high' : item.priority >= 2 ? 'normal' : 'low')}`}>
                      {item.priority} · blocked
                    </span>
                    <span className="min-w-0 truncate">{item.task.title}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )
    }
  </RailPile>
)

interface ProposalsPileProps {
  proposals: DraftFeature[]
  onOpenProposal?: (proposal: DraftFeature) => void
}

const ProposalsPile = ({ proposals, onOpenProposal }: ProposalsPileProps) => {
  const drafts = useMemo(
    () => proposals.filter((proposal) => proposal.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt),
    [proposals],
  )

  return (
    <RailPile title="Proposals" count={drafts.length}>
      {(visibleCount) =>
        drafts.length === 0 ? (
          emptyArtifacts('No proposals')
        ) : (
          <ul className="flex flex-col gap-0.5">
            {drafts.slice(0, visibleCount).map((proposal) => (
              <li key={proposal.id}>
                <button
                  type="button"
                  className="block w-full truncate text-left font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                  onClick={() => onOpenProposal?.(proposal)}
                  data-testid="context-rail-proposal-row"
                >
                  {proposal.title}
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </RailPile>
  )
}

interface AdrsPileProps {
  adrs: AdrEntry[]
  projectId?: string
}

const AdrsPile = ({ adrs, projectId }: AdrsPileProps) => {
  const projectQuery = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
  const sortedAdrs = useMemo(
    () => [...adrs].sort((a, b) => b.number - a.number),
    [adrs],
  )

  return (
    <RailPile title="ADRs" count={sortedAdrs.length}>
      {(visibleCount) =>
        sortedAdrs.length === 0 ? (
          emptyArtifacts('No ADRs')
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sortedAdrs.slice(0, visibleCount).map((adr) => {
              const path = `docs/knowledge/decisions/${String(adr.number).padStart(4, '0')}-${adr.slug}.md`
              return (
                <li key={path}>
                  <a
                    href={`/api/project/adrs/${encodeURIComponent(path)}${projectQuery}`}
                    className="block truncate font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="context-rail-adr-row"
                  >
                    ADR {adr.number}: {adr.title}
                  </a>
                </li>
              )
            })}
          </ul>
        )
      }
    </RailPile>
  )
}

export const ArtifactsRail = ({ tasks, files, meta, projectId }: ArtifactsRailProps) => {
  const projectQuery = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
  const { data: adrs = [] } = useQuery({
    queryKey: ['adrs', projectId],
    queryFn: () => fetchAdrs(projectId),
    staleTime: 60_000,
  })

  return (
    <div data-testid="artifacts-rail">
      <RailSection title="Tasks">
        {tasks.length === 0 ? (
          emptyArtifacts('No tasks created in this thread')
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tasks.map((id) => (
              <li key={id}>
                <a
                  href={`#/task/${encodeURIComponent(id)}?from=chat`}
                  className="font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                  data-testid="context-rail-task-row"
                >
                  Task {id}
                </a>
              </li>
            ))}
          </ul>
        )}
      </RailSection>

      <RailSection title="Files">
        {files.length === 0 ? (
          emptyArtifacts('No files shared in this thread')
        ) : (
          <ul className="flex flex-col gap-0.5">
            {files.map((file, index) => (
              <li key={`${file.path}-${index}`}>
                <a
                  href={`/api/chat/uploads/${encodeURIComponent(file.path)}${projectQuery}`}
                  className="font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {file.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </RailSection>

      <AdrsPile adrs={adrs} projectId={projectId} />

      <RailSection title="Meta">
        {meta.vision || meta.theme ? (
          <ul className="flex flex-col gap-0.5">
            {meta.vision && (
              <li>
                <a
                  href={`/api/project/meta/vision${projectQuery}`}
                  className="font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Project vision
                </a>
              </li>
            )}
            {meta.theme && (
              <li>
                <a
                  href={`/api/project/meta/theme${projectQuery}`}
                  className="font-mono text-[10px] text-foreground/80 hover:text-foreground hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Project theme
                </a>
              </li>
            )}
          </ul>
        ) : (
          emptyArtifacts('No project vision or theme recorded')
        )}
      </RailSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Activity panel — recent tool calls, live + persisted
// ---------------------------------------------------------------------------

const ActivityPanel = ({ feed }: { feed: ActivityEntry[] }) => {
  if (feed.length === 0) {
    return (
      <p className="px-3 py-2 font-mono text-[10px] text-muted-foreground/60">
        No activity yet
      </p>
    )
  }
  return (
    <ul className="flex flex-col py-1" data-testid="activity-feed">
      {feed.map((entry) => (
        <li
          key={entry.id}
          className="flex items-center gap-1.5 px-3 py-1"
          data-testid={`activity-entry-${entry.state}`}
        >
          {entry.state === 'live' ? (
            <span
              className="text-[8px] text-highlight animate-pulse"
              aria-label="live"
            >
              ●
            </span>
          ) : (
            <span
              className="text-[8px] text-muted-foreground/60"
              aria-label="persisted"
            >
              ●
            </span>
          )}
          <span
            className={`font-mono text-[10px] truncate ${
              entry.state === 'live' ? 'text-foreground' : 'text-muted-foreground/70'
            }`}
          >
            {entry.toolName}
          </span>
        </li>
      ))}
    </ul>
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
  /** Attachments shared by the selected thread. */
  files?: ChatSegmentAttachment[]
  /** Stable project context surfaced alongside thread artifacts. */
  meta?: ProjectMeta
  /** The currently selected chat thread. Used to scope session-artifact data. */
  threadId?: string
  /** The id of the active thread (used to gate Focus panel display). */
  activeThreadId?: string
  /** Thread detail for the active thread, including title and status. */
  threadDetail?: ChatThreadDetail | null
  /** True when the client is actively streaming a reply for the active thread. */
  isStreaming?: boolean
  /** Live streaming buffer for the active thread. Passed from ChatConversation
   * so the activity panel can render in-flight tool calls. */
  liveBuffer?: LiveBuffer | null
  /** Ranked unresolved alerts and blocked tasks, supplied by ChatPage. */
  openWork?: OpenWorkItem[]
  /** Opens an alert conversation or a blocked task detail based on its source. */
  onOpenWork?: (item: OpenWorkItem) => void
  /** Draft proposals to surface beneath alerts. */
  proposals?: DraftFeature[]
  /** Opens a proposal-scoped Subject. */
  onOpenProposal?: (proposal: DraftFeature) => void
  /** Receives focus when the opening greeting sends the operator to open work. */
  openWorkRegionRef?: RefObject<HTMLDivElement | null>
  /** When true the rail collapses to a narrow icon strip. */
  collapsed?: boolean
  /** Callback to toggle the collapsed state from outside. */
  onToggleCollapse?: () => void
}

export const ContextRail = ({
  projectId,
  files = [],
  meta = { vision: null, theme: null },
  threadId,
  activeThreadId,
  threadDetail,
  isStreaming,
  liveBuffer,
  openWork = [],
  onOpenWork,
  proposals = [],
  onOpenProposal,
  openWorkRegionRef,
  collapsed = false,
  onToggleCollapse,
}: ContextRailProps) => {
  const { data: tasks = [] } = useQuery({
    queryKey: ['thread-tasks', threadId],
    queryFn: () => fetchTasksForThread(threadId!),
    enabled: Boolean(threadId),
    staleTime: 15_000,
  })
  const focusResult = useThreadFocus(threadDetail?.thread)
  // Build the activity feed from live buffer + persisted thread history.
  // Only computed when there is an active thread to avoid unnecessary work.
  const activityFeed = useMemo(
    () =>
      activeThreadId
        ? buildActivityFeed(
            threadDetail ?? null,
            liveBuffer ?? null,
            isStreaming ?? false,
          )
        : [],
    [activeThreadId, threadDetail, liveBuffer, isStreaming],
  )
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
          threadId={activeThreadId}
        />
      </PanelSection>

      {activeThreadId && (
        <PanelSection title="Recent activity" defaultOpen={true}>
          <ActivityPanel feed={activityFeed} />
        </PanelSection>
      )}

      <div ref={openWorkRegionRef} tabIndex={-1} aria-label="Open work" data-testid="context-rail-open-work">
        <AlertsPile items={openWork} onOpenWork={onOpenWork} />

        <ProposalsPile proposals={proposals} onOpenProposal={onOpenProposal} />
      </div>

      <ArtifactsRail
        tasks={tasks}
        files={files}
        meta={meta}
        projectId={projectId}
      />

      <PanelSection title="Glossary" defaultOpen={false}>
        <GlossaryPanel />
      </PanelSection>

    </aside>
  )
}
