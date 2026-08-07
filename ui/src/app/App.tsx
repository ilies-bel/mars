import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { NavBar } from '@/widgets/NavBar'
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
  pageTitle,
  parseKpiRoute,
  parseOverlayOrigin,
  parsePrimitiveRoute,
  parseProposalOrigin,
  parseProposalRoute,
  parseProposalNodeRoute,
  parseReleaseNotesRoute,
  parseShortcutsRoute,
  parseStudioRoute,
  parseTaskKpiKey,
  parseTaskOrigin,
  parseTaskRoute,
  parseTaskStep,
  resolvePageRoute,
} from '@/shared/routing'
import type { RouteName } from '@/shared/routing'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { isAlertQueueItem } from '@/widgets/chat/queueThreads'
import { useProposals } from '@/entities/proposals/useProposals'
import { useProgress } from '@/hooks/useProgress'
import { FocusedProjectProvider } from '@/shared/useFocusedProject'
import { ProgressPage } from '@/pages/ProgressPage'
import { ChatPage } from '@/pages/ChatPage'
import { EventsPage } from '@/pages/EventsPage'
import { KpiDetailPage } from '@/pages/KpiDetailPage'
import { KpiIndexPage } from '@/pages/KpiIndexPage'
import { StudioPage } from '@/pages/StudioPage'
import { StewardPage } from '@/pages/StewardPage'
import { ReflectionsPage } from '@/pages/ReflectionsPage'
import { FrameworkUpdateBanner } from '@/components/FrameworkUpdateBanner'
import { FallbackBoundary } from '@/components/FallbackBoundary'
import { AlertNotifier } from '@/shared/notifications/alertNotifier'
import { Breadcrumbs } from '@/widgets/Breadcrumbs'

/** Hash bases the drawer returns to, keyed by the origin recorded in the hash. */
const ROUTE_BASE: Record<RouteName, string> = {
  chat: '#/chat',
  progress: '#/progress',
  events: '#/events',
  kpi: '#/events',
  studio: '#/progress',
  steward: '#/steward',
  reflections: '#/reflections',
}

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
  navigateReplace(origin ? ROUTE_BASE[origin] : '#/progress')
}


const AppInner = () => {
  const qc = useQueryClient()
  const rawHash = useHashRoute()
  useGlobalKeyboardShortcuts()

  // Redirect root / bare hashes to #/chat (the default landing page) and
  // truly unknown hashes to #/progress.
  // navigateReplace (replaceState + synthetic hashchange) is used here so
  // useHashRoute's state updates atomically with the URL change.  A bare
  // history.replaceState would NOT fire hashchange, leaving rawHash stale at
  // '#/' and allowing a later hashchange from another effect to re-evaluate
  // the redirect against a different window.location.hash value.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (rawHash === '' || rawHash === '#' || rawHash === '#/') {
      navigateReplace('#/chat')
    } else if (rawHash.startsWith('#/action-queue') || rawHash.startsWith('#/todo')) {
      // Legacy action-queue deep links: the chat page absorbed the action
      // queue, so map the old ?item=/kind=/q= state onto the chat hash.
      const qIdx = rawHash.indexOf('?')
      navigateReplace(qIdx === -1 ? '#/chat' : `#/chat${rawHash.slice(qIdx)}`)
    } else if (!isKnownRoute(rawHash)) {
      navigateReplace('#/progress')
    }
  }, [rawHash])

  // Live action queue count for the tab title badge. React Query deduplicates
  // this against the identical call inside ChatPage — no extra request.
  const { items: aqItems } = useActionQueue()

  // For rendering, treat unknown hashes as #/chat (the default) so the nav
  // highlight and page selection are correct even on the first render before
  // the redirect effect fires.
  const hash = isKnownRoute(rawHash) ? rawHash : '#/chat'

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
  const studioTaskId = parseStudioRoute(hash)
  const activeStepName = parseTaskStep(hash) ?? undefined

  // Proposal fields come from the `/api/proposals` fetch — no new
  // endpoint is introduced for the drawer.
  const { proposals: drafts } = useProposals()
  // Graph data for the task drawer's subgraph.  React Query deduplicates this
  // against the identical call inside ProgressPage — no extra network request.
  const { tasks, proposals } = useProgress()
  const proposal = proposalId
    ? (drafts.find((d) => d.id === proposalId) ?? null)
    : null
  const proposalNodeDraft = proposalNodeId
    ? (drafts.find((d) => d.id === proposalNodeId) ?? undefined)
    : undefined
  const route = resolvePageRoute(hash)

  // Update the browser tab title whenever the route or AQ item count changes
  // so multiple mars tabs are distinguishable in the tab bar and history.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = pageTitle(route, aqItems.filter(isAlertQueueItem).length)
  }, [route, aqItems])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <AlertNotifier />
      <FrameworkUpdateBanner />
      <NavBar hash={hash} />
      <Breadcrumbs hash={hash} />
      <div className="min-h-0 flex-1">
        <FallbackBoundary of="view" variant="pane">
          {route === 'studio' && studioTaskId !== null ? (
            <StudioPage taskId={studioTaskId} />
          ) : route === 'studio' ? (
            <ProgressPage />
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
          ) : (
            <ChatPage />
          )}
        </FallbackBoundary>
      </div>
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
          />
        </FallbackBoundary>
      ) : null}
      {proposal ? (
        <FallbackBoundary of="proposal detail" variant="inline">
          <ProposalDetailDrawer
            proposal={proposal}
            onClose={() => {
              const origin = parseProposalOrigin(hash)
              navigateReplace(origin ? ROUTE_BASE[origin] : '#/progress')
            }}
            tasks={tasks ?? []}
          />
        </FallbackBoundary>
      ) : null}
      {proposalNodeId ? (
        <FallbackBoundary of="proposal" variant="inline">
          <ProposalNodeDrawer
            proposalId={proposalNodeId}
            proposals={proposals}
            tasks={tasks ?? []}
            proposal={proposalNodeDraft}
            onClose={() => {
              const origin = parseOverlayOrigin(hash)
              navigateReplace(origin ? ROUTE_BASE[origin] : '#/progress')
            }}
          />
        </FallbackBoundary>
      ) : null}
      {primitiveName ? (
        <FallbackBoundary of="primitive detail" variant="inline">
          <PrimitiveDetailDrawer
            name={primitiveName}
            onClose={() => {
              const origin = parseOverlayOrigin(hash)
              navigateReplace(origin ? ROUTE_BASE[origin] : '#/progress')
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
  </FocusedProjectProvider>
)

export default App
