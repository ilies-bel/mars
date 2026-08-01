import { z } from 'zod'
import type { ChatMessage } from '../lib/chat-store'

/** Whether a persisted chat entry belongs to the reusable conversation or one Subthread. */
export const ChatContextScopeSchema = z.enum(['main', 'subthread'])
export type ChatContextScope = z.infer<typeof ChatContextScopeSchema>

/** Stable provider session identity for the reusable Main-session request prefix. */
export const MAIN_SESSION_PROVIDER_REQUEST_IDENTITY = 'mars-main-session'

/**
 * Select the reusable portion of the continuous conversation. Subthread
 * situations are compact boundary records, so legacy as well as newly scoped
 * ones remain visible between Subthreads without replaying their local turns.
 */
export const buildMainSessionPrefix = (messages: readonly ChatMessage[]): ChatMessage[] =>
  messages.filter((message) => message.context_scope === 'main' || message.kind === 'situation')
