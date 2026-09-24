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
import { localGitVcs } from './ports/vcs/local-git'
import { resolveGitBin, execProbe } from './lib/git/internal'
import { readGlossaryFile, generateDefaultSurfaceForms } from './lib/glossary'
import {
  getDefaultDomainTaskStore,
  getCompositionRootClient,
  runCompositionRootMigrations,
} from './store/task-store-default'
import { getDefaultMergeJobStore, type GateCheckEntry } from './store/merge-job-store'
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
import { readControlLevers, loadDaemonConfig } from './daemon/config'
import {
  computeScorerTrend,
  listScorerResults,
  listScoredWorkflows,
  type ScorerResult,
  type ScorerTrend,
} from './scorer-results'
import {
  listScorers,
  acceptScorer,
  dismissScorer,
  type Scorer,
} from './scorers'
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
import { parseVerifyOutput } from './lib/parse-verify-output'
import type { Proposal, ProposalSource } from './proposals'
import type {
  ActionQueueRow,
  DerivedActionQueueFilter,
  PersistedActionQueueRow,
  TaskForActionQueue,
} from './daemon/view/action-queue'
import type { DispatchPauseState } from './daemon/pause-state'
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
  DeepReflectionsListResult,
  DeepReflectionDetail,
  ReflectionSuggestionOutcome,
  HotPathsResult,
} from './daemon/http-server'
import {
  PRIMITIVE_CATALOG,
  isPrimitiveName,
  primitiveForSpan,
  buildWorkerProfiles,
  type PrimitiveCatalogEntry,
} from './lib/primitive-catalog'
import { listPrimitives } from '../workflows/primitives/registry'
import { loadWorkerRegistry, type WorkerDeclaration } from './workers/persisted-registry'
import { loadLeverRegistry } from './lib/lever-registry'
import { readLeverApplyHistory } from './lib/lever-apply'
import {
  extractFirstUserMessageText,
  recoverPromptFromDiskTranscript,
} from './lib/step-prompt-recovery'
import { extractAgentToolCalls, type AgentToolCall } from './lib/claude-stream'
import {
  buildSituationReport,
  countNeedsYou,
  type SituationSemaphoreSnapshot,
} from './lib/situation-report'
import {
  addVerifyGate,
  removeVerifyGate,
  restoreVerifyGate,
  listVerifyGates,
  getVerifyGate,
  type VerifyGate,
  type VerifyGateInput,
} from './verify-gates'
import { renderConversationNotice } from './lib/conversation-copy'

export type { AgentToolCall, VerifyGateInput, VerifyGate }

// ── Task-changes result type ──────────────────────────────────────────────────

/** One file entry in a task diff summary. */
export interface TaskChangesFileStat {
  path: string
  oldPath?: string
  status: 'A' | 'M' | 'D' | 'R' | 'C'
  additions: number
  deletions: number
}

/** One commit entry in a task diff summary. */
export interface TaskChangesCommit {
  sha: string
  subject: string
  authoredAt: string
}

/**
 * The result of {@link AppServices.viewTaskChanges}.
 *
 * When the branch and worktree are both gone and there is no tombstone,
 * `reason` is `'branch-gone'` and all collections are empty. `landedSha` is
 * non-null when the merge-commit SHA is known from the tombstone even though
 * the full diff cannot be reconstructed (e.g. the parent commit is no longer
 * locally reachable). In all other cases at least `base` and `head` are
 * non-null.
 */
export type TaskChangesResult =
  | {
      reason: 'branch-gone'
      base: null
      head: null
      landedSha: string | null
      files: []
      patch: ''
      truncated: false
      commits: []
      gateChecks: null
    }
  | {
      reason?: undefined
      base: string
      head: string
      landedSha: string | null
      files: TaskChangesFileStat[]
      patch: string
      truncated: boolean
      commits: TaskChangesCommit[]
      /** Gate check results from the merge verify step, or null when not recorded. */
      gateChecks: GateCheckEntry[] | null
    }

/** Operator-facing verify-gate health, projected from the registry row. */
export type GateHealthEntry = Pick<
  VerifyGate,
  | 'id'
  | 'scope'
  | 'name'
  | 'tier'
  | 'required'
  | 'state'
  | 'source'
  | 'evidence'
  | 'quarantinedAt'
  | 'quarantineSignature'
  | 'lastFailureSignature'
  | 'lastFailureOriginId'
  | 'lastFailureAt'
  | 'lastPassAt'
> & {
  command: Pick<VerifyGate, 'cmd' | 'args'>
}

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
  /**
   * Optional: supplies the current dispatch-pause state so the action-queue
   * projection can derive live-accurate titles (e.g. whether a
   * `signature-storm` row should claim "dispatch is paused"). When absent the
   * renderers that depend on it default to the unpaused branch.
   */
  getPauseState?: () => DispatchPauseState
  /**
   * Optional: supplies a `ConditionItemsSource` that derives synthetic action-queue
   * rows for condition kinds (failed, stale-queued, gate-broken, etc.) from live
   * system state.  When absent the projection only shows row-backed kinds.
   */
  getConditionsSource?: () => import('./daemon/view/action-queue').ConditionItemsSource
  /**
   * Optional: whether the integration baseline currently fails a required
   * gate — the daemon's `BaselineHealthChecker.isBaselinePoisoned()`. Shared
   * with `getPauseState` by `viewReflect` so the Reflections page excludes
   * baseline-caused failures from per-task attribution exactly like the
   * action-queue's derived `baseline-broken`/`failed` conditions do. When
   * absent, `viewReflect` treats the baseline as healthy (conservative).
   */
  isBaselinePoisoned?: () => boolean
}

/**
 * The read use-case surface every display adapter shares (ADR-0055). One named
 * function per read use-case the daemon HTTP routes serve. Mutating verbs
 * (restart/unblock/purge/…) are NOT here — they are the daemon's sole-writer
 * concern and stay on the HTTP transport's own deps.
 */
