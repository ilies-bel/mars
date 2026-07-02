/**
 * AppServices — the in-process application-service layer (realises ADR-0055).
 *
 * ADR-0055 names a single use-case layer over the domain aggregates that every
 * display surface — daemon HTTP, CLI, a future TUI, the Claude skills — becomes
 * a thin adapter over, so projection/enrichment logic lives in exactly one
 * place. This module is that layer's *read* surface: one named function per read
 * use-case the daemon HTTP routes serve.
 *
 * Before this module the same use-cases existed only as ~18 ad-hoc `viewXxx:`
 * closures assembled inline inside `startDaemon` and reachable only through an
 * HTTP route. The logic was real and single-homed, but unnamed and un-importable
 * — a second consumer (a TUI) would have had to take a network hop or import
 * daemon internals. The closures move here verbatim; the daemon HTTP layer
 * (`http-server.ts`) becomes a thin transport that resolves a route to one of
 * these functions and serialises its result.
 *
 * This is a MOVE, not a redesign: each function below does exactly what the
 * matching `startDaemon` closure (or the inline `default*` fallback in
 * `http-server.ts`) did, calling the same `lib/*` and `daemon/view/*` builders.
 *
 * ### Daemon-runtime state stays daemon-owned and INJECTED
 *
 * Some use-cases need state that genuinely lives in the daemon *process* — the
 * unified trace-event store and the arc-derived AlertSources builder. Those are
 * not absorbed into AppServices; the daemon constructs them once and passes them
 * in via {@link AppServicesDeps}, so a non-daemon consumer can supply its own.
 * Things that are pure transport/stream concerns — the SSE {@link ViewStreamHub}
 * for `/view/stream`, the `recipeCatalog` served verbatim by `/recipes`, the
 * `/events` trace-query, and the update-poller's *writer* — are NOT use-cases
 * and stay in the daemon, not here.
 */

import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { resolveContext, getRepoRoot } from './context'
import {
  getDefaultDomainTaskStore,
  getCompositionRootClient,
  runCompositionRootMigrations,
} from './store/task-store'
import { buildSessionsView } from './daemon/view/sessions'
import { listTerminalEvents } from './daemon/view/terminal-events'
import { listReleaseNotes } from './daemon/view/release-notes'
import { getProposal } from './proposals'
import { MARS_VERSION } from '../version'
import { classifyInstallRoute } from './daemon/install-route'
import { listAlerts, showAlert, type Alert, type AlertSources } from './lib/alert'
import { loadRecentTaskCorpus, type ReflectCorpus, type LoadCorpusOptions } from './lib/reflect-query'
import { listDeepReflectArcCandidates, type ArcCandidate } from './lib/deep-reflect-query'
import { readKpiSeries, type KpiSeries } from './lib/kpi-snapshots'
import {
  listKpis as defaultListKpis,
  listKpiArcs as defaultListKpiArcs,
  type KpiArcsResult,
  type KpiKey,
  type KpiRecord,
} from './daemon/kpi-store'
import type { TraceEventStore } from './lib/trace-events-store'
import type { Proposal } from './proposals'
import type { ActionQueueRow, DerivedActionQueueFilter } from './daemon/view/action-queue'
import type { TerminalEvent } from './daemon/view/terminal-events'
import type { ReleaseNoteEntry } from './daemon/view/release-notes'
import type { Session } from './daemon/view/sessions'
import type { ProgressAggregates, ProgressTask, ProposalNode } from './daemon/view/progress'
import type {
  StepSpan,
  RunTimeline,
  RunTimelineStep,
  FrameworkUpdateState,
  DraftFeature,
  StaleWorktreeAlert,
} from './daemon/http-server'

/**
 * The daemon-runtime collaborators AppServices needs injected. These are the
 * pieces that genuinely live in the daemon process; everything else AppServices
 * imports directly (the use-case logic, the `lib/*`/`view/*` builders, the
 * composition-root accessors).
 */
export interface AppServicesDeps {
  /**
   * The unified trace-event store. AppServices reads it for the step-span
   * timeline and the per-worker session feed. The daemon owns it (opens it at
   * boot); a future consumer supplies its own reader.
   */
  traceStore: TraceEventStore
  /**
   * Build the pure-read {@link AlertSources} for the Alert use-cases. The arc
   * derivation needs to scan tasks + open stale-worktree rows, which is daemon
   * state, so the daemon supplies this builder. Recomputed per call (no caching)
   * exactly as the former inline closure did.
   */
  buildAlertSources: () => Promise<AlertSources>
}

