import { useEffect, useMemo, useState } from 'react'
import { FallbackSurface } from '@/components/FallbackSurface'
import { useProgress } from '@/hooks/useProgress'
import { useHotPaths } from '@/hooks/useHotPaths'
import {
  readExplicitViewFromUrl,
  readProgressStateFromUrl,
  writeProgressStateToUrl,
} from '@/shared/progressUrlState'
import type { Tab } from '@/shared/tabs'
import { DEFAULT_TAB } from '@/shared/tabs'
import { postOperatorDispatch } from '@/shared/api'
import { taskHash } from '@/shared/routing'
import { BoardView } from '@/widgets/BoardView'
import { Footer } from '@/widgets/Footer'
import { TabStrip } from '@/widgets/TabStrip'
import { TopologyView } from '@/widgets/TopologyView'
import { TopStripe } from '@/widgets/TopStripe'
import { useDispatchState } from '@/entities/operator/useDispatchState'
import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'
import type { HotPathEntry } from '@/shared/schemas'

// ── Hot paths section ─────────────────────────────────────────────────────────

interface HotPathsSectionProps {
  window: '30d' | '90d' | 'all'
  group: 'file' | 'dir'
  onWindowChange: (w: '30d' | '90d' | 'all') => void
  onGroupChange: (g: 'file' | 'dir') => void
}

const WINDOWS = ['30d', '90d', 'all'] as const
const GROUPS = ['file', 'dir'] as const

const HotPathsSection = ({
  window,
  group,
  onWindowChange,
  onGroupChange,
}: HotPathsSectionProps) => {
  const { data, isLoading, error } = useHotPaths({ window, group })

  const toggleBtn = (active: boolean): string =>
    [
      'px-2 py-0.5 font-mono text-label rounded border transition-colors',
      active
        ? 'border-highlight bg-highlight/10 text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground hover:border-highlight/40',
    ].join(' ')

  return (
    <main
      data-testid="hot-paths-section"
      className="flex min-h-0 flex-1 flex-col overflow-auto p-4 bg-background"
    >
      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-label text-muted-foreground uppercase tracking-wide">Window</span>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            data-testid={`hot-paths-window-${w}`}
            className={toggleBtn(w === window)}
            onClick={() => onWindowChange(w)}
          >
            {w}
          </button>
        ))}
        <span className="ml-4 text-label text-muted-foreground uppercase tracking-wide">Group</span>
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            data-testid={`hot-paths-group-${g}`}
            className={toggleBtn(g === group)}
            onClick={() => onGroupChange(g)}
          >
            {g}
          </button>
        ))}
      </div>

      {/* Content */}
      {error ? (
        <FallbackSurface error={error} of="hot paths" variant="pane" />
      ) : isLoading || !data ? (
        <div className="font-mono text-label text-muted-foreground">Loading…</div>
      ) : data.paths.length === 0 ? (
        <div
          data-testid="hot-paths-empty"
          className="font-mono text-label text-muted-foreground"
        >
          No changes found in the last {window}.
        </div>
      ) : (
        <div data-testid="hot-paths-list" className="flex flex-col gap-0.5">
          {data.paths.map((entry: HotPathEntry) => (
            <HotPathRow key={entry.path} entry={entry} />
          ))}
          {data.total > data.paths.length && (
            <div className="mt-2 font-mono text-label text-muted-foreground">
              Showing top 50 of {data.total} paths
            </div>
          )}
        </div>
      )}
    </main>
  )
}

interface HotPathRowProps {
  entry: HotPathEntry
}