export interface AppServices {
  // ── action queue ──────────────────────────────────────────────────────────
  viewActionQueue: (
    filter: DerivedActionQueueFilter,
    opts?: { kinds?: ReadonlySet<string> },
  ) => Promise<ActionQueueRow[]>
  viewActionQueueHistory: (opts: {
    cursor?: string | null
    limit?: number
  }) => Promise<{ rows: ActionQueueRow[]; nextCursor: string | null }>
  /** Render deterministic stored state before the first paid Subthread turn. */
  buildSituationReport: () => Promise<string>
  /** Create a fresh inline Subthread with its zero-token situation and acknowledgment. */
  openSubthread: (input: { title: string; acknowledgment: string }) => Promise<{ threadId: string }>
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
  viewStatusCounts: () => Promise<{ running: number; recovering: number; needYou: number; failed: number; doneToday: number }>
  viewCounts: () => Promise<import('./daemon/view/counts.js').Counts>
  viewProposals: (opts?: {
    source?: ProposalSource
    status?: string
    limit?: number
    cursor?: string | null
  }) => Promise<{ drafts: DraftFeature[]; staleWorktrees: StaleWorktreeAlert[]; total: number; nextCursor: string | null }>
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
  // ── task changes diff surface ────────────────────────────────────────────────
  viewTaskChanges: (taskId: string) => Promise<TaskChangesResult>
  // ── hot paths — per-file/dir change frequency over a rolling window ──────────
  viewHotPaths: (opts: {
    window: '30d' | '90d' | 'all'
    group: 'file' | 'dir'
  }) => Promise<HotPathsResult>
  // ── primitives (facet of the Studio surface) ───────────────────────────────
  viewPrimitives: () => Promise<{ primitives: PrimitiveSummary[] }>
  viewPrimitive: (params: { name: string; limit?: number }) => Promise<PrimitiveDetail | null>
  viewSessions: (agentName: string) => Promise<{ sessions: Session[] }>
  viewTerminalEvents: () => Promise<{ events: TerminalEvent[] }>
  viewReleaseNotes: () => Promise<{ entries: ReleaseNoteEntry[] }>
  // ── reflect / arcs ──────────────────────────────────────────────────────────
  viewReflect: (opts?: LoadCorpusOptions) => Promise<ReflectCorpus>
  viewArcs: (opts?: { limit?: number; withTranscriptOnly?: boolean }) => Promise<ArcCandidate[]>
  // ── deep reflection reports ──────────────────────────────────────────────────
  /** List all arc reflection reports newest-first with headline counts. */
  viewDeepReflections: (opts?: { limit?: number }) => Promise<DeepReflectionsListResult>
  /**
   * Fetch the full detail of one arc reflection report by originId.
   * When `at` is supplied (a `recordedAt` ISO string) the call selects the
   * specific report file whose recordedAt matches, rather than always returning
   * the most-recent file for that originId.
   */
  viewDeepReflection: (originId: string, at?: string) => Promise<DeepReflectionDetail | null>
  // ── scorer results (record-only quality signal, PRD 6cf85bc9) ──────────────
  viewScorerTrend: (opts?: {
    workflow?: string
    window?: number
  }) => Promise<{ trends: ScorerTrend[]; recent: ScorerResult[] }>
  viewScorerWorkflows: () => Promise<{ workflows: string[] }>
  viewScorerSuggestions: () => Promise<{ scorers: Scorer[] }>
  acceptScorerById: (id: string) => Promise<{ scorer: Scorer }>
  /**
   * Permanently dismiss a suggested scorer. Once dismissed, the same scorer
   * fingerprint returns 'already-triaged' from suggestScorer and is not
   * re-raised as a scorer-suggested action-queue row.
   */
  dismissScorerById: (id: string) => Promise<{ scorer: Scorer }>
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
    breadcrumbs: import('./lib/chat-store').ClosedSubjectBreadcrumb[]
    boundaries: import('./lib/chat-store').SubjectBoundaryApiView[]
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
    gateHealth: {
      scopes: Array<{ scope: string; gates: GateHealthEntry[] }>
    }
  }>
  // ── verify gate read + mutations ──────────────────────────────────────────
  /**
   * Return all verify gates ordered by scope then creation time, as a flat
   * list. Used by `GET /view/gates` so the UI can list and manage gates.
   * Consumers that want scoped grouping should derive it client-side.
   */
  viewGates: () => Promise<{ gates: VerifyGate[] }>
  /**
   * Add a new verify gate. Returns the newly created gate row.
   *
   * Throws a validation error when name, cmd, or scope (if supplied) is empty.
   * Throws (UNIQUE constraint violation) if a gate with the same (scope, name)
   * already exists.
   */
  addGate: (input: VerifyGateInput) => Promise<VerifyGate>
  /**
   * Remove a verify gate by id or (scope, name) pair.
   * Returns `{ removed: true }` when a row was deleted, `{ removed: false }` when
   * no matching gate was found.
   */
  removeGate: (idOrRef: string | { scope: string; name: string }) => Promise<{ removed: boolean }>
  /**
   * Restore a quarantined gate back to `state = 'active'`, clearing the
   * quarantine bookkeeping.  Returns `{ restored: true }` when the gate was
   * flipped, `{ restored: false }` for an unknown id/ref or a gate that is
   * already active.
   */
  restoreGate: (idOrRef: string | { scope: string; name: string }) => Promise<{ restored: boolean }>
}

/**
 * Enrich a raw SuggestionOutcome (stored as JSON in the DB or parsed from a
 * deep-reflection arc file) with live registry metadata: the lever's `family`
 * and `gesture`. Returns null for null/unknown input.
 */