/**
 * The read use-case surface every display adapter shares (ADR-0055). One named
 * function per read use-case the daemon HTTP routes serve. Mutating verbs
 * (restart/unblock/purge/…) are NOT here — they are the daemon's sole-writer
 * concern and stay on the HTTP transport's own deps.
 */
export interface AppServices {
  // ── action queue ──────────────────────────────────────────────────────────
  viewActionQueue: (filter: DerivedActionQueueFilter) => Promise<ActionQueueRow[]>
  viewActionQueueHistory: (opts: {
    cursor?: string | null
    limit?: number
  }) => Promise<{ rows: ActionQueueRow[]; nextCursor: string | null }>
  // ── alerts (arc-rooted read aggregate, ADR-0054) ───────────────────────────
  viewAlerts: () => Promise<Alert[]>
  viewAlert: (arcId: string) => Promise<Alert | null>
  // ── kpis ───────────────────────────────────────────────────────────────────
  listKpis: () => Promise<KpiRecord[]>
  listKpisSeries: (limit: number) => Promise<KpiSeries>
  listKpiArcs: (key: KpiKey) => Promise<KpiArcsResult>
  // ── task / progress / proposals views ───────────────────────────────────────
  viewTasks: () => Promise<{ tasks: unknown[] }>
  viewProgress: () => Promise<{ tasks: ProgressTask[]; proposals: ProposalNode[]; aggregates: ProgressAggregates }>
  viewProposals: () => Promise<{ drafts: DraftFeature[]; staleWorktrees: StaleWorktreeAlert[] }>
  viewProposal: (id: string) => Promise<Proposal | null>
  // ── trace-derived views ─────────────────────────────────────────────────────
  viewStepSpans: (params: { originId?: string; taskId?: string }) => Promise<{ spans: StepSpan[] }>
  viewRunTimeline: (taskId: string) => Promise<RunTimeline>
  viewSessions: (agentName: string) => Promise<{ sessions: Session[] }>
  viewTerminalEvents: () => Promise<{ events: TerminalEvent[] }>
  viewReleaseNotes: () => Promise<{ entries: ReleaseNoteEntry[] }>
  // ── reflect / arcs ──────────────────────────────────────────────────────────
  viewReflect: (opts?: LoadCorpusOptions) => Promise<ReflectCorpus>
  viewArcs: (opts?: { limit?: number; withTranscriptOnly?: boolean }) => Promise<ArcCandidate[]>
  // ── framework update (poller cache reader) ──────────────────────────────────
  viewFrameworkUpdate: () => Promise<FrameworkUpdateState>
}

/**
 * Construct the AppServices over the daemon-provided collaborators. The returned
 * object is a plain bag of named use-case functions — no DI container, no plugin
 * registry. Each function is a verbatim move of the former `startDaemon` closure
 * (or `http-server.ts` `default*` fallback) of the same name.
 */
