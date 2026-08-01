/**
 * Shared test stub for the {@link AppServices} read layer (ADR-0055).
 *
 * The daemon HTTP server is a thin transport over AppServices: every read route
 * resolves to one named function on `deps.appServices`. These HTTP tests drive a
 * real `startHttpServer` with a fake AppServices so they exercise the route
 * wiring (param parsing, status codes, response shape) without a live daemon.
 *
 * {@link stubAppServices} returns a fully-populated AppServices whose every
 * function is a benign empty default; pass `overrides` to replace just the
 * use-case a given test cares about.
 *
 * {@link stubChatRunner} returns a no-op {@link ChatRunner} instance for tests
 * that do not exercise the chat run path (all public methods are silent no-ops).
 */

import type { AppServices } from '../../app-services'
import { ChatRunner } from '../chat-runner'

/** A no-op ChatRunner for tests that don't exercise the chat routes. */
export const stubChatRunner = (): ChatRunner => new ChatRunner()

/** A default AppServices where every read use-case returns an empty result. */
export const stubAppServices = (
  overrides: Partial<AppServices> = {},
): AppServices => ({
  viewActionQueue: async () => [],
  viewActionQueueHistory: async () => ({ rows: [], nextCursor: null }),
  buildSituationReport: async () => 'Situation: 0 queued tasks, 0 running tasks, 0 blocked tasks, and 0 failed tasks. Workers: 0 of 0 active. 0 items need attention.',
  openSubject: async () => ({ threadId: 'subject-1' }),
  viewAlerts: async () => [],
  viewAlert: async () => null,
  startThreadFromAlert: async () => null,
  nextActionAlert: async () => null,
  listKpis: async () => [],
  listKpisSeries: async () => ({
    failure_rate: [],
    autonomous_completion_rate: [],
    recovery_success_rate: [],
    cost_per_arc_p50: [],
  }),
  listKpiArcs: async () => ({
    key: 'failure_rate',
    window: { windowStart: '', windowEnd: '' },
    arcs: [],
  }),
  viewTasks: async () => ({ tasks: [] }),
  viewTask: async () => null,
  viewProgress: async () => ({ tasks: [], proposals: [], aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 } }),
  viewProposals: async () => ({ drafts: [], staleWorktrees: [] }),
  viewProposal: async () => null,
  viewStepSpans: async () => ({ spans: [] }),
  viewRunTimeline: async (taskId) => ({ taskId, runs: [] }),
  viewStepPrompt: async ({ workflowInstanceId, stepName }) => ({
    workflowInstanceId,
    stepName,
    prompt: null,
    source: null,
  }),
  viewAgentToolCalls: async () => ({ calls: [] }),
  viewPrimitives: async () => ({ primitives: [] }),
  viewPrimitive: async () => null,
  viewSessions: async () => ({ sessions: [] }),
  viewTerminalEvents: async () => ({ events: [] }),
  viewReleaseNotes: async () => ({ entries: [] }),
  viewReflect: async () => ({
    entries: [],
    costSummary: {
      totalWeightedTokens: 0,
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      blockedCount: 0,
      droppedCount: 0,
      cacheHitRatio: 0,
      rateLimitRejections: 0,
      topTokenHeavyTasks: [],
      topExpensiveSteps: [],
      tokensByStep: [],
    },
  }),
  viewArcs: async () => [],
  viewScorerTrend: async () => ({ trends: [], recent: [] }),
  viewScorerWorkflows: async () => ({ workflows: [] }),
  viewWorkflowConfigs: async () => ({ configs: [] }),
  viewPromotionLedger: async () => ({ entries: [] }),
  viewLoopLedger: async () => ({ entries: [] }),
  viewFrameworkUpdate: async () => ({
    installed: '0.1.0',
    latest: '0.1.0',
    available: false,
    checkedAt: null,
    releaseUrl: null,
    selfUpdatable: false,
  }),
  viewGlossary: async () => ({ terms: [] }),
  viewSkills: async () => ({ skills: [] }),
  viewChatThreads: async () => ({ threads: [] }),
  viewChatThread: async () => null,
  viewChatHistory: async () => ({ threads: [] }),
  viewChatConversation: async () => ({
    entries: [],
    memoryStartsAfterSeq: 0,
    memoryCutAt: null,
    memoryCutReason: null,
  }),
  viewSteward: async () => ({
    runtimeTuning: {
      acks: [],
      liveCap: 0,
      baselineCap: 0,
      ceiling: 0,
      bumpFactor: 1.33,
      thresholdFactor: 0.75,
      sustainMs: 60000,
      checkMs: 10000,
    },
    workflowPatches: { rows: [], hasCallers: false },
    signatureStorm: {
      current_signature: null,
      streak_count: 0,
      last_task_id: null,
      tripped: false,
      updated_at: null,
      signatureStormAqCount: 0,
      tripThreshold: 3,
      isPaused: false,
    },
    agentSpec: {
      name: 'steward',
      model: 'claude-sonnet-4-6',
      allowedTools: ['Read', 'Bash', 'Grep', 'Glob', 'PromptOptimize'],
      eventVariants: ['kpi-degraded', 'resource-load', 'onboarding', 'workflow-suggestion'],
      dispatchSites: 0,
    },
  }),
  ...overrides,
})
