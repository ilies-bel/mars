export interface InternalEvents {
  'task.blocked': {
    taskId: string
    fixTaskId: string | null
    failureSignature: string
    failingStep: string
    /** Arc origin id — see events.ts for full semantics. Optional for backward compat. */
    originId?: string
  }
  'task.unblocked': {
    taskId: string
    /** The blocker that completed, or undefined when unblocked via edge removal. */
    blockerTaskId?: string
  }
}

export type InternalEventName = keyof InternalEvents