export const createAppServices = (deps: AppServicesDeps): AppServices => {
  const { traceStore, buildAlertSources } = deps

  const viewTasks: AppServices['viewTasks'] = () =>
    getDefaultDomainTaskStore()
      .listTasks()
      .then((tasks) => ({ tasks }))

  const viewProgress: AppServices['viewProgress'] = async () => {
    const { buildProgressView, createProgressTaskStore, createProposalReader, createAggregateReader } =
      await import('./daemon/view/progress')
    const client = getCompositionRootClient()
    return buildProgressView(
      createProgressTaskStore(client),
      createProposalReader(client),
      createAggregateReader(client),
    )
  }

  const viewStepSpans: AppServices['viewStepSpans'] = async ({ originId, taskId }) => {
    const [started, ended] = await Promise.all([
      traceStore.query({ originId, taskId, kind: ['step_started'], limit: 1000 }),
      traceStore.query({ originId, taskId, kind: ['step_ended'], limit: 1000 }),
    ])

    // Map (workflowInstanceId, stepName) → ended event for O(n) pairing.
    const endedMap = new Map<string, (typeof ended)[0]>()
    for (const e of ended) {
      const wfId = e.payload.workflowInstanceId
      const stepName = e.payload.stepName
      if (typeof wfId === 'string' && typeof stepName === 'string') {
        endedMap.set(`${wfId}\0${stepName}`, e)
      }
    }

    const spans = started
      .map((s) => {
        const wfId = s.payload.workflowInstanceId
        const stepName = s.payload.stepName
        const key =
          typeof wfId === 'string' && typeof stepName === 'string'
            ? `${wfId}\0${stepName}`
            : null
        const endEvent = key ? endedMap.get(key) : undefined

        return {
          stepName: typeof stepName === 'string' ? stepName : '',
          phase: s.phase,
          workflowInstanceId: typeof wfId === 'string' ? wfId : '',
          workerName:
            typeof s.payload.workerName === 'string'
              ? s.payload.workerName
              : null,
          outcome: endEvent
            ? typeof endEvent.payload.outcome === 'string'
              ? endEvent.payload.outcome
              : 'completed'
            : 'running',
          startedAt: s.timestamp,
          endedAt: endEvent ? endEvent.timestamp : null,
          durationMs:
            endEvent && typeof endEvent.payload.durationMs === 'number'
              ? endEvent.payload.durationMs
              : null,
          taskId: s.taskId,
          originId: s.originId,
          evalResults: Array.isArray(endEvent?.payload.evalResults)
            ? (endEvent.payload.evalResults as Array<{ label: string; value: number | string | null; warn: boolean }>)
            : undefined,
        }
      })
      // Ascending by startedAt — preserves workflow execution order.
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))

    return { spans }
  }

  const viewRunTimeline: AppServices['viewRunTimeline'] = async (taskId) => {
    const [started, ended] = await Promise.all([
      traceStore.query({ taskId, kind: ['step_started'], limit: 1000 }),
      traceStore.query({ taskId, kind: ['step_ended'], limit: 1000 }),
    ])

    // Map (workflowInstanceId, stepName) → ended event for O(n) pairing.
    const endedMap = new Map<string, (typeof ended)[0]>()
    for (const e of ended) {
      const wfId = e.payload.workflowInstanceId
      const stepName = e.payload.stepName
      if (typeof wfId === 'string' && typeof stepName === 'string') {
        endedMap.set(`${wfId}\0${stepName}`, e)
      }
    }

    // Group step_started events by workflowInstanceId.
    // Note: the trace store returns events in DESC order (newest first), so we
    // sort each run's steps by startedAt ascending after collecting them all.
    const runMap = new Map<string, RunTimelineStep[]>()

    for (const s of started) {
      const wfId = s.payload.workflowInstanceId
      const stepName = s.payload.stepName
      if (typeof wfId !== 'string' || typeof stepName !== 'string') continue

      if (!runMap.has(wfId)) {
        runMap.set(wfId, [])
      }

      const key = `${wfId}\0${stepName}`
      const endEvent = endedMap.get(key)

      const outcome = endEvent
        ? typeof endEvent.payload.outcome === 'string'
          ? endEvent.payload.outcome
          : 'completed'
        : 'running'

      const status =
        outcome === 'completed' || outcome === 'failed' || outcome === 'killed'
          ? outcome
          : 'running'

      // Extract token usage from usageSignals (LLM steps only).
      const usageSignals =
        endEvent?.payload.usageSignals &&
        typeof endEvent.payload.usageSignals === 'object' &&
        !Array.isArray(endEvent.payload.usageSignals)
          ? (endEvent.payload.usageSignals as Record<string, unknown>)
          : null

      const step: RunTimelineStep = {
        stepName,
        phase: s.phase,
        workerName:
          typeof s.payload.workerName === 'string' ? s.payload.workerName : null,
        status,
        startedAt: s.timestamp,
        endedAt: endEvent ? endEvent.timestamp : null,
        durationMs:
          endEvent && typeof endEvent.payload.durationMs === 'number'
            ? endEvent.payload.durationMs
            : null,
        inputTokens:
          usageSignals && typeof usageSignals.inputTokens === 'number'
            ? usageSignals.inputTokens
            : null,
        outputTokens:
          usageSignals && typeof usageSignals.outputTokens === 'number'
            ? usageSignals.outputTokens
            : null,
        cacheReadTokens:
          usageSignals && typeof usageSignals.cacheReadTokens === 'number'
            ? usageSignals.cacheReadTokens
            : null,
        claudeSessionId:
          endEvent && typeof endEvent.payload.sessionId === 'string'
            ? endEvent.payload.sessionId
            : null,
        failureReason:
          endEvent && typeof endEvent.payload.failureReason === 'string'
            ? endEvent.payload.failureReason
            : null,
      }

      runMap.get(wfId)!.push(step)
    }

    // Sort steps within each run by startedAt ascending (workflow order), then
    // derive the run's own startedAt from its first step so runs can be sorted.
    const runs = Array.from(runMap.entries()).map(([runId, steps]) => {
      steps.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

      // endedAt for the run is the latest endedAt among all steps, or null
      // when any step is still running (no matching step_ended yet).
      const hasRunning = steps.some((s) => s.status === 'running')
      const endedAts = steps
        .map((s) => s.endedAt)
        .filter((t): t is string => t !== null)
      const runEndedAt =
        hasRunning || endedAts.length === 0
          ? null
          : [...endedAts].sort().at(-1) ?? null

      // runStartedAt is the earliest step_started timestamp in this run.
      const runStartedAt = steps[0]?.startedAt ?? ''

      return {
        runId,
        startedAt: runStartedAt,
        endedAt: runEndedAt,
        steps,
      }
    })

    // Sort runs chronologically by their earliest step_started timestamp.
    runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

    return { taskId, runs }
  }

  const viewSessions: AppServices['viewSessions'] = (agentName) =>
    buildSessionsView(traceStore, agentName)

  const viewAlerts: AppServices['viewAlerts'] = async () =>
    listAlerts(await buildAlertSources())

  const viewAlert: AppServices['viewAlert'] = async (arcId) =>
    showAlert(arcId, await buildAlertSources())

  const viewActionQueue: AppServices['viewActionQueue'] = async (filter) => {
    const { buildActionQueueView } = await import('./daemon/view/action-queue')
    const { listActionQueueItems } = await import('./lib/action-queue')
    const { listTasks: qListTasks } = await import('./queue')
    const getQueueClient = getCompositionRootClient

    await runCompositionRootMigrations()

    // Build the state store adapter.
    const stateStore = {
      listOpenActionQueueItems: async () => {
        const items = (await listActionQueueItems('all')).filter(
          (item) => item.state === 'open',
        )
        return items.map((item) => ({
          id: item.id,
          kind: item.kind as string,
          priority: item.priority as string,
          title: item.title,
          body: item.body,
          payload: item.payload,
          context: item.context,
          raisedAt: item.raisedAt,
          lastSeenAt: item.lastSeenAt,
          signature: item.signature,
        }))
      },
      // Stub — viewActionQueue only needs open rows; history is handled by viewActionQueueHistory.
      listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
    }

    // Build the task store adapter: tasks + blocker info + parentProposalId.
    const taskStore = {
      listTasks: async () => {
        const tasks = await qListTasks()
        const c = getQueueClient()
        // Build blockedBy map from task_blockers.
        let blockedByMap = new Map<string, string[]>()
        let proposalMap = new Map<string, string | null>()
        try {
          const blockersResult = await c.execute(
            `SELECT task_id, blocker_task_id FROM task_blockers`,
          )
          for (const row of blockersResult.rows) {
            const r = row as unknown as { task_id: string; blocker_task_id: string }
            const arr = blockedByMap.get(r.task_id) ?? []
            arr.push(r.blocker_task_id)
            blockedByMap.set(r.task_id, arr)
          }
        } catch {
          // task_blockers may not exist on a fresh repo — empty map.
        }
        try {
          const proposalResult = await c.execute(
            `SELECT id, parent_proposal_id FROM tasks WHERE parent_proposal_id IS NOT NULL`,
          )
          for (const row of proposalResult.rows) {
            const r = row as unknown as { id: string; parent_proposal_id: string | null }
            proposalMap.set(r.id, r.parent_proposal_id)
          }
        } catch {
          // Tolerate missing column on legacy repos.
        }
        return tasks.map((t) => ({
          id: t.id,
          status: t.status,
          prompt: t.prompt,
          blockedBy: blockedByMap.get(t.id) ?? [],
          parentProposalId: proposalMap.get(t.id) ?? null,
          failureSignature: t.failureSignature,
          branch: t.branch,
          updatedAt: t.updatedAt,
          fixForTaskId: t.fixForTaskId ?? null,
          leaseOwner: t.leaseOwner,
          leasedAt: t.leasedAt,
          leaseNote: t.leaseNote,
        }))
      },
    }

    return buildActionQueueView({
      stateStore,
      taskStore,
      repoRoot: getRepoRoot(),
      filter,
    })
  }

  const viewActionQueueHistory: AppServices['viewActionQueueHistory'] = async ({
    cursor,
    limit,
  }) => {
    const { buildActionQueueHistoryView } = await import('./daemon/view/action-queue')
    const { listResolvedActionQueueItems } = await import('./lib/action-queue')
    const { listTasks: qListTasks } = await import('./queue')
    const getQueueClient = getCompositionRootClient

    await runCompositionRootMigrations()

    const stateStore = {
      listOpenActionQueueItems: async () => [],
      listResolvedActionQueueItems: async (opts: {
        limit?: number
        cursor?: string | null
      }) => {
        const page = await listResolvedActionQueueItems(opts)
        return {
          items: page.items.map((item) => ({
            id: item.id,
            kind: item.kind as string,
            priority: item.priority as string,
            title: item.title,
            body: item.body,
            payload: item.payload,
            context: item.context,
            raisedAt: item.raisedAt,
            lastSeenAt: item.lastSeenAt,
            signature: item.signature,
            resolvedAt: item.resolvedAt,
            resolution: item.resolution,
            resolutionNote: item.resolutionNote,
            rootCause: item.rootCause,
            resolvedBy: item.resolutionDetails?.resolvedBy ?? null,
          })),
          nextCursor: page.nextCursor,
        }
      },
    }

    const taskStore = {
      listTasks: async () => {
        const tasks = await qListTasks()
        const c = getQueueClient()
        let blockedByMap = new Map<string, string[]>()
        let proposalMap = new Map<string, string | null>()
        try {
          const blockersResult = await c.execute(
            `SELECT task_id, blocker_task_id FROM task_blockers`,
          )
          for (const row of blockersResult.rows) {
            const r = row as unknown as { task_id: string; blocker_task_id: string }
            const arr = blockedByMap.get(r.task_id) ?? []
            arr.push(r.blocker_task_id)
            blockedByMap.set(r.task_id, arr)
          }
        } catch {
          // task_blockers may not exist on a fresh repo — empty map.
        }
        try {
          const proposalResult = await c.execute(
            `SELECT id, parent_proposal_id FROM tasks WHERE parent_proposal_id IS NOT NULL`,
          )
          for (const row of proposalResult.rows) {
            const r = row as unknown as { id: string; parent_proposal_id: string | null }
            proposalMap.set(r.id, r.parent_proposal_id)
          }
        } catch {
          // Tolerate missing column on legacy repos.
        }
        return tasks.map((t) => ({
          id: t.id,
          status: t.status,
          prompt: t.prompt,
          blockedBy: blockedByMap.get(t.id) ?? [],
          parentProposalId: proposalMap.get(t.id) ?? null,
          failureSignature: t.failureSignature,
          branch: t.branch,
          updatedAt: t.updatedAt,
          fixForTaskId: t.fixForTaskId ?? null,
          leaseOwner: t.leaseOwner,
          leasedAt: t.leasedAt,
          leaseNote: t.leaseNote,
        }))
      },
    }

    return buildActionQueueHistoryView({
      stateStore,
      taskStore,
      repoRoot: getRepoRoot(),
      limit,
      cursor,
    })
  }

  const viewProposals: AppServices['viewProposals'] = async () => {
    const client = getCompositionRootClient()
    // Check if the proposals table exists (absent on a fresh repo before
    // the first `mars init` / daemon run that initialises the schema).
    const tablesResult = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'`,
    )
    const drafts: DraftFeature[] = []
    if (tablesResult.rows.length > 0) {
      const r = await client.execute(
        `SELECT p.id, p.title, p.problem, p.solution, p.status, p.source,
                p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM proposal_user_stories s WHERE s.proposal_id = p.id) AS acceptance_count
         FROM proposals p
         WHERE p.status = 'draft'
         ORDER BY p.created_at DESC`,
      )

      // Load user stories for all draft proposals in one query.
      const storiesMap = new Map<string, string[]>()
      if (r.rows.length > 0) {
        const ids = r.rows.map((row) => (row as unknown as { id: string }).id)
        const placeholders = ids.map(() => '?').join(', ')
        const storiesResult = await client.execute({
          sql: `SELECT proposal_id, text FROM proposal_user_stories
                WHERE proposal_id IN (${placeholders})
                ORDER BY proposal_id, position ASC`,
          args: ids,
        })
        for (const row of storiesResult.rows) {
          const r0 = row as unknown as { proposal_id: string; text: string }
          const arr = storiesMap.get(r0.proposal_id) ?? []
          arr.push(r0.text)
          storiesMap.set(r0.proposal_id, arr)
        }
      }

      for (const row of r.rows) {
        const r0 = row as unknown as Record<string, unknown>
        const src = r0.source
        const source: DraftFeature['source'] =
          src === 'reflection' || src === 'planner' || src === 'human' ? src : 'human'
        drafts.push({
          id: r0.id as string,
          title: (r0.title as string | null) ?? '',
          problem: (r0.problem as string | null) ?? '',
          solution: (r0.solution as string | null) ?? '',
          status: (r0.status as string | null) ?? 'draft',
          source,
          createdAt: Number(r0.created_at ?? 0),
          updatedAt: Number(r0.updated_at ?? 0),
          acceptanceCount: Number(r0.acceptance_count ?? 0),
          userStories: storiesMap.get(r0.id as string) ?? [],
        })
      }
    }

    const staleWorktrees: StaleWorktreeAlert[] = []
    try {
      const r = await client.execute(
        `SELECT context, payload, last_seen_at, raised_at
           FROM action_queue_items
          WHERE kind = 'stale-worktree' AND state = 'open'
          ORDER BY raised_at DESC`,
      )
      for (const row of r.rows) {
        const r0 = row as unknown as Record<string, unknown>
        let ctx: Record<string, unknown> = {}
        let pld: Record<string, unknown> = {}
        try {
          const p = JSON.parse(r0.context as string)
          if (p && typeof p === 'object') ctx = p as Record<string, unknown>
        } catch { /* ignore */ }
        try {
          const p = JSON.parse(r0.payload as string)
          if (p && typeof p === 'object') pld = p as Record<string, unknown>
        } catch { /* ignore */ }
        const taskId = typeof ctx.taskId === 'string' ? ctx.taskId : null
        if (!taskId) continue
        staleWorktrees.push({
          taskId,
          status: typeof pld.status === 'string' ? pld.status : 'unknown',
          ageHours: typeof pld.ageHours === 'number' ? pld.ageHours : 0,
          updatedAt:
            typeof r0.last_seen_at === 'string'
              ? r0.last_seen_at
              : typeof r0.raised_at === 'string'
                ? r0.raised_at
                : new Date().toISOString(),
          prompt: typeof pld.prompt === 'string' ? pld.prompt : '',
          error: typeof pld.error === 'string' ? pld.error : null,
          branch: typeof pld.branch === 'string' ? pld.branch : null,
          blockerTaskId: null,
        })
      }
    } catch { /* action_queue_items table may not exist on a fresh repo */ }

    return { drafts, staleWorktrees }
  }

  const viewProposal: AppServices['viewProposal'] = (id) => getProposal(id)

  const viewFrameworkUpdate: AppServices['viewFrameworkUpdate'] = async () => {
    const cacheFile = resolvePath(resolveContext().stateDir, 'update.json')
    const selfUpdatable = classifyInstallRoute() === 'prod'
    try {
      const raw = await readFile(cacheFile, 'utf8')
      const cached = JSON.parse(raw) as Omit<FrameworkUpdateState, 'selfUpdatable'>
      return { ...cached, selfUpdatable }
    } catch {
      return {
        installed: MARS_VERSION,
        latest: MARS_VERSION,
        available: false,
        checkedAt: null,
        releaseUrl: null,
        selfUpdatable,
      }
    }
  }

  const viewTerminalEvents: AppServices['viewTerminalEvents'] = () =>
    listTerminalEvents(getDefaultDomainTaskStore()).then((events) => ({ events }))

  const viewReleaseNotes: AppServices['viewReleaseNotes'] = async () => {
    try {
      const entries = await listReleaseNotes(getDefaultDomainTaskStore())
      return { entries }
    } catch {
      return { entries: [] }
    }
  }

  const viewReflect: AppServices['viewReflect'] = (opts) =>
    loadRecentTaskCorpus(opts)

  const viewArcs: AppServices['viewArcs'] = (opts) =>
    listDeepReflectArcCandidates(opts)

  const listKpis: AppServices['listKpis'] = () => defaultListKpis()

  const listKpisSeries: AppServices['listKpisSeries'] = (limit) =>
    readKpiSeries({ limit })

  const listKpiArcs: AppServices['listKpiArcs'] = (key) => defaultListKpiArcs(key)

  return {
    viewActionQueue,
    viewActionQueueHistory,
    viewAlerts,
    viewAlert,
    listKpis,
    listKpisSeries,
    listKpiArcs,
    viewTasks,
    viewProgress,
    viewProposals,
    viewProposal,
    viewStepSpans,
    viewRunTimeline,
    viewSessions,
    viewTerminalEvents,
    viewReleaseNotes,
    viewReflect,
    viewArcs,
    viewFrameworkUpdate,
  }
}