const enrichOutcome = (raw: unknown): ReflectionSuggestionOutcome => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.type === 'lever') {
    const lever = (o.lever && typeof o.lever === 'object' ? o.lever : {}) as Record<string, unknown>
    const id = typeof lever.id === 'string' ? lever.id : ''
    const entry = loadLeverRegistry().find((e) => e.id === id)
    // History is read at serve time so the UI always sees the current record
    // without a separate round-trip. Sorted newest-first.
    let history: import('./daemon/http-server').LeverApplyHistoryEntry[] = []
    try {
      history = readLeverApplyHistory(id).reverse()
    } catch {
      // history is best-effort — never fail enrichment because of a missing file
    }
    return {
      type: 'lever',
      lever: {
        id,
        family: entry ? String(entry.family) : '',
        scope: entry ? String(entry.scope) : 'global',
        currentValue: typeof lever.currentValue === 'string' ? lever.currentValue : null,
        proposedValue: typeof lever.proposedValue === 'string' ? lever.proposedValue : '',
        gesture: entry?.gesture ?? null,
        appliesWithoutRestart: entry?.appliesWithoutRestart ?? true,
        history,
      },
    }
  }
  if (o.type === 'leverGap') {
    const gap = (o.leverGap && typeof o.leverGap === 'object' ? o.leverGap : {}) as Record<string, unknown>
    return {
      type: 'leverGap',
      leverGap: {
        proposedLeverId: typeof gap.proposedLeverId === 'string' ? gap.proposedLeverId : '',
        family: typeof gap.family === 'string' ? gap.family : '',
        whatItWouldControl: typeof gap.whatItWouldControl === 'string' ? gap.whatItWouldControl : '',
      },
    }
  }
  return null
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

  const buildSubthreadSituationReport: AppServices['buildSituationReport'] = () =>
    buildSituationReport({
      listTasks: () => getDefaultDomainTaskStore().listTasks(),
      getSemaphoreSnapshot: deps.getSituationSemaphoreSnapshot ?? (() => ({ inUse: 0, limit: 0 })),
      listActionQueue: () => viewActionQueue('open'),
      // Without this the report reads "0 queued, 0 running, workers 0 of 14"
      // during a pause and looks like a healthy idle system.
      getDispatchState: deps.getPauseState,
    })

  const openSubthread: AppServices['openSubthread'] = async ({ title, acknowledgment }) => {
    const { appendMessage, createThread } = await import('./lib/chat-store')
    const situation = await buildSubthreadSituationReport()
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

  const viewStatusCounts: AppServices['viewStatusCounts'] = async () => {
    const { buildStatusCountsView, createStatusCountsStore } =
      await import('./daemon/view/status-counts')
    const client = getCompositionRootClient()
    // needYou is deliberately NOT sourced from the SQL store: that query only
    // counts literal action_queue_items rows, but condition kinds (failed,
    // stale-queued, gate-broken, …) are derived on read (ADR-0057) and have
    // no stored row. Sourcing needYou from viewActionQueue('open') — the same
    // feed the triage badge, sidebar badge, and situation card all read from
    // — keeps this the single canonical "needs you" count everywhere.
    const [counts, openActionQueue] = await Promise.all([
      buildStatusCountsView(createStatusCountsStore(client)),
      viewActionQueue('open'),
    ])
    return { ...counts, needYou: countNeedsYou(openActionQueue) }
  }

  const viewCounts: AppServices['viewCounts'] = async () => {
    const { createCountsStore } = await import('./daemon/view/counts.js')
    const client = getCompositionRootClient()
    // needsYou is sourced from the action queue feed (same as viewStatusCounts)
    // rather than a SQL COUNT: condition kinds (failed, stale-queued,
    // gate-broken, …) are derived on read (ADR-0057) and have no stored row.
    const [rawCounts, openActionQueue] = await Promise.all([
      createCountsStore(client).readCounts(),
      viewActionQueue('open'),
    ])
    return { ...rawCounts, needsYou: countNeedsYou(openActionQueue) }
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

        const rawTier = s.payload.declaredTier
        const declaredTier: 'fast' | 'balanced' | 'flagship' | null =
          rawTier === 'fast' || rawTier === 'balanced' || rawTier === 'flagship'
            ? rawTier
            : null
        // Parse gate outcomes from the verify step's commandOutput.
        // Only done for verify-phase steps with a commandOutput string;
        // otherwise null (not shown in the UI).
        const rawCommandOutput =
          s.phase === 'verify' && typeof endEvent?.payload.commandOutput === 'string'
            ? (endEvent.payload.commandOutput as string)
            : null
        const verifyGateOutcomes = rawCommandOutput !== null
          ? (parseVerifyOutput(rawCommandOutput).gateOutcomes)
          : null

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
          declaredTier,
          resolvedModel:
            typeof s.payload.resolvedModel === 'string'
              ? s.payload.resolvedModel
              : null,
          verifyGateOutcomes,
          resolvedMcpServers:
          Array.isArray(endEvent?.payload.resolvedMcpServers)
            ? (endEvent.payload.resolvedMcpServers as unknown[]).filter(
                (n): n is string => typeof n === 'string',
              )
            : null,
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

      const rawTierRts = s.payload.declaredTier
      const declaredTierRts: 'fast' | 'balanced' | 'flagship' | null =
        rawTierRts === 'fast' || rawTierRts === 'balanced' || rawTierRts === 'flagship'
          ? rawTierRts
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
        declaredTier: declaredTierRts,
        resolvedModel:
          typeof s.payload.resolvedModel === 'string'
            ? s.payload.resolvedModel
            : null,
        resolvedMcpServers:
          Array.isArray(endEvent?.payload.resolvedMcpServers)
            ? (endEvent.payload.resolvedMcpServers as unknown[]).filter(
                (n): n is string => typeof n === 'string',
              )
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
    // `stepName` is matched against the payload's step name (e.g. 'run-agent')
    // OR the event's phase (e.g. 'code'): callers address a step by either the
    // engine step name or the pipeline phase the Studio shows.
    const matchesStep = (e: (typeof started)[number]): boolean =>
      e.payload.workflowInstanceId === workflowInstanceId &&
      (e.payload.stepName === stepName || e.phase === stepName)
    const startEvent = started.find(matchesStep)
    if (!startEvent) return miss

    if (typeof startEvent.payload.promptText === 'string') {
      return {
        workflowInstanceId,
        stepName,
        prompt: startEvent.payload.promptText,
        source: 'persisted',
      }
    }

    // Distinguish step kind from the step_started payload: LLM-backed steps
    // carry `workerName`; non-LLM steps (setup/verify/merge) do not.
    const isLlmStep = typeof startEvent.payload.workerName === 'string'

    if (!isLlmStep) {
      // Non-LLM step — no prompt exists for this kind by design.
      return { workflowInstanceId, stepName, prompt: null, source: 'none' }
    }

    // LLM-backed step but no promptText — pre-persistence run. Attempt
    // best-effort recovery from stored transcripts.
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
    const endEvent = ended.find(matchesStep)
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

    // LLM step with no recoverable prompt — prompt was lost (pre-persistence
    // run with no surviving transcript). The UI must render this as an
    // explicit visible gap labelled 'not captured', never as empty space.
    return { workflowInstanceId, stepName, prompt: null, source: 'not-captured' }
  }

  const viewAgentToolCalls: AppServices['viewAgentToolCalls'] = async (taskId, sessionId) => {
    const events = (await traceStore.readTranscriptChunks?.(taskId, sessionId)) ?? []
    return { calls: extractAgentToolCalls(events) }
  }

  // ── task changes diff surface ────────────────────────────────────────────────

  const PATCH_SIZE_LIMIT = 200 * 1024 // 200 KB

  const BRANCH_GONE: TaskChangesResult = {
    reason: 'branch-gone',
    base: null,
    head: null,
    landedSha: null,
    files: [],
    patch: '',
    truncated: false,
    commits: [],
    gateChecks: null,
  }

  const viewTaskChanges: AppServices['viewTaskChanges'] = async (taskId) => {
    const task = await getDefaultDomainTaskStore().getTask(taskId)
    if (!task) return BRANCH_GONE

    const repoRoot = getRepoRoot()
    const integrationBranch = process.env['INTEGRATION_BRANCH'] ?? 'main'

    let base: string
    let head: string
    let landedSha: string | null = null

    const taskStatus = task.status
    if (taskStatus === 'done' || taskStatus === 'dropped') {
      // Try the worktree tombstone for the landed sha.
      const stateDir = resolveContext().stateDir
      const tombstonePath = resolvePath(stateDir, 'worktrees', `${taskId}.removed.json`)
      try {
        const raw = await readFile(tombstonePath, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const sha = typeof parsed['mergeCommitSha'] === 'string' ? parsed['mergeCommitSha'] : null
        if (!sha) return BRANCH_GONE
        landedSha = sha
        // diff range: parent → landed commit
        const parentSha = await localGitVcs.revParse({ cwd: repoRoot, rev: `${sha}^` })
        // The sha is known but the parent is unreachable — diff is unavailable yet
        // the sha itself is useful to the caller for identification. Return the
        // branch-gone shape with landedSha populated instead of null so the UI
        // can surface "the work landed at <sha>" rather than "no files changed".
        if (!parentSha) return { ...BRANCH_GONE, landedSha: sha }
        base = parentSha
        head = sha
      } catch {
        return BRANCH_GONE
      }
    } else {
      // Live task — need branch + a working git ref.
      const branch = task.branch
      if (!branch) return BRANCH_GONE
      const worktreePath = task.worktreePath
      const cwd = worktreePath ?? repoRoot

      try {
        // Resolve HEAD of the task branch.
        const headSha = await localGitVcs.revParse({ cwd, rev: 'HEAD' })
        if (!headSha) return BRANCH_GONE
        head = headSha

        // Resolve merge-base between the integration branch and this branch.
        const mbResult = await execProbe(
          resolveGitBin(),
          ['merge-base', integrationBranch, branch],
          { cwd },
        )
        if (mbResult.exitCode !== 0) {
          // Branch may not yet share history with integration (e.g. fresh worktree
          // before the first commit). Graceful empty result.
          return BRANCH_GONE
        }
        const baseSha = mbResult.stdout.trim()
        if (!baseSha) return BRANCH_GONE
        base = baseSha
      } catch {
        // The working directory no longer exists — the worktree was removed while
        // the task status record has not yet been updated to done/dropped. Return
        // a typed branch-gone 200 instead of propagating a 500. Include the
        // landed sha if a tombstone was written before the status record settled.
        const stateDir = resolveContext().stateDir
        const tombstonePath = resolvePath(stateDir, 'worktrees', `${taskId}.removed.json`)
        try {
          const raw = await readFile(tombstonePath, 'utf8')
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const sha = typeof parsed['mergeCommitSha'] === 'string' ? parsed['mergeCommitSha'] : null
          return sha ? { ...BRANCH_GONE, landedSha: sha } : BRANCH_GONE
        } catch {
          return BRANCH_GONE
        }
      }
    }

    const range = `${base}..${head}`

    // Gather diff data in parallel.
    const [files, rawPatch, commits, authoredAtMap] = await Promise.all([
      localGitVcs.diffSummary({ cwd: repoRoot, range }).catch(() => [] as import('./ports/vcs/types').VcsDiffFileStat[]),
      localGitVcs.diffText({ cwd: repoRoot, from: base, to: head }).catch(() => null),
      localGitVcs.commitsInRange({ cwd: repoRoot, range, abbrev: false }).catch(() => []),
      execProbe(resolveGitBin(), ['log', '--format=%H\t%aI', range], { cwd: repoRoot }).then((r) => {
        const m = new Map<string, string>()
        if (r.exitCode !== 0) return m
        for (const line of r.stdout.split('\n')) {
          const tabIdx = line.indexOf('\t')
          if (tabIdx === -1) continue
          const sha = line.slice(0, tabIdx).trim()
          const date = line.slice(tabIdx + 1).trim()
          if (sha && date) m.set(sha, date)
        }
        return m
      }).catch(() => new Map<string, string>()),
    ])

    const patch = rawPatch ?? ''
    const truncated = Buffer.byteLength(patch, 'utf8') > PATCH_SIZE_LIMIT
    const finalPatch = truncated
      ? patch.slice(0, PATCH_SIZE_LIMIT)
      : patch

    // Read gate checks from the most recent completed merge job for this task.
    // Best-effort: null when no done job exists or no checks were recorded.
    const gateChecks = await getDefaultMergeJobStore()
      .getGateChecksForTask(taskId)
      .catch(() => null)

    return {
      base,
      head,
      landedSha,
      files: files.map((f) => ({
        path: f.path,
        ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      patch: finalPatch,
      truncated,
      commits: commits.map((c) => ({
        sha: c.sha,
        subject: c.subject,
        authoredAt: authoredAtMap.get(c.sha) ?? '',
      })),
      gateChecks,
    }
  }

  // ── hot paths — per-file/dir change frequency over a rolling window ──────────

  const viewHotPaths: AppServices['viewHotPaths'] = async ({ window, group }) => {
    const { buildHotPathsView } = await import('./daemon/view/hot-paths.js')
    return buildHotPathsView({
      stateDir: resolveContext().stateDir,
      repoRoot: getRepoRoot(),
      window,
      group,
    })
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
    // Reads the live registry so operator-registered primitives (those with a
    // description) appear alongside the built-ins. Primitives without a
    // description are internal pipeline steps and are omitted.
    primitives: listPrimitives()
      .filter((d) => d.description !== undefined && d.description.length > 0)
      .map((descriptor) => ({
        name: descriptor.id,
        description: descriptor.description!,
        phase: descriptor.phase ?? null,
        // Map the registry's 'deterministic' to the wire's 'shell' for
        // backward-compat with existing UI consumers.
        executor: (descriptor.executor === 'deterministic'
          ? 'shell'
          : descriptor.executor) as PrimitiveSummary['executor'],
      })),
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
            declaredTier: (() => {
              const t = s.payload.declaredTier
              return t === 'fast' || t === 'balanced' || t === 'flagship' ? t : null
            })(),
            resolvedModel:
              typeof s.payload.resolvedModel === 'string' ? s.payload.resolvedModel : null,
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
    // Bell/alert path uses. Coverage-gap alerts remain `verify-uncovered` so
    // their thread is not mistaken for an arc failure. The arc id is the
    // entity/origin id (or coverage fingerprint), and the alert goal rides in
    // `payload.goal`.
    const item: RaiseActionQueueItem = {
      kind:
        alert.kind === 'arc-failed'
          ? 'failed'
          : alert.kind,
      category: 'orchestrator',
      priority: 'high',
      title: alert.reason,
      body: alert.technical || alert.reason,
      payload: {
        taskId: alert.arcId,
        goal: alert.goal,
        ...(alert.kind === 'verify-uncovered'
          ? {
              scope: alert.goal,
              changedPaths: alert.technical
                .split('\n')
                .filter((line) => line.startsWith('- '))
                .map((line) => line.slice(2)),
              recipe: alert.recipe,
            }
          : {}),
      },
      context: {},
      raisedBy: 'operator',
      signature: alert.arcId,
      originTaskId: alert.arcId,
    }
    const segment = buildAlertSegment(item, alert.arcId)
    const situation = await buildSubthreadSituationReport()
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
              UNION
              SELECT t.origin_id
                FROM tasks t JOIN input_ids i ON t.id = i.id
               WHERE t.origin_id IS NOT NULL AND t.origin_id != t.id
            )
            SELECT t.id, t.status, t.prompt, t.intent, t.failure_signature, t.branch,
                   t.updated_at, t.parent_proposal_id, t.fix_for_task_id, t.origin_id,
                   t.lease_owner, t.leased_at, t.lease_note,
                   t.failure_reason, t.worktree_path,
                   COALESCE(array_agg(b.blocker_task_id)
                     FILTER (WHERE b.blocker_task_id IS NOT NULL), '{}') AS blocked_by
              FROM tasks t
              JOIN related_ids r ON r.id = t.id
              LEFT JOIN task_blockers b ON b.task_id = t.id
             GROUP BY t.id, t.status, t.prompt, t.intent, t.failure_signature, t.branch,
                      t.updated_at, t.parent_proposal_id, t.fix_for_task_id, t.origin_id,
                      t.lease_owner, t.leased_at, t.lease_note,
                      t.failure_reason, t.worktree_path`,
      args: [entityIds],
    })
    return result.rows.map((row) => {
      const task = row as Record<string, unknown>
      return {
        id: task.id as string,
        status: task.status as string,
        prompt: task.prompt as string,
        intent: (task.intent as string | null) ?? '',
        blockedBy: (task.blocked_by as string[]) ?? [],
        parentProposalId: (task.parent_proposal_id as string | null) ?? null,
        failureSignature: (task.failure_signature as string | null) ?? null,
        branch: (task.branch as string | null) ?? null,
        updatedAt: task.updated_at as string,
        fixForTaskId: (task.fix_for_task_id as string | null) ?? null,
        originId: (task.origin_id as string | null) ?? null,
        leaseOwner: (task.lease_owner as string | null) ?? null,
        leasedAt: (task.leased_at as string | null) ?? null,
        leaseNote: (task.lease_note as string | null) ?? null,
        failureReason: (task.failure_reason as string | null) ?? null,
        worktreePath: (task.worktree_path as string | null) ?? null,
      }
    })
  }

  const viewActionQueue: AppServices['viewActionQueue'] = async (filter, opts) => {
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

    // Proposal status store: guards draft-proposal rows whose proposalId
    // points at a proposal that is absent or no longer in 'draft' status.
    // A single bulk SQL query covers all draft-proposal rows in this batch.
    const proposalStore = {
      getDraftProposalIds: async (ids: readonly string[]) => {
        const { getProposalStatusForIds } = await import('./proposals')
        return getProposalStatusForIds(ids)
      },
    }

    return buildActionQueueView({
      stateStore,
      taskStore,
      repoRoot: getRepoRoot(),
      filter,
      pauseState: deps.getPauseState?.() ?? null,
      kinds: opts?.kinds,
      conditionsSource: deps.getConditionsSource?.(),
      proposalStore,
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

  const viewProposals: AppServices['viewProposals'] = async (opts = {}) => {
    const { source: sourceFilter, status, limit: rawLimit, cursor } = opts
    const limit = Math.min(Math.max(1, rawLimit ?? 50), 200)
    const offset = cursor !== null && cursor !== undefined ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0

    const client = getCompositionRootClient()
    // Check if the proposals table exists (absent on a fresh repo before
    // the first `mars init` / daemon run that initialises the schema).
    const tablesResult = await client.execute(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'proposals'`,
    )
    const drafts: DraftFeature[] = []
    let total = 0
    let nextCursor: string | null = null

    if (tablesResult.rows.length > 0) {
      // Build WHERE clause from caller-supplied filters.
      const conditions: string[] = []
      const filterArgs: string[] = []
      if (status !== undefined) {
        conditions.push('p.status = ?')
        filterArgs.push(status)
      }
      if (sourceFilter !== undefined) {
        conditions.push('p.source = ?')
        filterArgs.push(sourceFilter)
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Total count (for pagination metadata).
      const countResult = await client.execute({
        sql: `SELECT COUNT(*) AS total FROM proposals p ${whereClause}`,
        args: filterArgs,
      })
      total = Number((countResult.rows[0] as unknown as { total: unknown }).total ?? 0)

      const r = await client.execute({
        sql: `SELECT p.id, p.title, p.problem, p.solution, p.status, p.source,
                p.created_at, p.updated_at, p.suggestion_outcome,
                (SELECT COUNT(*) FROM proposal_user_stories s WHERE s.proposal_id = p.id) AS acceptance_count
         FROM proposals p
         ${whereClause}
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
        args: [...filterArgs, limit, offset],
      })

      // Load user stories for all returned proposals in one query.
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
        const mappedSource: DraftFeature['source'] = isProposalSource(src) ? src : 'human'
        drafts.push({
          id: r0.id as string,
          title: (r0.title as string | null) ?? '',
          problem: (r0.problem as string | null) ?? '',
          solution: (r0.solution as string | null) ?? '',
          status: (r0.status as string | null) ?? 'draft',
          source: mappedSource,
          createdAt: Number(r0.created_at ?? 0),
          updatedAt: Number(r0.updated_at ?? 0),
          acceptanceCount: Number(r0.acceptance_count ?? 0),
          userStories: storiesMap.get(r0.id as string) ?? [],
          suggestionOutcome: enrichOutcome(
            r0.suggestion_outcome != null
              ? (typeof r0.suggestion_outcome === 'string'
                  ? JSON.parse(r0.suggestion_outcome)
                  : r0.suggestion_outcome)
              : null,
          ),
        })
      }

      // Emit nextCursor when more results exist beyond the current page.
      const nextOffset = offset + limit
      if (nextOffset < total) {
        nextCursor = String(nextOffset)
      }
    }

    const staleWorktrees: StaleWorktreeAlert[] = []
    try {
      const r = await client.execute(
        `SELECT context, payload, last_seen_at, raised_at
           FROM action_queue_items
          WHERE kind = 'stale-worktree' AND status = 'open'
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

    return { drafts, staleWorktrees, total, nextCursor }
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
    loadRecentTaskCorpus({
      ...opts,
      isBaselinePoisoned: deps.isBaselinePoisoned,
      getPauseState: deps.getPauseState,
    })

  const viewArcs: AppServices['viewArcs'] = (opts) =>
    listDeepReflectArcCandidates(opts)

  /**
   * Read the reflection control state (autoRunReflect lever + autoEnqueue flag).
   * Falls back to safe defaults when the config file is absent or malformed.
   */
  const readReflectState = (): { autoRunReflect: 'on' | 'off'; autoEnqueue: boolean } => {
    try {
      const levers = readControlLevers()
      const config = loadDaemonConfig()
      return { autoRunReflect: levers.autoRunReflect, autoEnqueue: config.selfEvolve.autoEnqueue }
    } catch {
      return { autoRunReflect: 'on', autoEnqueue: false }
    }
  }

  const viewDeepReflections: AppServices['viewDeepReflections'] = async (opts) => {
    const dir = resolvePath(resolveContext().stateDir, 'deep-reflections')
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // Directory absent — no reports yet.
      const { autoRunReflect, autoEnqueue } = readReflectState()
      return { reports: [], totalDiscovered: 0, unreadableCount: 0, autoRunReflect, autoEnqueue, lastReflectedAt: null }
    }

    // Accept every .json file regardless of prefix — naming conventions have
    // already changed once and will again; filter on content, not filename.
    const jsonFiles = entries.filter((f) => f.endsWith('.json'))
    const totalDiscovered = jsonFiles.length

    // Parse all files first so we can sort by content, not by filename.
    const parsed: import('./daemon/http-server').DeepReflectionSummary[] = []
    let unreadableCount = 0
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(resolvePath(dir, file), 'utf8')
        const data = JSON.parse(raw) as Record<string, unknown>
        const report = data.report && typeof data.report === 'object' ? data.report as Record<string, unknown> : null
        const dissonantCalls = Array.isArray(report?.dissonantCalls) ? report.dissonantCalls : []
        const verifyMismatches = Array.isArray(report?.verifyMismatches)
          ? report.verifyMismatches
          : report?.verifyMismatch ? [report.verifyMismatch] : []
        const thrashingPatterns = Array.isArray(report?.thrashingPatterns) ? report.thrashingPatterns : []
        const toolCallStats = report?.toolCallStats && typeof report.toolCallStats === 'object'
          ? report.toolCallStats as { total?: unknown }
          : null
        const verdictResult = data.verdictResult && typeof data.verdictResult === 'object'
          ? data.verdictResult as { saved?: unknown; absorbed?: unknown; dropped?: unknown }
          : {}
        parsed.push({
          // Session reports (session-*.json) have no `originId` field; fall back
          // to the filename stem (no .json extension) so the UI can pass a clean
          // id to the detail route without a 404.
          originId: typeof data.originId === 'string' ? data.originId : file.replace(/\.json$/, ''),
          recordedAt: typeof data.recordedAt === 'string' ? data.recordedAt : '',
          status: typeof data.status === 'string' ? data.status : 'unknown',
          totalToolCalls: typeof toolCallStats?.total === 'number' ? toolCallStats.total : 0,
          dissonantCallCount: dissonantCalls.length,
          verifyMismatchCount: verifyMismatches.length,
          thrashingPatternCount: thrashingPatterns.length,
          verdictResult: {
            saved: typeof verdictResult.saved === 'number' ? verdictResult.saved : 0,
            absorbed: typeof verdictResult.absorbed === 'number' ? verdictResult.absorbed : 0,
            dropped: typeof verdictResult.dropped === 'number' ? verdictResult.dropped : 0,
          },
        })
      } catch {
        // Malformed file — count it so the caller can surface the gap.
        unreadableCount++
      }
    }

    // Sort by the report's own recordedAt, newest first. ISO 8601 strings sort
    // lexically, so localeCompare is byte-equivalent to a Date comparison here.
    parsed.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))

    // lastReflectedAt = max recordedAt across ALL successfully parsed reports,
    // independent of the page limit. After descending sort, that is parsed[0].
    const lastReflectedAt = parsed.length > 0 ? parsed[0]!.recordedAt : null

    const limit = opts?.limit ?? 100
    const reports = parsed.slice(0, limit)

    const { autoRunReflect, autoEnqueue } = readReflectState()
    return { reports, totalDiscovered, unreadableCount, autoRunReflect, autoEnqueue, lastReflectedAt }
  }

  const viewDeepReflection: AppServices['viewDeepReflection'] = async (originId, at) => {
    const dir = resolvePath(resolveContext().stateDir, 'deep-reflections')
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return null
    }

    // Resolve the report file for this originId.
    //
    // Two naming schemes coexist on disk:
    //   1. Arc reports:     arc-<originId>-<slug>-<ISO>.json (originId is a task id;
    //      it is always the first segment after "arc-", so several reports can
    //      share one originId and are disambiguated by `at`)
    //   2. Session reports: session-<idSlice>-<ISO>.json (no originId field in JSON;
    //      the list route emits the filename stem as the canonical id)
    //
    // Strategy:
    //   a) Direct match: <originId>.json — covers session-* and any future schemes
    //      where the canonical id IS the filename stem. Unique by construction,
    //      so no `at` disambiguation is needed.
    //   b) Arc-prefix match: arc-<originId>* — handles the arc naming convention,
    //      disambiguated by `at` when several candidates exist.
    let file: string | undefined
    if (entries.includes(`${originId}.json`)) {
      // Direct stem match (e.g. session-f0715a63-2026-08-17T13-50-43-815Z).
      file = `${originId}.json`
    } else {
      const arcFiles = entries.filter(
        (f) => f.startsWith('arc-') && f.endsWith('.json') && f.startsWith(`arc-${originId}`)
      )
      if (arcFiles.length === 0) return null

      // When `at` is supplied (a recordedAt ISO string), prefer the file whose
      // own recordedAt field matches exactly.  Fall back to most-recent if no
      // file matches (e.g. URL is stale or the file was rotated).
      if (at && arcFiles.length > 1) {
        // Read each candidate file to find the one whose recordedAt matches `at`.
        let matched: string | undefined
        for (const candidate of arcFiles) {
          try {
            const candidateRaw = await readFile(resolvePath(dir, candidate), 'utf8')
            const candidateData = JSON.parse(candidateRaw) as Record<string, unknown>
            if (typeof candidateData.recordedAt === 'string' && candidateData.recordedAt === at) {
              matched = candidate
              break
            }
          } catch {
            // Skip unreadable/malformed files during disambiguation.
          }
        }
        // Fall back to most-recent file if no exact match found.
        file = matched ?? [...arcFiles].sort().at(-1)
      } else {
        // Most-recent file for this originId (sort ascending then take last).
        file = [...arcFiles].sort().at(-1)
      }
    }
    if (!file) return null
    let raw: string
    try {
      raw = await readFile(resolvePath(dir, file), 'utf8')
    } catch {
      return null
    }

    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }

    const report = data.report && typeof data.report === 'object' ? data.report as Record<string, unknown> : null
    const dissonantCalls = Array.isArray(report?.dissonantCalls) ? report.dissonantCalls : []
    const verifyMismatches = Array.isArray(report?.verifyMismatches)
      ? report.verifyMismatches
      : report?.verifyMismatch ? [report.verifyMismatch] : []
    const thrashingPatterns = Array.isArray(report?.thrashingPatterns) ? report.thrashingPatterns : []
    const suggestions = Array.isArray(report?.suggestions) ? report.suggestions : []
    const toolCallStats = report?.toolCallStats && typeof report.toolCallStats === 'object'
      ? report.toolCallStats as { total?: unknown; byName?: unknown }
      : null
    const verdictResult = data.verdictResult && typeof data.verdictResult === 'object'
      ? data.verdictResult as { saved?: unknown; absorbed?: unknown; dropped?: unknown }
      : {}

    const normCall = (c: unknown): import('./daemon/http-server').ReflectionDissonantCall => {
      const call = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
      return {
        taskId: typeof call.taskId === 'string' ? call.taskId : null,
        eventIndex: typeof call.eventIndex === 'number' ? call.eventIndex : 0,
        tool: typeof call.tool === 'string' ? call.tool : '',
        statedIntent: typeof call.statedIntent === 'string' ? call.statedIntent : '',
        actualOutcome: typeof call.actualOutcome === 'string' ? call.actualOutcome : '',
        severity: typeof call.severity === 'string' ? call.severity : 'low',
        evidence: typeof call.evidence === 'string' ? call.evidence : '',
      }
    }

    const normMismatch = (m: unknown): import('./daemon/http-server').ReflectionVerifyMismatch => {
      const mm = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      return {
        taskId: typeof mm.taskId === 'string' ? mm.taskId : '',
        claimed: typeof mm.claimed === 'string' ? mm.claimed : '',
        actual: typeof mm.actual === 'string' ? mm.actual : '',
        severity: typeof mm.severity === 'string' ? mm.severity : 'low',
      }
    }

    const normPattern = (p: unknown): import('./daemon/http-server').ReflectionThrashingPattern => {
      const pp = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
      return {
        pattern: typeof pp.pattern === 'string' ? pp.pattern : '',
        occurrences: typeof pp.occurrences === 'number' ? pp.occurrences : 0,
        evidence: typeof pp.evidence === 'string' ? pp.evidence : '',
      }
    }

    const { autoRunReflect, autoEnqueue } = readReflectState()

    return {
      originId: typeof data.originId === 'string' ? data.originId : originId,
      recordedAt: typeof data.recordedAt === 'string' ? data.recordedAt : '',
      status: typeof data.status === 'string' ? data.status : 'unknown',
      totalToolCalls: typeof toolCallStats?.total === 'number' ? toolCallStats.total : 0,
      dissonantCallCount: dissonantCalls.length,
      verifyMismatchCount: verifyMismatches.length,
      thrashingPatternCount: thrashingPatterns.length,
      verdictResult: {
        saved: typeof verdictResult.saved === 'number' ? verdictResult.saved : 0,
        absorbed: typeof verdictResult.absorbed === 'number' ? verdictResult.absorbed : 0,
        dropped: typeof verdictResult.dropped === 'number' ? verdictResult.dropped : 0,
      },
      sourceTaskId: typeof data.sourceTaskId === 'string' ? data.sourceTaskId : null,
      autoRunReflect,
      autoEnqueue,
      report: report === null ? null : {
        summary: typeof report.summary === 'string' ? report.summary : '',
        rootCause: typeof report.rootCause === 'string' ? report.rootCause : '',
        toolCallStats: {
          total: typeof toolCallStats?.total === 'number' ? toolCallStats.total : 0,
          byName: (toolCallStats?.byName && typeof toolCallStats.byName === 'object' && !Array.isArray(toolCallStats.byName))
            ? toolCallStats.byName as Record<string, number>
            : {},
        },
        dissonantCalls: dissonantCalls.map(normCall),
        verifyMismatch: verifyMismatches.length > 0 ? normMismatch(verifyMismatches[0]) : null,
        verifyMismatches: verifyMismatches.map(normMismatch),
        thrashingPatterns: thrashingPatterns.map(normPattern),
        suggestions: suggestions.map((s: unknown) => {
          const ss = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
          return {
            title: typeof ss.title === 'string' ? ss.title : '',
            prompt: typeof ss.prompt === 'string' ? ss.prompt : '',
            rationale: typeof ss.rationale === 'string' ? ss.rationale : '',
            verdict: typeof ss.verdict === 'string' ? ss.verdict : '',
            targetId: typeof ss.targetId === 'string' ? ss.targetId : null,
            outcome: enrichOutcome(ss.outcome),
          }
        }),
      },
    }
  }

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

  const viewScorerSuggestions: AppServices['viewScorerSuggestions'] = async () => {
    const scorers = await listScorers({ status: 'suggested' })
    return { scorers }
  }

  const acceptScorerById: AppServices['acceptScorerById'] = async (id) => {
    const scorer = await acceptScorer(id)
    return { scorer }
  }

  const dismissScorerById: AppServices['dismissScorerById'] = async (id) => {
    const scorer = await dismissScorer(id)
    return { scorer }
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
    return { threads: threads.map((t) => toThreadApiView(t, t.last_message_role, t.first_user_message)) }
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
    return { threads: threads.map((t) => toThreadApiView(t, t.last_message_role, t.first_user_message)) }
  }

  const viewChatConversation: AppServices['viewChatConversation'] = async () => {
    const { listConversationEntries, listClosedSubjectBreadcrumbs, listSubjectBoundaries } = await import('./lib/chat-store')
    const { readMainMemoryWindow } = await import('./daemon/chat-memory-window')
    const [entries, breadcrumbs, boundaries, memoryWindow] = await Promise.all([
      listConversationEntries(),
      listClosedSubjectBreadcrumbs(),
      listSubjectBoundaries(),
      readMainMemoryWindow(),
    ])
    return {
      entries,
      breadcrumbs,
      boundaries,
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
    const gatesByScope = new Map<string, GateHealthEntry[]>()
    const gates = await listVerifyGates()
    for (const gate of gates.sort((left, right) =>
      left.scope === right.scope
        ? left.name.localeCompare(right.name)
        : left.scope.localeCompare(right.scope),
    )) {
      const entries = gatesByScope.get(gate.scope) ?? []
      entries.push({
        id: gate.id,
        scope: gate.scope,
        name: gate.name,
        tier: gate.tier,
        required: gate.required,
        state: gate.state,
        source: gate.source,
        evidence: gate.evidence,
        command: { cmd: gate.cmd, args: gate.args },
        quarantinedAt: gate.quarantinedAt,
        quarantineSignature: gate.quarantineSignature,
        lastFailureSignature: gate.lastFailureSignature,
        lastFailureOriginId: gate.lastFailureOriginId,
        lastFailureAt: gate.lastFailureAt,
        lastPassAt: gate.lastPassAt,
      })
      gatesByScope.set(gate.scope, entries)
    }

    // 1. Runtime tuning acks — steward_ledger WHERE target_kind = 'daemon-cap', newest first.
    //    Capped at 200 rows; the table can accumulate thousands of entries on long-running daemons.
    let acks: Array<{ text: string; timestamp: string; pair: { from: number; to: number } | null }> = []
    try {
      const acksResult = await client.execute(
        `SELECT ts, outcome, rationale
           FROM steward_ledger
          WHERE target_kind = 'daemon-cap'
          ORDER BY ts DESC, id DESC
          LIMIT 200`,
      )
      acks = acksResult.rows.map((row) => {
        const r = row as { ts: string | Date; outcome: string; rationale: string }
        // Parse "implement cap N → M" (→ is U+2192) from the outcome column.
        const capMatch = /implement cap (\d+) → (\d+)/.exec(r.outcome)
        const fromN = capMatch ? Number(capMatch[1]) : null
        const toN = capMatch ? Number(capMatch[2]) : null
        const pair = fromN !== null && toN !== null ? { from: fromN, to: toN } : null
        // Compose plain-language operator text using the shared notice renderer so
        // the steward page and the chat stream describe the same event identically.
        // For historical rows the reason is inferred from the direction (no separate
        // reason column existed before this change).
        const text = pair
          ? renderConversationNotice('steward.runtime-tune', {
              from: pair.from,
              to: pair.to,
              reason: pair.from < pair.to ? 'the backlog was sustained' : 'host pressure was detected',
            })
          : String(r.outcome)
        // ts is timestamptz — normalise to ISO-8601 via Date. Do NOT use Number(), which
        // would produce garbage from a timestamp string (unlike chat_messages.created_at
        // which was epoch-ms; this column stores ISO-8601).
        const timestamp = new Date(String(r.ts)).toISOString()
        return { text, timestamp, pair }
      })
    } catch {
      // Degrade gracefully on fresh repos without the steward_ledger table.
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
        hasCallers: true,
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
        model: 'claude-sonnet-5',
        allowedTools: ['Read', 'Bash', 'Grep', 'Glob', 'PromptOptimize'],
        eventVariants: ['kpi-degraded', 'resource-load', 'onboarding', 'workflow-suggestion'],
        dispatchSites: 0,
      },
      gateHealth: {
        scopes: [...gatesByScope].map(([scope, gates]) => ({ scope, gates })),
      },
    }
  }

  const viewGates: AppServices['viewGates'] = async () => {
    const gates = await listVerifyGates()
    return { gates }
  }

  const addGate: AppServices['addGate'] = async (input) => {
    if (!input.name?.trim()) throw new Error('name is required')
    if (!input.cmd?.trim()) throw new Error('cmd is required')
    if (input.scope !== undefined && !input.scope.trim()) throw new Error('scope must not be empty when provided')
    const id = await addVerifyGate(input)
    const gate = await getVerifyGate(id)
    if (!gate) throw new Error(`gate '${id}' not found after insertion`)
    return gate
  }

  const removeGate: AppServices['removeGate'] = async (idOrRef) => {
    const removed = await removeVerifyGate(idOrRef)
    return { removed }
  }

  const restoreGate: AppServices['restoreGate'] = async (idOrRef) => {
    const restored = await restoreVerifyGate(idOrRef)
    return { restored }
  }

  return {
    viewActionQueue,
    viewActionQueueHistory,
    buildSituationReport: buildSubthreadSituationReport,
    openSubthread,
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
    viewStatusCounts,
    viewCounts,
    viewProposals,
    viewProposal,
    viewStepSpans,
    viewRunTimeline,
    viewStepPrompt,
    viewAgentToolCalls,
    viewTaskChanges,
    viewHotPaths,
    viewPrimitives,
    viewPrimitive,
    viewSessions,
    viewTerminalEvents,
    viewReleaseNotes,
    viewReflect,
    viewArcs,
    viewDeepReflections,
    viewDeepReflection,
    viewScorerTrend,
    viewScorerWorkflows,
    viewScorerSuggestions,
    acceptScorerById,
    dismissScorerById,
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
    viewGates,
    addGate,
    removeGate,
    restoreGate,
  }
}
