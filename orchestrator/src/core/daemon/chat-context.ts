import { z } from 'zod'
import type { ChatMessage } from '../lib/chat-store'

/** Whether a persisted chat entry belongs to the reusable conversation or one Subthread. */
export const ChatContextScopeSchema = z.enum(['main', 'subthread'])
export type ChatContextScope = z.infer<typeof ChatContextScopeSchema>

/**
 * Stable provider session identity for the reusable Main-thread request prefix.
 * Renamed with the term; the only cost is that the provider treats the next
 * request as a new prefix and re-primes its cache once.
 */
export const MAIN_THREAD_PROVIDER_REQUEST_IDENTITY = 'mars-main-thread'

/**
 * Select the reusable portion of the continuous conversation. Subthread
 * situations are compact boundary records, so legacy as well as newly scoped
 * ones remain visible between Subthreads without replaying their local turns.
 */
export const buildMainThreadPrefix = (messages: readonly ChatMessage[]): ChatMessage[] =>
  messages.filter((message) => message.context_scope === 'main' || message.kind === 'situation')
