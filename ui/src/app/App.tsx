import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Shell } from '@/widgets/Shell'
import { TaskDetailDrawer } from '@/widgets/TaskDetailDrawer'
import { ProposalDetailDrawer } from '@/widgets/ProposalDetailDrawer'
import { ProposalNodeDrawer } from '@/widgets/ProposalNodeDrawer'
import { PrimitiveDetailDrawer } from '@/widgets/PrimitiveDetailDrawer'
import { ReleaseNotesModal } from '@/widgets/ReleaseNotesModal'
import { ShortcutsOverlay } from '@/widgets/ShortcutsOverlay'
import { useHashRoute } from '@/shared/useHashRoute'
import { useGlobalKeyboardShortcuts } from '@/shared/useGlobalKeyboardShortcuts'
import {
  decodeProgressStateFromTaskHash,
  encodeProgressState,
} from '@/shared/progressUrlState'
import {
  isKnownRoute,
  parseArcQaRoute,
  parseKpiRoute,
  parseOverlayOrigin,
  parsePrimitiveRoute,
  parseProposalOrigin,
  parseProposalRoute,
  parseProposalNodeRoute,
  parseReleaseNotesRoute,
  parseShortcutsRoute,
  parseScoresRoute,
  parseTaskKpiKey,
  parseTaskOrigin,
  parseTaskRoute,
  parseTaskStep,
  resolvePageRoute,
  routeBase,
} from '@/shared/routing'
import { useCounts } from '@/entities/counts/useCounts'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useSseConnected } from '@/shared/sseStatus'
import { useTabTitleBadge } from '@/shared/useTabTitleBadge'
import { useProposals } from '@/entities/proposals/useProposals'
import { useProposalDetail } from '@/entities/proposals/useProposalDetail'
import { useProgress } from '@/hooks/useProgress'
import { FocusedProjectProvider } from '@/shared/useFocusedProject'
import { ProgressPage } from '@/pages/ProgressPage'
import { ChatPage } from '@/pages/ChatPage'
import { EventsPage } from '@/pages/EventsPage'
import { KpiDetailPage } from '@/pages/KpiDetailPage'
import { KpiIndexPage } from '@/pages/KpiIndexPage'
import { StudioIndexPage } from '@/pages/StudioIndexPage'
import { StudioPage } from '@/pages/StudioPage'
import { StewardPage } from '@/pages/StewardPage'
import { ReflectionsPage } from '@/pages/ReflectionsPage'
import { ControlRoomPage } from '@/pages/ControlRoomPage'
import { TriagePage } from '@/pages/TriagePage'
import { ProposalsPage } from '@/pages/ProposalsPage'
import { ArcQaPage } from '@/pages/ArcQaPage'
import { FrameworkUpdateBanner } from '@/components/FrameworkUpdateBanner'
import { FallbackBoundary } from '@/components/FallbackBoundary'
import { AlertNotifier } from '@/shared/notifications/alertNotifier'
import { Toaster } from '@/components/ui/sonner'

/**
 * Navigate to a hash via replaceState so overlay closes never push a phantom
 * history entry.  The overlay *open* (via `<a href>` or `window.location.hash`)
 * already pushed one entry; closing with replaceState pops that entry so Back
 * returns to the page the user was on before opening the overlay.
 */
