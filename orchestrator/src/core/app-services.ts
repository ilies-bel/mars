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

import { readFile, readdir } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { resolveContext, getRepoRoot } from './context'
import { readGlossaryFile, generateDefaultSurfaceForms } from './lib/glossary'
import {
  getDefaultDomainTaskStore,
  getCompositionRootClient,
  runCompositionRootMigrations,
} from './store/task-store'
import { buildSessionsView } from './daemon/view/sessions'
import { listTerminalEvents } from './daemon/view/terminal-events'
import { listReleaseNotes } from './daemon/view/release-notes'
import { getProposal, isProposalSource } from './proposals'
import { MARS_VERSION } from '../version'
import { classifyInstallRoute } from './daemon/install-route'
import { listAlerts, showAlert, type Alert, type AlertSources } from './lib/alert'
import type { RaiseActionQueueItem } from './lib/action-queue'
import { loadRecentTaskCorpus, type ReflectCorpus, type LoadCorpusOptions } from './lib/reflect-query'
import { listDeepReflectArcCandidates, type ArcCandidate } from './lib/deep-reflect-query'
import {
  computeScorerTrend,
  listScorerResults,
  listScoredWorkflows,
  type ScorerResult,
  type ScorerTrend,
} from './scorer-results'
import {
  listWorkflowConfigs,
  type WorkflowConfig,
} from './workflow-configs'
import {
  listPromotionLedgerEntries,
  type PromotionLedgerEntry,
} from './promotion-ledger'
import { listLoopLedger, type LoopLedgerEntry } from './lib/loop-ledger'
import { resolveStateClient } from './store/state-client'
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
import type {
  ActionQueueRow,
  DerivedActionQueueFilter,
  PersistedActionQueueRow,
  TaskForActionQueue,
} from './daemon/view/action-queue'
import type { TerminalEvent } from './daemon/view/terminal-events'
import type { ReleaseNoteEntry } from './daemon/view/release-notes'
import type { Session } from './daemon/view/sessions'
import type { ProgressAggregates, ProgressTask, ProposalNode } from './daemon/view/progress'
import type {
  StepSpan,
  RunTimeline,
  RunTimelineStep,
  StepPromptView,
  FrameworkUpdateState,
  DraftFeature,
  StaleWorktreeAlert,
  PrimitiveSummary,
  PrimitiveDetail,
  PrimitiveObservedTool,
  PrimitiveRun,
  PrimitivePark,
} from './daemon/http-server'
import {
  PRIMITIVE_CATALOG,
  PRIMITIVE_NAMES,
  isPrimitiveName,
  primitiveForSpan,
  buildWorkerProfiles,
  type PrimitiveCatalogEntry,
} from './lib/primitive-catalog'
import { loadWorkerRegistry, type WorkerDeclaration } from './workers/persisted-registry'
import {
  extractFirstUserMessageText,
  recoverPromptFromDiskTranscript,
} from './lib/step-prompt-recovery'
import { extractAgentToolCalls, type AgentToolCall } from './lib/claude-stream'
import { buildSituationReport, type SituationSemaphoreSnapshot } from './lib/situation-report'

