/**
 * Shared test factory for {@link HttpServerDeps}.
 *
 * Every required member has a benign no-op default. When {@link HttpServerDeps}
 * grows a new required member, TypeScript reports a compile error here (one
 * file) rather than in every test that constructs the deps inline.
 *
 * Optional members (`viewStreamHub`, `chatStreamHub`) are intentionally absent
 * from the factory defaults — they default to `undefined`, which is valid per
 * the interface. Pass them via the `overrides` bag when a test exercises those
 * routes.
 *
 * Usage:
 *
 *   const deps = makeHttpServerDeps()
 *   // override only the fields the test exercises:
 *   const deps = makeHttpServerDeps({ appServices: stubAppServices({ listKpis: () => kpis }) })
 */

import type { HttpServerDeps } from '../../../orchestrator/src/core/daemon/http-server.ts'
import {
  stubAppServices,
  stubChatRunner,
} from '../../../orchestrator/src/core/daemon/__tests__/app-services-stub.ts'
import { nullTraceStore } from '../../../orchestrator/src/core/lib/run-tool.ts'

export const makeHttpServerDeps = (
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
  chatRunner: stubChatRunner(),
  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  snoozeItem: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  landWork: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  // Tests that spin up a real server and hit recipe-catalog routes must
  // override this; routes that don't need it are safe with the null default.
  recipeCatalog: null as unknown as HttpServerDeps['recipeCatalog'],
  traceStore: nullTraceStore,
  stepDone: async () => ({ next: null }),
  appServices: stubAppServices(),
  ...overrides,
})
