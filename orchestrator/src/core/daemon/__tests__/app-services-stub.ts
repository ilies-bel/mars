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
 */

import type { AppServices } from '../../app-services'

/** A default AppServices where every read use-case returns an empty result. */
export const stubAppServices = (
  overrides: Partial<AppServices> = {},
): AppServices => ({
  viewActionQueue: async () => [],
  viewActionQueueHistory: async () => ({ rows: [], nextCursor: null }),
  viewAlerts: async () => [],
  viewAlert: async () => null,
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
  budgetStatus: async () => ({
    configured: false,
    config: null,
    window: null,
    arcs: null,
    openRows: [],
  }),
  viewTasks: async () => ({ tasks: [] }),
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
  viewFrameworkUpdate: async () => ({
    installed: '0.1.0',
    latest: '0.1.0',
    available: false,
    checkedAt: null,
    releaseUrl: null,
    selfUpdatable: false,
  }),
  ...overrides,
})