const HotPathRow = ({ entry }: HotPathRowProps) => {
  // Clicking a row with associated tasks opens the first task's drawer.
  // For rows with multiple tasks, the task list is shown inline.
  const firstTaskId = entry.tasks[0]

  return (
    <div
      data-testid="hot-paths-row"
      className="flex items-center gap-3 rounded px-2 py-1 hover:bg-card"
    >
      {/* Path */}
      <span className="min-w-0 flex-1 truncate font-mono text-label text-foreground">
        {firstTaskId ? (
          <a
            href={taskHash(firstTaskId)}
            className="hover:text-highlight transition-colors"
          >
            {entry.path}
          </a>
        ) : (
          entry.path
        )}
      </span>
      {/* Change count bar */}
      <span
        data-testid="hot-paths-count"
        className="shrink-0 font-mono text-label text-muted-foreground tabular-nums"
      >
        {entry.changes}
      </span>
      {/* Mars vs humans split */}
      <span className="shrink-0 font-mono text-label text-muted-foreground tabular-nums">
        <span className="text-highlight" title="Mars commits">
          {entry.touchedByMars}M
        </span>
        {' / '}
        <span title="Human commits">{entry.touchedByHumans}H</span>
      </span>
      {/* Task count */}
      {entry.tasks.length > 0 && (
        <span className="shrink-0 font-mono text-label text-muted-foreground tabular-nums">
          {entry.tasks.length} task{entry.tasks.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  )
}

export const ProgressPage = () => {
  // Initialise query and proposal filter dimensions from the URL on first render.
  // readProgressStateFromUrl() returns defaults in non-browser environments.
  const [initialUrlState] = useState(() => readProgressStateFromUrl())

  const { byCluster, tasks, proposals, aggregates, error, connected } = useProgress()

  // Resolve the initial active tab:
  //   1. Explicit ?view= param in the URL (shareable links are always honoured)
  //   2. DEFAULT_TAB ('topology')
  //
  // Topology is the landing view. Board and Hot-paths are available via the tab
  // strip. The tab is NOT persisted to localStorage — a per-session tab choice
  // is not worth overriding the primary view of the page.
  const [activeTab, setActiveTab] = useState<Tab>(
    () => readExplicitViewFromUrl() ?? DEFAULT_TAB,
  )

  // Hot-paths controls — window and group toggles for the hot-paths tab.
  const [hotPathsWindow, setHotPathsWindow] = useState<'30d' | '90d' | 'all'>('90d')
  const [hotPathsGroup, setHotPathsGroup] = useState<'file' | 'dir'>('file')

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    initialUrlState.proposal,
  )
  const [searchQuery, setSearchQuery] = useState<string>(initialUrlState.query)

  // Compute the set of IDs that match the search query (null = no active filter).
  const searchMatchIds = useMemo((): Set<string> | null => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    const matchingTaskIds = new Set<string>(
      (tasks ?? [])
        .filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            t.prompt.toLowerCase().includes(q) ||
            (t.branch?.toLowerCase() ?? '').includes(q),
        )
        .map((t) => t.id),
    )
    // Include proposals that have at least one matching child task.
    const matchingProposalIds = new Set<string>(
      proposals
        .filter((p) =>
          (tasks ?? []).some(
            (t) => t.parentProposalId === p.id && matchingTaskIds.has(t.id),
          ),
        )
        .map((p) => p.id),
    )
    return new Set([...matchingTaskIds, ...matchingProposalIds])
  }, [searchQuery, tasks, proposals])

  // Sync filter state to the URL after every change (debounced at 300 ms so
  // rapid search keystrokes don't produce a history entry per character).
  // history.replaceState is used — no hashchange event fires, so the app-level
  // hash router is not disturbed.
  useEffect(() => {
    const id = setTimeout(() => {
      writeProgressStateToUrl({
        view: activeTab,
        query: searchQuery,
        proposal: selectedProposalId,
        col: null,
      })
    }, 300)
    return () => clearTimeout(id)
  }, [activeTab, searchQuery, selectedProposalId])

  const dispatch = useDispatchState()
  const { isDown: daemonDown } = useDaemonHealth()
  const inProgressCount = byCluster['In progress'].length
  // Use server-side aggregate counts so done/failed are accurate even though
  // terminal task rows are excluded from the progress graph projection.
  const doneToday = aggregates.doneToday
  const failedCount = aggregates.failedOpen

  return (
    <div className="flex h-full w-full min-h-0 overflow-hidden bg-background" data-testid="progress-page">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopStripe
          inProgress={inProgressCount}
          doneToday={doneToday}
          failed={failedCount}
          connected={connected}
          dispatch={dispatch}
          daemonDown={daemonDown}
        />
        <TabStrip active={activeTab} onSelect={setActiveTab} />
        {/* Dispatch pause banner — shows when the queue is frozen so queued tasks
            do not start silently. The Resume button is absent for the `baseline`
            reason because resuming does not fix a red integration branch; a link
            to Needs You (where the failing gate row lives) is offered instead. */}
        {dispatch.paused && (
          <div
            data-testid="dispatch-pause-banner"
            className="flex items-center justify-between gap-4 border-b border-warn/30 bg-warn/10 px-4 py-2 font-mono text-label text-warn"
          >
            <span>
              {dispatch.reason === 'operator'
                ? 'Dispatch is paused by you — queued tasks will not start until it resumes.'
                : dispatch.reason === 'storm'
                  ? 'Dispatch is paused after a signature storm — queued tasks will not start until it resumes.'
                  : dispatch.reason === 'quota'
                    ? 'Dispatch is paused due to provider quota — queued tasks will not start until it resumes.'
                    : dispatch.reason === 'baseline'
                      ? 'Dispatch is paused — main is failing a required gate. Fix the gate to resume.'
                      : 'Dispatch is paused — queued tasks will not start until it resumes.'}
            </span>
            {dispatch.reason === 'baseline' ? (
              <a
                href="#/triage"
                data-testid="dispatch-pause-banner-gate-link"
                className="shrink-0 rounded-md border border-warn/40 px-3 py-1 text-warn transition-colors hover:bg-warn/20"
              >
                View failing gate
              </a>
            ) : (
              <button
                type="button"
                data-testid="dispatch-pause-banner-resume"
                onClick={() => void postOperatorDispatch('on').catch(() => {})}
                className="shrink-0 rounded-md border border-warn/40 px-3 py-1 text-warn transition-colors hover:bg-warn/20"
              >
                Resume dispatch
              </button>
            )}
          </div>
        )}
        {/* Text search — always visible */}
        <div className="flex items-center border-b border-border bg-background px-4 py-1.5">
          <div className="relative min-w-0 flex-1">
            <span
              className="pointer-events-none absolute inset-y-0 left-2 flex select-none items-center text-muted-foreground/60"
              aria-hidden="true"
            >
              ⌕
            </span>
            <input
              type="text"
              data-testid="search-tasks"
              placeholder="Search id, prompt, branch…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-border bg-card py-0.5 pl-6 pr-2 font-mono text-label text-foreground placeholder:text-muted-foreground/60 focus:border-highlight/40 focus:outline-none"
            />
          </div>
        </div>
        {error && tasks === null ? (
          <main className="flex min-h-0 flex-1 overflow-hidden bg-background">
            <FallbackSurface error={error} of="tasks" variant="pane" />
          </main>
        ) : activeTab === 'hot-paths' ? (
          <HotPathsSection
            window={hotPathsWindow}
            group={hotPathsGroup}
            onWindowChange={setHotPathsWindow}
            onGroupChange={setHotPathsGroup}
          />
        ) : activeTab === 'topology' ? (
          <TopologyView
            tasks={tasks ?? []}
            proposals={proposals}
            selectedProposalId={selectedProposalId}
            searchMatchIds={searchMatchIds}
            searchQuery={searchQuery}
            onSelectProposal={setSelectedProposalId}
          />
        ) : (
          <BoardView
            byCluster={byCluster}
            proposals={proposals}
            error={error}
            selectedProposalId={selectedProposalId}
            searchMatchIds={searchMatchIds}
            searchQuery={searchQuery}
          />
        )}
        <Footer />
      </div>
    </div>
  )
}
