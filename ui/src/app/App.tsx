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
import { useProposals } from '@/entities/proposals/useProposals'
import { useProgress } from '@/hooks/useProgress'
import { FocusedProjectProvider, useFocusedProjectId } from '@/shared/useFocusedProject'
import { useReleaseNotesAutoOpen } from '@/shared/useReleaseNotesAutoOpen'
import { ProgressPage } from '@/pages/ProgressPage'
import { ActionQueuePage } from '@/pages/ActionQueuePage'
import { ChatPage } from '@/pages/ChatPage'
import { EventsPage } from '@/pages/EventsPage'
import { KpiDetailPage } from '@/pages/KpiDetailPage'
import { KpiIndexPage } from '@/pages/KpiIndexPage'
import { StudioPage } from '@/pages/StudioPage'
import { FrameworkUpdateBanner } from '@/components/FrameworkUpdateBanner'
import { FallbackBoundary } from '@/components/FallbackBoundary'
import { AlertNotifier } from '@/shared/notifications/alertNotifier'
import { Breadcrumbs } from '@/widgets/Breadcrumbs'

/** Hash bases the drawer returns to, keyed by the origin recorded in the hash. */
const ROUTE_BASE: Record<RouteName, string> = {
  chat: '#/chat',
  'action-queue': '#/action-queue',
  progress: '#/progress',
  events: '#/events',
  kpi: '#/events',
  studio: '#/progress',
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
 */
const clearTaskHash = (closeHash: string): void => {
  const origin = parseTaskOrigin(closeHash)
  if (origin === 'kpi') {
    const kpiKey = parseTaskKpiKey(closeHash)
    navigateReplace(kpiKey ? `#/kpi/${encodeURIComponent(kpiKey)}` : '#/kpi')
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
  // replaceState avoids adding a history entry the back button would return to.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (rawHash === '' || rawHash === '#' || rawHash === '#/') {
      history.replaceState(null, '', '#/chat')
    } else if (!isKnownRoute(rawHash)) {
      history.replaceState(null, '', '#/progress')
    }
  }, [rawHash])

  // Live action queue count for the tab title badge. React Query deduplicates
  // this against the identical call inside ActionQueuePage — no extra request.
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

  // Auto-open the Release Notes drawer when arcs have landed since the user
  // last viewed them. Re-runs whenever the focused project changes.
  const projectId = useFocusedProjectId()
  useReleaseNotesAutoOpen(projectId)
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
    document.title = pageTitle(route, aqItems.length)
  }, [route, aqItems.length])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
      <AlertNotifier />
      <FrameworkUpdateBanner />
      <NavBar hash={hash} />
      <Breadcrumbs hash={hash} />
      <div className="min-h-0 flex-1">
        <FallbackBoundary of="this view" variant="pane">
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
          ) : route === 'chat' ? (
            <ChatPage />
          ) : (
            <ActionQueuePage />
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