export type { AgentToolCall }

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
  /**
   * Optional: fetch the result_json for each step in a workflow run, keyed by
   * step_name. When not provided, resultJson is null on all RunTimelineStep
   * entries. The daemon wires this to the workflow store backed by mars.db.
   */
  getStepResultsForRun?: (runId: string) => Promise<Map<string, string | null>>
  /**
   * Optional: supply the operator-declared Worker declarations for the
   * primitive tool-surface projection. Defaults to reading
   * `.mars/worker-registry.json` via the resolved repo context; tests inject
   * a fixed list so assertions never depend on the host repo's registry.
   */
  loadWorkerDeclarations?: () => WorkerDeclaration[]
  /**
   * Optional: list awaiting-human parks for awaitHuman's run-history facet.
   * Defaults to reading the action queue (kind 'awaiting-human'); tests
   * inject a fixed list so assertions never depend on the host repo's DB.
   */
  listAwaitingHumanParks?: () => Promise<PrimitivePark[]>
  /** Current worker-pool state, supplied by the daemon's semaphore owner. */
  getSituationSemaphoreSnapshot?: () => SituationSemaphoreSnapshot
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
  /** Render deterministic stored state before the first paid Subject turn. */
  buildSituationReport: () => Promise<string>
  /** Create a fresh inline Subject with its zero-token situation and acknowledgment. */
  openSubject: (input: { title: string; acknowledgment: string }) => Promise<{ threadId: string }>
  // ── alerts (arc-rooted read aggregate, ADR-0054) ───────────────────────────
  viewAlerts: () => Promise<Alert[]>
  viewAlert: (arcId: string) => Promise<Alert | null>
  /**
   * Pull an Alert into a chat thread (human-triggered, ADR-0048). Loads the
   * Alert for `arcId`, builds its card segment, and creates (or reuses) an
   * alert-origin thread. Returns `{ threadId }`, or `null` when no Alert
   * applies to the arc. Picking an Alert does NOT clear it from the Bell.
   */
  startThreadFromAlert: (arcId: string) => Promise<{ threadId: string } | null>
  /**
   * The top Alert the hero "next action" shortcut grabs, or `null` when none.
   * The steerable default for "what should I look at next".
   */
  nextActionAlert: () => Promise<Alert | null>
  // ── kpis ───────────────────────────────────────────────────────────────────
  listKpis: () => Promise<KpiRecord[]>
  listKpisSeries: (limit: number) => Promise<KpiSeries>
  listKpiArcs: (key: KpiKey) => Promise<KpiArcsResult>
  // ── task / progress / proposals views ───────────────────────────────────────
  viewTasks: () => Promise<{ tasks: unknown[] }>
  viewTask: (id: string) => Promise<{ task: unknown } | null>
  viewProgress: () => Promise<{ tasks: ProgressTask[]; proposals: ProposalNode[]; aggregates: ProgressAggregates }>
  viewProposals: () => Promise<{ drafts: DraftFeature[]; staleWorktrees: StaleWorktreeAlert[] }>
  viewProposal: (id: string) => Promise<Proposal | null>
  // ── trace-derived views ─────────────────────────────────────────────────────
  viewStepSpans: (params: { originId?: string; taskId?: string }) => Promise<{ spans: StepSpan[] }>
  viewRunTimeline: (taskId: string) => Promise<RunTimeline>
  viewStepPrompt: (params: { workflowInstanceId: string; stepName: string }) => Promise<StepPromptView>
  /**
   * The Coder's own tool invocations for a specific Claude session, extracted
   * from `task_transcripts` chunks. Returns an empty list when no transcript
   * chunks are stored for the given (taskId, sessionId) pair — pre-existing
   * runs stay empty.
   */
  viewAgentToolCalls: (taskId: string, sessionId: string) => Promise<{ calls: AgentToolCall[] }>
  // ── primitives (facet of the Studio surface) ───────────────────────────────
  viewPrimitives: () => Promise<{ primitives: PrimitiveSummary[] }>
  viewPrimitive: (params: { name: string; limit?: number }) => Promise<PrimitiveDetail | null>
  viewSessions: (agentName: string) => Promise<{ sessions: Session[] }>
  viewTerminalEvents: () => Promise<{ events: TerminalEvent[] }>
  viewReleaseNotes: () => Promise<{ entries: ReleaseNoteEntry[] }>
  // ── reflect / arcs ──────────────────────────────────────────────────────────
  viewReflect: (opts?: LoadCorpusOptions) => Promise<ReflectCorpus>
  viewArcs: (opts?: { limit?: number; withTranscriptOnly?: boolean }) => Promise<ArcCandidate[]>
  // ── scorer results (record-only quality signal, PRD 6cf85bc9) ──────────────
  viewScorerTrend: (opts?: {
    workflow?: string
    window?: number
  }) => Promise<{ trends: ScorerTrend[]; recent: ScorerResult[] }>
  viewScorerWorkflows: () => Promise<{ workflows: string[] }>
  // ── framework update (poller cache reader) ──────────────────────────────────
  viewFrameworkUpdate: () => Promise<FrameworkUpdateState>
  // ── workflow configs and promotion ledger (PRD 5b73d277) ──────────────────
  viewWorkflowConfigs: (workflow: string) => Promise<{ configs: WorkflowConfig[] }>
  viewPromotionLedger: (workflow?: string) => Promise<{ entries: PromotionLedgerEntry[] }>
  // ── loop ledger — per-run score history joined with promotion decisions (PRD 41aa2fb2) ──
  viewLoopLedger: (workflow: string, limit: number) => Promise<{ entries: LoopLedgerEntry[] }>
  // ── read views: glossary and skills ────────────────────────────────────────
  viewGlossary: () => Promise<{ terms: Array<{ term: string; definition: string; avoid: string[]; surfaceForms: string[] }> }>
  viewSkills: () => Promise<{ skills: Array<{ name: string; description: string; path: string }> }>
  // ── chat threads + messages ───────────────────────────────────────────────
  viewChatThreads: (options?: import('./lib/chat-store').ThreadListOptions) => Promise<{ threads: import('./lib/chat-store').ChatThreadApiView[] }>
  viewChatThread: (id: string) => Promise<{ thread: import('./lib/chat-store').ChatThreadApiView; messages: import('./lib/chat-store').ChatMessageApiView[] } | null>
  viewChatHistory: () => Promise<{ threads: import('./lib/chat-store').ChatThreadApiView[] }>
  viewChatConversation: () => Promise<{
    entries: import('./lib/chat-store').ChatConversationEntryApiView[]
    memoryStartsAfterSeq: number
    memoryCutAt: number | null
    memoryCutReason: import('./daemon/chat-memory-window').MemoryCutReason | null
  }>
  viewSteward: (runtime: { liveCap: number; baselineCap: number; isPaused: boolean }) => Promise<{
    runtimeTuning: {
      acks: Array<{ text: string; timestamp: string; pair: { from: number; to: number } | null }>
      liveCap: number
      baselineCap: number
      ceiling: number
      bumpFactor: number
      thresholdFactor: number
      sustainMs: number
      checkMs: number
    }
    workflowPatches: {
      rows: Array<{ id: string; workflow_path: string; unified_diff: string; rationale: string; status: string; created_at: string }>
      hasCallers: boolean
    }
    signatureStorm: {
      current_signature: string | null
      streak_count: number
      last_task_id: string | null
      tripped: boolean
      updated_at: string | null
      signatureStormAqCount: number
      tripThreshold: number
      isPaused: boolean
    }
    agentSpec: {
      name: string
      model: string
      allowedTools: readonly string[]
      eventVariants: string[]
      dispatchSites: number
    }
  }>
}