const navigateReplace = (hash: string): void => {
  if (typeof window === 'undefined') return
  history.replaceState(null, '', hash)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/**
 * Closes a drawer opened from `closeHash` by returning to its origin page.
 * Uses replaceState to avoid phantom back-button entries.
 *
 * When the drawer was opened from the Progress page (`from=progress`), any
 * progress filter state embedded in the hash as `pView`/`pQ`/`pProposal`
 * params is decoded and restored in the destination URL so drill-in and
 * search state survive both close and page reload.
 */
const clearTaskHash = (closeHash: string): void => {
  const origin = parseTaskOrigin(closeHash)
  if (origin === 'kpi') {
    const kpiKey = parseTaskKpiKey(closeHash)
    navigateReplace(kpiKey ? `#/kpi/${encodeURIComponent(kpiKey)}` : '#/kpi')
    return
  }
  if (origin === 'progress') {
    // Restore the filter state (proposal, view, search) that was embedded in
    // the task hash when the drawer was opened from the topology/board view.
    const savedState = decodeProgressStateFromTaskHash(closeHash)
    const progressParams = encodeProgressState(savedState)
    navigateReplace(progressParams ? `#/progress${progressParams}` : '#/progress')
    return
  }
  navigateReplace(origin ? routeBase(origin) : '#/progress')
}


const AppInner = () => {
  const qc = useQueryClient()
  const rawHash = useHashRoute()
  useGlobalKeyboardShortcuts()

  // Redirect root / bare hashes to #/triage (the default landing page) and
  // legacy action-queue deep links to #/chat.
  // Unknown hashes are NOT redirected — they render a visible not-found state.
  // navigateReplace (replaceState + synthetic hashchange) is used here so
  // useHashRoute's state updates atomically with the URL change.  A bare
  // history.replaceState would NOT fire hashchange, leaving rawHash stale at
  // '#/' and allowing a later hashchange from another effect to re-evaluate
  // the redirect against a different window.location.hash value.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (rawHash === '' || rawHash === '#' || rawHash === '#/') {
      navigateReplace('#/triage')
    } else if (rawHash.startsWith('#/action-queue') || rawHash.startsWith('#/todo')) {
      // Legacy action-queue deep links: the chat page absorbed the action
      // queue, so map the old ?item=/kind=/q= state onto the chat hash.
      const qIdx = rawHash.indexOf('?')
      navigateReplace(qIdx === -1 ? '#/chat' : `#/chat${rawHash.slice(qIdx)}`)
    } else if (rawHash === '#/studio' || rawHash.startsWith('#/studio/')) {
      // Legacy: #/studio was renamed to #/scores. Redirect bookmarks and shared
      // links so a stale URL lands on the right page rather than the not-found state.
      const rest = rawHash.slice('#/studio'.length) // '' or '/<taskId>'
      navigateReplace(`#/scores${rest}`)
    }
    // Unknown hashes are intentionally left in the URL — the render path
    // shows a not-found page so the operator sees what they asked for rather
    // than landing silently on a different page.
  }, [rawHash])

  // True when the hash is unrecognised and not a root/legacy redirect.
  // Root hashes redirect immediately (above) so during the brief pre-redirect
  // render we show triage as a fallback. Unrecognised hashes stay in the URL
  // and render the not-found page.
  const isRoot = rawHash === '' || rawHash === '#' || rawHash === '#/'
  const isLegacy = rawHash.startsWith('#/action-queue') || rawHash.startsWith('#/todo') || rawHash === '#/studio' || rawHash.startsWith('#/studio/')
  const isUnknownRoute = !isRoot && !isLegacy && !isKnownRoute(rawHash)
  const hash = isUnknownRoute ? rawHash : (isKnownRoute(rawHash) ? rawHash : '#/triage')

  const taskId = parseTaskRoute(hash)
  const proposalId = parseProposalRoute(hash)
  const proposalNodeId = parseProposalNodeRoute(hash)
  const primitiveName = parsePrimitiveRoute(hash)
  const showReleaseNotes = parseReleaseNotesRoute(hash)
  const showShortcuts = parseShortcutsRoute(hash)
  // When a task overlay is open from a KPI detail page, parseKpiRoute returns
  // null (the hash is #/task/…, not #/kpi/…), so we fall back to the kpiKey
  // encoded in the task hash query params to keep the detail page mounted behind.
  const kpiKey = parseKpiRoute(hash) ?? parseTaskKpiKey(hash)
  const studioTaskId = parseScoresRoute(hash)
  const arcQaOriginId = parseArcQaRoute(hash)
  const activeStepName = parseTaskStep(hash) ?? undefined

  // Proposal list: used only for ProposalNodeDrawer (DAG canvas overlay).
  const { proposals: drafts } = useProposals()
  // Graph data for the task drawer's subgraph.  React Query deduplicates this
  // against the identical call inside ProgressPage — no extra network request.
  const { tasks, proposals } = useProgress()
  // Fetch the full proposal detail by id when a #/proposal/<id> hash is present.
  // This avoids the limit-50 / status-filter miss of the list endpoint and works
  // for any proposal regardless of status or pagination position.
  const { proposal, isPending: proposalDetailPending } = useProposalDetail(proposalId)
  const proposalNodeDraft = proposalNodeId
    ? (drafts.find((d) => d.id === proposalNodeId) ?? undefined)
    : undefined
  // Determine whether a #/proposal-node/<id> resolves to a known proposal.
  // tasks === null means progress data is still loading; null = unknown, true/false = settled.
  const proposalNodeExists: boolean | null =
    proposalNodeId === null
      ? null
      : tasks !== null
        ? proposals.some((p) => p.id === proposalNodeId) || proposalNodeDraft !== undefined
        : null
  const route = resolvePageRoute(hash)

  // Global tab-title badge: prepends `(N)` when there are items needing
  // attention and the SSE stream is connected (connected=false → stale count →
  // drop the prefix to avoid a confident-but-wrong number in the tab bar).
  //
  // The count comes from useCounts() — the same source the sidebar badge, the
  // board header, the Control Room Now-strip and the chat greeting read. The
  // tab used to recompute it locally from `useActionQueue().items`, which
  // drops every `type: 'group'` row and so showed a smaller number than the
  // three counts visible on screen (measured live: tab 11, everything else
  // 38). The tab title is the operator's only signal while the window is
  // backgrounded, so it is the one surface that must not disagree.
  const { needsYou, known } = useCounts()
  const sseConnected = useSseConnected()
  useTabTitleBadge(needsYou, sseConnected && known)

  // Server-sent verbs for the currently-open task drawer. Found by matching the
  // drawer's taskId against the action queue's entityId. When present, the
  // drawer renders these verbs instead of deriving them from recoveryExhausted
  // locally — keeping the triage row and the drawer in agreement.
  // Read the queue separately from the tab badge above. The badge deliberately
  // uses useCounts() rather than recomputing from these rows — a local
  // recompute drops every `type: 'group'` row and disagreed with the three
  // counts on screen. The drawer needs the rows themselves, not a count.
  const { items: aqItems } = useActionQueue()
  const drawerFailedVerbs = taskId
    ? (aqItems.find((item) => item.entityId === taskId)?.verbs ?? undefined)
    : undefined

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <AlertNotifier />
      <FrameworkUpdateBanner />
      <Shell hash={hash}>
        <FallbackBoundary of="view" variant="pane">
          {route === 'arc-qa' && arcQaOriginId !== null ? (
            <ArcQaPage originId={arcQaOriginId} />
          ) : route === 'arc-qa' ? (
            <ProgressPage />
          ) : route === 'triage' ? (
            <TriagePage />
          ) : route === 'scores' && studioTaskId !== null ? (
            <StudioPage taskId={studioTaskId} />
          ) : route === 'scores' ? (
            <StudioIndexPage />
          ) : route === 'kpi' && kpiKey !== null ? (
            <KpiDetailPage kpiKey={kpiKey} />
          ) : route === 'kpi' ? (
            <KpiIndexPage />
          ) : route === 'progress' ? (
            <ProgressPage />
          ) : route === 'events' ? (
            <EventsPage />
          ) : route === 'steward' ? (
            <StewardPage />
          ) : route === 'reflections' ? (
            <ReflectionsPage />
          ) : route === 'control' ? (
            <ControlRoomPage />
          ) : route === 'proposals' ? (
            <ProposalsPage />
          ) : (
            <ChatPage />
          )}
        </FallbackBoundary>
      </Shell>
      {taskId ? (
        <FallbackBoundary of="task detail" variant="inline">
          <TaskDetailDrawer
            taskId={taskId}
            onClose={() => clearTaskHash(hash)}
            onPurged={() => {
              // The node was purged from the DB. Drop it from the (now-stale)
              // progress graph and close the drawer rather than leaving a dead
              // "not found" panel open over a node that no longer exists.
              void qc.invalidateQueries({ queryKey: ['progress'] })
              clearTaskHash(hash)
            }}
            tasks={tasks ?? []}
            proposals={proposals}
            activeStepName={activeStepName}
            failedVerbs={drawerFailedVerbs}
          />
        </FallbackBoundary>
      ) : null}
      {proposal ? (
        <FallbackBoundary of="proposal detail" variant="inline">
          <ProposalDetailDrawer
            proposal={proposal}
            onClose={() => {
              const origin = parseProposalOrigin(hash)
              navigateReplace(origin ? routeBase(origin) : '#/progress')
            }}
            tasks={tasks ?? []}
          />
        </FallbackBoundary>
      ) : proposalId !== null && !proposalDetailPending ? (
        <>
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-foreground/40"
            onClick={() => {
              const origin = parseProposalOrigin(hash)
              navigateReplace(origin ? routeBase(origin) : '#/progress')
            }}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Proposal not found"
            data-testid="proposal-not-found"
            className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-border bg-background shadow-2xl"
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="break-words font-mono text-title font-semibold text-foreground">
                Unknown proposal
              </h2>
              <button
                type="button"
                onClick={() => {
                  const origin = parseProposalOrigin(hash)
                  navigateReplace(origin ? routeBase(origin) : '#/progress')
                }}
                aria-label="Close"
                className="shrink-0 rounded border border-border px-2 py-0.5 font-mono text-body text-muted-foreground hover:bg-foreground/5"
              >
                Close
              </button>
            </header>
            <div className="flex flex-1 flex-col gap-3 px-4 py-3">
              <p className="font-mono text-body text-foreground">
                <span className="text-error">{proposalId}</span> is not a known proposal.
              </p>
            </div>
          </aside>
        </>
      ) : null}
      {proposalNodeId !== null && proposalNodeExists !== false ? (
        <FallbackBoundary of="proposal" variant="inline">
          <ProposalNodeDrawer
            proposalId={proposalNodeId}
            proposals={proposals}
            tasks={tasks ?? []}
            proposal={proposalNodeDraft}
            onClose={() => {
              const origin = parseOverlayOrigin(hash)
              navigateReplace(origin ? routeBase(origin) : '#/progress')
            }}
          />
        </FallbackBoundary>
      ) : proposalNodeId !== null && proposalNodeExists === false ? (
        <>
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-foreground/40"
            onClick={() => {
              const origin = parseOverlayOrigin(hash)
              navigateReplace(origin ? routeBase(origin) : '#/progress')
            }}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Proposal not found"
            data-testid="proposal-node-not-found"
            className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-border bg-background shadow-2xl"
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="break-words font-mono text-title font-semibold text-foreground">
                Unknown proposal
              </h2>
              <button
                type="button"
                onClick={() => {
                  const origin = parseOverlayOrigin(hash)
                  navigateReplace(origin ? routeBase(origin) : '#/progress')
                }}
                aria-label="Close"
                className="shrink-0 rounded border border-border px-2 py-0.5 font-mono text-body text-muted-foreground hover:bg-foreground/5"
              >
                Close
              </button>
            </header>
            <div className="flex flex-1 flex-col gap-3 px-4 py-3">
              <p className="font-mono text-body text-foreground">
                <span className="text-error">{proposalNodeId}</span> is not a known proposal.
              </p>
            </div>
          </aside>
        </>
      ) : null}
      {primitiveName ? (
        <FallbackBoundary of="primitive detail" variant="inline">
          <PrimitiveDetailDrawer
            name={primitiveName}
            onClose={() => {
              const origin = parseOverlayOrigin(hash)
              navigateReplace(origin ? routeBase(origin) : '#/progress')
            }}
          />
        </FallbackBoundary>
      ) : null}
      {showReleaseNotes ? (
        <FallbackBoundary of="release notes" variant="inline">
          <ReleaseNotesModal
            onClose={() => navigateReplace('#/progress')}
          />
        </FallbackBoundary>
      ) : null}
      {showShortcuts ? (
        <FallbackBoundary of="shortcuts" variant="inline">
          <ShortcutsOverlay
            onClose={() => navigateReplace('#/progress')}
          />
        </FallbackBoundary>
      ) : null}
    </div>
  )
}

const App = () => (
  <FocusedProjectProvider>
    <AppInner />
    <Toaster />
  </FocusedProjectProvider>
)

export default App
