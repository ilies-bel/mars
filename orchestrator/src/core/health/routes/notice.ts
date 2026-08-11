/**
 * Notice route handler for the Steward's scheduled health pass.
 *
 * When a check with route='notice' returns a finding, this module decides
 * whether to file a fresh notice or skip because the same finding has already
 * been stated this condition-cycle (stateable-once, silenceable).
 *
 * Dedup key: the finding's `findingKey`. A notice is filed at most once per
 * (findingKey, unsilenced) tuple across arbitrarily many passes. The operator
 * can silence a findingKey permanently; an acknowledged-without-silence notice
 * is re-filed only after the condition first clears and then recurs (which
 * resets the stated flag via NoticeStore.resetStated).
 */

import type { NoticeStore } from '../pass.js'

// ── Deps ──────────────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for the notice route. Both the store and the
 * notice-filing action are injected so the route handler is stateless and
 * testable without a live DB or conversation-delivery stack.
 */
export interface NoticeRouteDeps {
  /**
   * Persistence layer that tracks stated/silenced state keyed by findingKey.
   * Use createInMemoryNoticeStore() in tests; a DB-backed implementation in
   * production.
   */
  noticeStore: NoticeStore

  /**
   * File a notice for the operator. Called only when the finding is neither
   * silenced nor already stated for this condition-cycle.
   */
  fileNotice(params: {
    findingKey: string
    checkId: string
    detail: string | undefined
  }): Promise<void>
}

// ── Result ────────────────────────────────────────────────────────────────────

type NoticeRouteAction = 'stated' | 'already-stated' | 'silenced' | 'no-finding-key'

export interface NoticeRouteResult {
  /** What the route decided to do. */
  readonly action: NoticeRouteAction
  /** The findingKey that was resolved (absent when action === 'no-finding-key'). */
  readonly findingKey?: string
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Route one notice-route finding.
 *
 * - When the check outcome has no findingKey: action='no-finding-key'.
 * - When the findingKey is silenced: action='silenced' (nothing filed).
 * - When the notice was already stated this condition-cycle: action='already-stated'.
 * - Otherwise: files the notice, marks it stated, returns action='stated'.
 */
export async function routeNotice(
  params: {
    findingKey: string | undefined
    checkId: string
    detail: string | undefined
  },
  deps: NoticeRouteDeps,
): Promise<NoticeRouteResult> {
  const { findingKey, checkId, detail } = params

  if (!findingKey) {
    return { action: 'no-finding-key' }
  }

  if (await deps.noticeStore.isSilenced(findingKey)) {
    return { action: 'silenced', findingKey }
  }

  if (await deps.noticeStore.hasBeenStated(findingKey)) {
    return { action: 'already-stated', findingKey }
  }

  await deps.fileNotice({ findingKey, checkId, detail })
  await deps.noticeStore.markStated(findingKey)

  return { action: 'stated', findingKey }
}