/**
 * Construct the AppServices over the daemon-provided collaborators. The returned
 * object is a plain bag of named use-case functions — no DI container, no plugin
 * registry. Each function is a verbatim move of the former `startDaemon` closure
 * (or `http-server.ts` `default*` fallback) of the same name.
 */
export const createAppServices = (deps: AppServicesDeps): AppServices => {
  const { traceStore, buildAlertSources, getStepResultsForRun } = deps

  // Default reads for the primitive facet — swallow "not in a repo / table
  // absent" so the facet degrades to built-ins-only / no-parks instead of a 500.
  const loadWorkerDeclarations =
    deps.loadWorkerDeclarations ??
    ((): WorkerDeclaration[] => {
      try {
        return loadWorkerRegistry(resolveContext().stateDir)
      } catch {
        return []
      }
    })
  const listAwaitingHumanParks =
    deps.listAwaitingHumanParks ??
    (async (): Promise<PrimitivePark[]> => {
      try {
        const { listActionQueueItems } = await import('./lib/action-queue')
        const items = await listActionQueueItems('all')
        return items
          .filter((item) => item.kind === 'awaiting-human')
          .map((item) => ({
            taskId:
              typeof item.payload.taskId === 'string' ? item.payload.taskId : null,
            stepName:
              typeof item.payload.stepName === 'string' ? item.payload.stepName : null,
            // Action-queue storage uses epoch milliseconds; this HTTP facet
            // deliberately continues to expose its documented ISO timestamp.
            parkedAt: new Date(item.raisedAt).toISOString(),
            leaseOwner:
              typeof item.payload.leaseOwner === 'string'
                ? item.payload.leaseOwner
                : null,
          }))
      } catch {
        return []
      }
    })

  const viewTasks: AppServices['viewTasks'] = () =>
    getDefaultDomainTaskStore()
      .listTasks()
      .then((tasks) => ({ tasks }))

  const buildSubjectSituationReport: AppServices['buildSituationReport'] = () =>
    buildSituationReport({
      listTasks: () => getDefaultDomainTaskStore().listTasks(),
      getSemaphoreSnapshot: deps.getSituationSemaphoreSnapshot ?? (() => ({ inUse: 0, limit: 0 })),
      listActionQueue: () => viewActionQueue('open'),
    })

  const openSubject: AppServices['openSubject'] = async ({ title, acknowledgment }) => {
    const { appendMessage, createThread } = await import('./lib/chat-store')
    const situation = await buildSubjectSituationReport()
    const thread = await createThread(title, undefined, undefined, situation)
    await appendMessage(
      thread.id,
      'user',
      acknowledgment,
      [{ type: 'text', text: acknowledgment }],
      { kind: 'acknowledgment', contextScope: 'main' },
    )
    return { threadId: thread.id }
  }

  const viewTask: AppServices['viewTask'] = (id) =>
    getDefaultDomainTaskStore()
      .getTask(id)
      .then((task) => (task ? { task } : null))

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

    // Map (workflowInstanceId, stepName) → ended events for O(n) pairing.
    // A step name can repeat within the same workflowInstanceId (e.g. two
    // run-claude-code steps), so we collect an array per key and shift from
    // it for each matching step_started to preserve 1:1 ordering.
    // Both arrays arrive in DESC order (newest first) from the trace store;
    // shifting pairs each start with its positionally-matching end.
    const endedMap = new Map<string, Array<(typeof ended)[0]>>()
    for (const e of ended) {
      const wfId = e.payload.workflowInstanceId
      const stepName = e.payload.stepName
      if (typeof wfId === 'string' && typeof stepName === 'string') {
        const key = `${wfId}\0${stepName}`
        let arr = endedMap.get(key)
        if (!arr) { arr = []; endedMap.set(key, arr) }
        arr.push(e)
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
        const endEvent = key ? endedMap.get(key)?.shift() : undefined

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
          startedAt: new Date(s.timestamp).toISOString(),
          endedAt: endEvent ? new Date(endEvent.timestamp).toISOString() : null,
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

    // Map (workflowInstanceId, stepName) → ended events for O(n) pairing.
    // A step name can repeat within the same workflowInstanceId (e.g. two
    // run-claude-code steps), so we collect an array per key and shift from
    // it for each matching step_started to preserve 1:1 ordering.
    const endedMap = new Map<string, Array<(typeof ended)[0]>>()
    for (const e of ended) {
      const wfId = e.payload.workflowInstanceId
      const stepName = e.payload.stepName
      if (typeof wfId === 'string' && typeof stepName === 'string') {
        const key = `${wfId}\0${stepName}`
        let arr = endedMap.get(key)
        if (!arr) { arr = []; endedMap.set(key, arr) }
        arr.push(e)
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
      const endEvent = endedMap.get(key)?.shift()

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
        startedAt: new Date(s.timestamp).toISOString(),
        endedAt: endEvent ? new Date(endEvent.timestamp).toISOString() : null,
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
        resultJson: null,
        summary:
          endEvent && typeof endEvent.payload.summary === 'string'
            ? endEvent.payload.summary
            : null,
      }

      runMap.get(wfId)!.push(step)
    }

    // Fetch per-step result_json from the workflow store, keyed by
    // (runId, stepName). Done in a single pass after collecting all run ids so
    // we issue one query per run rather than one per step. Silently falls back
    // to null when the dep is absent (tests) or the table is missing.
    const runIds = Array.from(runMap.keys())
    const stepResultsByRun = new Map<string, Map<string, string | null>>()
    if (getStepResultsForRun && runIds.length > 0) {
      await Promise.all(
        runIds.map(async (runId) => {
          try {
            const m = await getStepResultsForRun(runId)
            stepResultsByRun.set(runId, m)
          } catch {
            // Ignore: resultJson stays null for this run.
          }
        }),
      )
    }

    // Merge result_json into each step.
    for (const [runId, steps] of runMap) {
      const resultMap = stepResultsByRun.get(runId)
      if (resultMap) {
        for (const step of steps) {
          const r = resultMap.get(step.stepName)
          if (r !== undefined) step.resultJson = r
        }
      }
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

  /**
   * The composed prompt sent to one step's worker, keyed by
   * (workflowInstanceId, stepName).
   *
   * Resolution order — first hit wins:
   *   1. `promptText` on the step_started payload (persisted at emit time by
   *      run-worker-with-span.ts) → source 'persisted'.
   *   2. Best-effort transcript recovery for pre-persistence runs, all keyed
   *      by the step's claudeSessionId where possible → source 'recovered':
   *      a. streaming `task_transcripts` chunks (session-precise),
   *      b. the on-disk `~/.claude/projects/{proj}/<sessionId>.jsonl` transcript
   *         (session-precise),
   *      c. the durable `task_durable_transcripts` blob (task-level — one row
   *         per task, so only trusted when its recorded session/step cannot
   *         be checked; still labelled 'recovered', never 'persisted').
   *   3. Nothing found → { prompt: null, source: null }; the UI renders an
   *      explicit empty state, never invented data.
   *
   * The step_started/step_ended lookups use the store's payload substring
   * filter (`q: workflowInstanceId`) so this stays a narrow query even though
   * workflowInstanceId is not an indexed column.
   */
  const viewStepPrompt: AppServices['viewStepPrompt'] = async ({
    workflowInstanceId,
    stepName,
  }) => {
    const miss: StepPromptView = { workflowInstanceId, stepName, prompt: null, source: null }

    const started = await traceStore.query({
      kind: ['step_started'],
      q: workflowInstanceId,
      limit: 1000,
    })
    // Newest-first ordering from the store: the first match is the latest
    // emission for this (workflowInstanceId, stepName) pair.
    const startEvent = started.find(
      (e) =>
        e.payload.workflowInstanceId === workflowInstanceId &&
        e.payload.stepName === stepName,
    )
    if (!startEvent) return miss

    if (typeof startEvent.payload.promptText === 'string') {
      return {
        workflowInstanceId,
        stepName,
        prompt: startEvent.payload.promptText,
        source: 'persisted',
      }
    }

    // Pre-persistence run — recover best-effort from stored transcripts.
    const recovered = (prompt: string): StepPromptView => ({
      workflowInstanceId,
      stepName,
      prompt,
      source: 'recovered',
    })

    const taskId = startEvent.taskId
    const ended = await traceStore.query({
      kind: ['step_ended'],
      q: workflowInstanceId,
      limit: 1000,
    })
    const endEvent = ended.find(
      (e) =>
        e.payload.workflowInstanceId === workflowInstanceId &&
        e.payload.stepName === stepName,
    )
    const sessionId =
      endEvent && typeof endEvent.payload.sessionId === 'string'
        ? endEvent.payload.sessionId
        : null

    // (a) Streaming chunks — keyed by (taskId, sessionId), session-precise.
    if (taskId !== null && sessionId !== null && traceStore.readTranscriptChunks) {
      try {
        const events = await traceStore.readTranscriptChunks(taskId, sessionId)
        const text = extractFirstUserMessageText(events)
        if (text !== null) return recovered(text)
      } catch {
        // best-effort — fall through to the next recovery tier
      }
    }

    // (b) On-disk claude transcript — keyed by sessionId, session-precise.
    if (sessionId !== null) {
      const text = await recoverPromptFromDiskTranscript(sessionId)
      if (text !== null) return recovered(text)
    }

    // (c) Durable blob — task-level last resort (one row per task).
    if (taskId !== null && traceStore.readDurableTranscript) {
      try {
        const json = await traceStore.readDurableTranscript(taskId)
        if (json !== null) {
          const parsed: unknown = JSON.parse(json)
          if (Array.isArray(parsed)) {
            const text = extractFirstUserMessageText(parsed)
            if (text !== null) return recovered(text)
          }
        }
      } catch {
        // best-effort — nothing recoverable
      }
    }

    return miss
  }

  const viewAgentToolCalls: AppServices['viewAgentToolCalls'] = async (taskId, sessionId) => {
    const events = (await traceStore.readTranscriptChunks?.(taskId, sessionId)) ?? []
    return { calls: extractAgentToolCalls(events) }
  }

  // ── primitives — the per-primitive facet of the Studio surface ─────────────

  const DEFAULT_PRIMITIVE_RUN_WINDOW = 50
  const MAX_PRIMITIVE_RUN_WINDOW = 200

  const toPrimitiveSummary = (entry: PrimitiveCatalogEntry): PrimitiveSummary => ({
    name: entry.name,
    description: entry.description,
    phase: entry.phase,
    executor: entry.executor,
  })

  const viewPrimitives: AppServices['viewPrimitives'] = async () => ({
    primitives: PRIMITIVE_NAMES.map((name) =>
      toPrimitiveSummary(PRIMITIVE_CATALOG[name]),
    ),
  })

  /**
   * The per-primitive facet: identity, tool surface, and recent-N run history.
   *
   * Tool surface follows the two-section rule and never conflates them:
   *  (a) agent primitives project the DECLARED Worker Authorization profiles
   *      (code-pinned WORKER_CONFIGS + operator registry);
   *  (b) shell primitives list the OBSERVED tools from recent `tool_invoked`
   *      trace events on their phase;
   *  (c) awaitHuman has no tool surface — and its history is parks
   *      (awaiting-human action-queue rows), never fabricated spans.
   *
   * Run history pairs step_started/step_ended exactly like viewStepSpans but
   * filters by the primitive's phase (with the behaviour-verify step-name
   * discriminator on the shared 'verify' phase) and returns newest-first.
   * Aggregates over this window are the caller's job and must be labelled
   * "last N runs" — all-time rollups are deliberately not computed (the
   * phase column is unindexed; see the PRD).
   */
  const viewPrimitive: AppServices['viewPrimitive'] = async ({ name, limit }) => {
    if (!isPrimitiveName(name)) return null
    const entry = PRIMITIVE_CATALOG[name]
    const window = Math.min(
      Math.max(limit ?? DEFAULT_PRIMITIVE_RUN_WINDOW, 1),
      MAX_PRIMITIVE_RUN_WINDOW,
    )

    // (a) Declared agent tool surface.
    const workers = buildWorkerProfiles(
      name,
      entry.executor === 'agent' ? loadWorkerDeclarations() : [],
    )

    // (b) Observed shell tools on the primitive's phase.
    let observedTools: PrimitiveObservedTool[] = []
    if (entry.executor === 'shell' && entry.phase !== null) {
      const events = await traceStore.query({
        kind: ['tool_invoked'],
        phase: [entry.phase],
        limit: 500,
      })
      // Newest-first from the store: the first sighting of a tool is its most
      // recent invocation.
      const byTool = new Map<string, { count: number; lastInvokedAt: string }>()
      for (const e of events) {
        const tool = typeof e.payload.tool === 'string' ? e.payload.tool : null
        if (tool === null) continue
        const current = byTool.get(tool)
        if (current) current.count += 1
        else byTool.set(tool, { count: 1, lastInvokedAt: new Date(e.timestamp).toISOString() })
      }
      observedTools = [...byTool.entries()]
        .map(([tool, v]) => ({ tool, count: v.count, lastInvokedAt: v.lastInvokedAt }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    }

    // (c) Run history — recent Step spans on the primitive's phase.
    let runs: PrimitiveRun[] = []
    if (entry.phase !== null) {
      const fetchLimit = Math.min(window * 4, 1000)
      const [started, ended] = await Promise.all([
        traceStore.query({ kind: ['step_started'], phase: [entry.phase], limit: fetchLimit }),
        traceStore.query({ kind: ['step_ended'], phase: [entry.phase], limit: fetchLimit }),
      ])

      const endedMap = new Map<string, Array<(typeof ended)[0]>>()
      for (const e of ended) {
        const wfId = e.payload.workflowInstanceId
        const stepName = e.payload.stepName
        if (typeof wfId === 'string' && typeof stepName === 'string') {
          const key = `${wfId}\0${stepName}`
          let arr = endedMap.get(key)
          if (!arr) { arr = []; endedMap.set(key, arr) }
          arr.push(e)
        }
      }

      runs = started
        .filter((s) => {
          const stepName = s.payload.stepName
          return (
            typeof stepName === 'string' && primitiveForSpan(s.phase, stepName) === name
          )
        })
        .slice(0, window)
        .map((s) => {
          const stepName = s.payload.stepName as string
          const wfId =
            typeof s.payload.workflowInstanceId === 'string'
              ? s.payload.workflowInstanceId
              : ''
          const endEvent = wfId ? endedMap.get(`${wfId}\0${stepName}`)?.shift() : undefined
          return {
            stepName,
            workflowInstanceId: wfId,
            outcome: endEvent
              ? typeof endEvent.payload.outcome === 'string'
                ? endEvent.payload.outcome
                : 'completed'
              : 'running',
            startedAt: new Date(s.timestamp).toISOString(),
            endedAt: endEvent ? new Date(endEvent.timestamp).toISOString() : null,
            durationMs:
              endEvent && typeof endEvent.payload.durationMs === 'number'
                ? endEvent.payload.durationMs
                : null,
            taskId: s.taskId,
            originId: s.originId,
            workerName:
              typeof s.payload.workerName === 'string' ? s.payload.workerName : null,
            claudeSessionId:
              endEvent && typeof endEvent.payload.sessionId === 'string'
                ? endEvent.payload.sessionId
                : null,
          }
        })
      // Store order is newest-first — kept as-is: recent history reads top-down.
    }

    // (d) awaitHuman history = parks, never spans.
    const parks =
      name === 'awaitHuman' ? (await listAwaitingHumanParks()).slice(0, window) : []

    return {
      primitive: toPrimitiveSummary(entry),
      workers,
      observedTools,
      caveats: [...entry.caveats],
      runs,
      parks,
      window,
    }
  }

  const viewSessions: AppServices['viewSessions'] = (agentName) =>
    buildSessionsView(traceStore, agentName)

  const viewAlerts: AppServices['viewAlerts'] = async () =>
    listAlerts(await buildAlertSources())

  const viewAlert: AppServices['viewAlert'] = async (arcId) =>
    showAlert(arcId, await buildAlertSources())

  const startThreadFromAlert: AppServices['startThreadFromAlert'] = async (arcId) => {
    const alert = await showAlert(arcId, await buildAlertSources())
    if (alert === null) return null

    const { buildAlertSegment } = await import('./lib/action-queue')
    const { startThreadFromAlert: storeStartThreadFromAlert } = await import('./lib/chat-store')

    // Reconstruct the raise-item shape `buildAlertSegment` consumes from the
    // Alert so the seed card reuses the same recipe-driven copy and verbs the
    // Bell/alert path uses. `arc-failed` maps to the registered `failed` kind;
    // `stale-worktree` passes through. The arc id is the entity/origin id, and
    // the arc's intent rides in `payload.goal`.
    const item: RaiseActionQueueItem = {
      kind: alert.kind === 'stale-worktree' ? 'stale-worktree' : 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: alert.reason,
      body: alert.technical || alert.reason,
      payload: { taskId: alert.arcId, goal: alert.goal },
      context: {},
      raisedBy: 'operator',
      signature: alert.arcId,
      originTaskId: alert.arcId,
    }
    const segment = buildAlertSegment(item, alert.arcId)
    const situation = await buildSubjectSituationReport()
    const thread = await storeStartThreadFromAlert(
      alert.arcId,
      alert.goal || alert.reason,
      segment,
      situation,
    )
    return { threadId: thread.id }
  }

  const nextActionAlert: AppServices['nextActionAlert'] = async () => {
    // `viewAlerts()` (→ `listAlerts`) carries no per-Alert priority field to
    // sort by — an Alert is a pure derivation with no `priority`. Rather than
    // join every Alert back to its action-queue row just to pick one, we return
    // the first Alert in the derivation's stable order, which lists arc failures
    // (the actionable family) ahead of stale-worktree housekeeping. That is the
    // steerable "higher-priority-first" default without the extra coupling.
    const alerts = await viewAlerts()
    return alerts[0] ?? null
  }

  const listActionQueueTaskGraph = async (
    rows: readonly PersistedActionQueueRow[],
  ): Promise<TaskForActionQueue[]> => {
    const { getActionQueueEntityId } = await import('./daemon/view/action-queue')
    const entityIds = [...new Set(rows.map(getActionQueueEntityId))]
    if (entityIds.length === 0) return []

    const c = getCompositionRootClient()
    const result = await c.execute({
      sql: `WITH input_ids(id) AS (
              SELECT unnest(?::text[])
            ), related_ids(id) AS (
              SELECT id FROM input_ids
              UNION
              SELECT t.fix_for_task_id
                FROM tasks t JOIN input_ids i ON t.id = i.id
               WHERE t.fix_for_task_id IS NOT NULL
              UNION
              SELECT b.task_id
                FROM task_blockers b JOIN input_ids i ON b.blocker_task_id = i.id
              UNION
              SELECT b.blocker_task_id
                FROM task_blockers b JOIN input_ids i ON b.task_id = i.id
              UNION
              SELECT t.id
                FROM tasks t JOIN input_ids i ON t.fix_for_task_id = i.id
            )
            SELECT t.id, t.status, t.prompt, t.failure_signature, t.branch,
                   t.updated_at, t.parent_proposal_id, t.fix_for_task_id,
                   t.lease_owner, t.leased_at, t.lease_note,
                   COALESCE(array_agg(b.blocker_task_id)
                     FILTER (WHERE b.blocker_task_id IS NOT NULL), '{}') AS blocked_by
              FROM tasks t
              JOIN related_ids r ON r.id = t.id
              LEFT JOIN task_blockers b ON b.task_id = t.id
             GROUP BY t.id, t.status, t.prompt, t.failure_signature, t.branch,
                      t.updated_at, t.parent_proposal_id, t.fix_for_task_id,
                      t.lease_owner, t.leased_at, t.lease_note`,
      args: [entityIds],
    })
    return result.rows.map((row) => {
      const task = row as Record<string, unknown>
      return {
        id: task.id as string,
        status: task.status as string,
        prompt: task.prompt as string,
        blockedBy: (task.blocked_by as string[]) ?? [],
        parentProposalId: (task.parent_proposal_id as string | null) ?? null,
        failureSignature: (task.failure_signature as string | null) ?? null,
        branch: (task.branch as string | null) ?? null,
        updatedAt: task.updated_at as string,
        fixForTaskId: (task.fix_for_task_id as string | null) ?? null,
        leaseOwner: (task.lease_owner as string | null) ?? null,
        leasedAt: (task.leased_at as string | null) ?? null,
        leaseNote: (task.lease_note as string | null) ?? null,
      }
    })
  }

  const viewActionQueue: AppServices['viewActionQueue'] = async (filter) => {
    const { buildActionQueueView } = await import('./daemon/view/action-queue')
    const { listVisibleActionQueueItems } = await import('./lib/action-queue')

    await runCompositionRootMigrations()

    // Build the state store adapter.
    const stateStore = {
      listOpenActionQueueItems: async () => {
        const items = await listVisibleActionQueueItems()
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
      listTasksForActionQueueItems: listActionQueueTaskGraph,
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
      listTasksForActionQueueItems: listActionQueueTaskGraph,
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
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'proposals'`,
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
        const source: DraftFeature['source'] = isProposalSource(src) ? src : 'human'
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
          updatedAt: new Date(
            typeof r0.last_seen_at === 'number'
              ? r0.last_seen_at
              : typeof r0.raised_at === 'number'
                ? r0.raised_at
                : Date.now(),
          ).toISOString(),
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

  // Per-workflow score trend (median + p90, never a bare mean) plus the
  // recent result rows. This is the queryable surface Studio/UI read; how
  // it renders is out of scope here (PRD 6cf85bc9).
  const viewScorerTrend: AppServices['viewScorerTrend'] = async (opts) => {
    const window = opts?.window ?? 20
    const workflows = opts?.workflow
      ? [opts.workflow]
      : await listScoredWorkflows()
    const trends: ScorerTrend[] = []
    for (const workflow of workflows) {
      trends.push(await computeScorerTrend(workflow, window))
    }
    const recent = await listScorerResults({
      ...(opts?.workflow ? { workflow: opts.workflow } : {}),
      limit: window,
    })
    return { trends, recent }
  }

  const viewScorerWorkflows: AppServices['viewScorerWorkflows'] = async () => {
    const workflows = await listScoredWorkflows()
    return { workflows }
  }

  const viewWorkflowConfigs: AppServices['viewWorkflowConfigs'] = async (workflow) => {
    const client = resolveStateClient()
    const configs = await listWorkflowConfigs(client, workflow)
    return { configs }
  }

  const viewPromotionLedger: AppServices['viewPromotionLedger'] = async (workflow) => {
    const client = resolveStateClient()
    const entries = await listPromotionLedgerEntries(client, workflow)
    return { entries }
  }

  const viewLoopLedger: AppServices['viewLoopLedger'] = async (workflow, limit) => {
    const entries = await listLoopLedger(workflow, limit)
    return { entries }
  }

  const viewChatThreads: AppServices['viewChatThreads'] = async (options) => {
    const { listThreads, toThreadApiView } = await import('./lib/chat-store')
    const threads = await listThreads(options)
    return { threads: threads.map((t) => toThreadApiView(t, t.last_message_role)) }
  }

  const viewChatThread: AppServices['viewChatThread'] = async (id) => {
    const { getThread, toThreadApiView, toMessageApiView } = await import('./lib/chat-store')
    const result = await getThread(id)
    if (!result) return null
    const lastMsg = result.messages.at(-1)
    const lastRole = lastMsg?.role ?? null
    return {
      thread: toThreadApiView(result.thread, lastRole),
      messages: result.messages.map((m) =>
        toMessageApiView(m, result.feedbacks.get(m.id) ?? null),
      ),
    }
  }

  const viewChatHistory: AppServices['viewChatHistory'] = async () => {
    const { listClosedSubjects, toThreadApiView } = await import('./lib/chat-store')
    const threads = await listClosedSubjects()
    return { threads: threads.map((t) => toThreadApiView(t, t.last_message_role)) }
  }

  const viewChatConversation: AppServices['viewChatConversation'] = async () => {
    const { listConversationEntries } = await import('./lib/chat-store')
    const { readMainMemoryWindow } = await import('./daemon/chat-memory-window')
    const [entries, memoryWindow] = await Promise.all([
      listConversationEntries(),
      readMainMemoryWindow(),
    ])
    return {
      entries,
      memoryStartsAfterSeq: memoryWindow.startsAfterSeq,
      memoryCutAt: memoryWindow.cutAt,
      memoryCutReason: memoryWindow.reason,
    }
  }

  const listKpis: AppServices['listKpis'] = () => defaultListKpis()

  const listKpisSeries: AppServices['listKpisSeries'] = (limit) =>
    readKpiSeries({ limit })

  const listKpiArcs: AppServices['listKpiArcs'] = (key) => defaultListKpiArcs(key)

  const viewGlossary: AppServices['viewGlossary'] = async () => {
    const doc = await readGlossaryFile(resolvePath(getRepoRoot(), 'CONTEXT.md'))
    return {
      terms: doc.terms.map((t) => ({
        term: t.term,
        definition: t.definition,
        avoid: [...t.aliases],
        surfaceForms: [...(t.surfaceForms.length > 0 ? t.surfaceForms : generateDefaultSurfaceForms(t.term))],
      })),
    }
  }

  const viewSkills: AppServices['viewSkills'] = async () => {
    const skillsDir = resolvePath(getRepoRoot(), '.claude', 'skills')
    let entries: string[]
    try {
      entries = await readdir(skillsDir)
    } catch {
      return { skills: [] }
    }
    const skills: Array<{ name: string; description: string; path: string }> = []
    for (const entry of entries) {
      const skillPath = resolvePath(skillsDir, entry, 'SKILL.md')
      let content: string
      try {
        content = await readFile(skillPath, 'utf8')
      } catch {
        // Skill directory without SKILL.md — skip
        skills.push({ name: entry, description: '', path: skillPath })
        continue
      }
      // Parse YAML frontmatter between --- delimiters
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      let name = entry
      let description = ''
      if (fmMatch) {
        const fm = fmMatch[1] ?? ''
        const nameMatch = fm.match(/^name:\s*(.+)$/m)
        const descMatch = fm.match(/^description:\s*(.+)$/m)
        if (nameMatch?.[1]) name = nameMatch[1].trim()
        if (descMatch?.[1]) description = descMatch[1].trim()
      }
      skills.push({ name, description, path: skillPath })
    }
    return { skills }
  }

  const viewSteward: AppServices['viewSteward'] = async (runtime) => {
    const client = getCompositionRootClient()

    // 1. Runtime tuning acks — chat_threads WHERE title = 'Steward: runtime tuning'
    //    joined to chat_messages WHERE kind = 'acknowledgment', newest first.
    let acks: Array<{ text: string; timestamp: string; pair: { from: number; to: number } | null }> = []
    try {
      const acksResult = await client.execute(
        `SELECT m.content, m.created_at
           FROM chat_messages m
           JOIN chat_threads t ON t.id = m.thread_id
          WHERE t.title = 'Steward: runtime tuning'
            AND m.kind = 'acknowledgment'
          ORDER BY m.created_at DESC`,
      )
      acks = acksResult.rows.map((row) => {
        const r = row as unknown as { content: string; created_at: string }
        const text = r.content
        // Parse "from N to M" pattern defensively — free text; null on mismatch.
        const m = /from (\d+) to (\d+)/.exec(text)
        const pair = m ? { from: Number(m[1]), to: Number(m[2]) } : null
        return { text, timestamp: r.created_at, pair }
      })
    } catch {
      // Degrade gracefully on fresh repos without chat tables.
    }

    // 2. Workflow patch proposals — zero rows today; table may not exist.
    let patchRows: Array<{ id: string; workflow_path: string; unified_diff: string; rationale: string; status: string; created_at: string }> = []
    try {
      const patchResult = await client.execute(
        `SELECT id, workflow_path, unified_diff, rationale, status, created_at
           FROM workflow_patch_proposals
          ORDER BY created_at DESC`,
      )
      patchRows = patchResult.rows.map((row) => {
        const r = row as unknown as { id: string; workflow_path: string; unified_diff: string; rationale: string; status: string; created_at: string }
        return { id: r.id, workflow_path: r.workflow_path, unified_diff: r.unified_diff, rationale: r.rationale, status: r.status, created_at: String(r.created_at) }
      })
    } catch {
      // Table absent on fresh repos.
    }

    // 3. Signature storm — singleton row id=1 plus action_queue_items count.
    let streakRow: { current_signature: string | null; streak_count: number; last_task_id: string | null; tripped: boolean; updated_at: string | null } | null = null
    try {
      const streakResult = await client.execute(
        `SELECT current_signature, streak_count, last_task_id, tripped, updated_at
           FROM failure_signature_streak WHERE id = 1`,
      )
      if (streakResult.rows.length > 0) {
        const r = streakResult.rows[0] as unknown as { current_signature: string | null; streak_count: number | bigint; last_task_id: string | null; tripped: boolean | number; updated_at: string | null }
        streakRow = {
          current_signature: r.current_signature,
          streak_count: Number(r.streak_count),
          last_task_id: r.last_task_id,
          tripped: Boolean(r.tripped),
          updated_at: r.updated_at,
        }
      }
    } catch {
      // Table absent on fresh repos.
    }

    let signatureStormAqCount = 0
    try {
      const countResult = await client.execute(
        `SELECT COUNT(*) AS cnt FROM action_queue_items WHERE kind = 'signature-storm'`,
      )
      const r = countResult.rows[0] as unknown as { cnt: number | bigint } | undefined
      signatureStormAqCount = Number(r?.cnt ?? 0)
    } catch {
      // action_queue_items may not exist.
    }

    const { SIGNATURE_STORM_TRIP_THRESHOLD } = await import('./lib/signature-storm-monitor')

    return {
      runtimeTuning: {
        acks,
        liveCap: runtime.liveCap,
        baselineCap: runtime.baselineCap,
        ceiling: runtime.baselineCap * 2,
        bumpFactor: 1.33,
        thresholdFactor: 0.75,
        sustainMs: Number(process.env.MARS_BACKLOG_SUSTAIN_MS ?? 60_000),
        checkMs: Number(process.env.MARS_BACKLOG_CHECK_MS ?? 10_000),
      },
      workflowPatches: {
        rows: patchRows,
        hasCallers: false,
      },
      signatureStorm: {
        current_signature: streakRow?.current_signature ?? null,
        streak_count: streakRow?.streak_count ?? 0,
        last_task_id: streakRow?.last_task_id ?? null,
        tripped: streakRow?.tripped ?? false,
        updated_at: streakRow?.updated_at ?? null,
        signatureStormAqCount,
        tripThreshold: SIGNATURE_STORM_TRIP_THRESHOLD,
        isPaused: runtime.isPaused,
      },
      agentSpec: {
        name: 'steward',
        model: 'claude-sonnet-4-6',
        allowedTools: ['Read', 'Bash', 'Grep', 'Glob', 'PromptOptimize'],
        eventVariants: ['kpi-degraded', 'resource-load', 'onboarding', 'workflow-suggestion'],
        dispatchSites: 0,
      },
    }
  }

  return {
    viewActionQueue,
    viewActionQueueHistory,
    buildSituationReport: buildSubjectSituationReport,
    openSubject,
    viewAlerts,
    viewAlert,
    startThreadFromAlert,
    nextActionAlert,
    listKpis,
    listKpisSeries,
    listKpiArcs,
    viewTasks,
    viewTask,
    viewProgress,
    viewProposals,
    viewProposal,
    viewStepSpans,
    viewRunTimeline,
    viewStepPrompt,
    viewAgentToolCalls,
    viewPrimitives,
    viewPrimitive,
    viewSessions,
    viewTerminalEvents,
    viewReleaseNotes,
    viewReflect,
    viewArcs,
    viewScorerTrend,
    viewScorerWorkflows,
    viewWorkflowConfigs,
    viewPromotionLedger,
    viewLoopLedger,
    viewFrameworkUpdate,
    viewGlossary,
    viewSkills,
    viewChatThreads,
    viewChatThread,
    viewChatHistory,
    viewChatConversation,
    viewSteward,
  }
}
