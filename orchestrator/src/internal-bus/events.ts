export interface InternalEvents {
  'task.blocked': {
    taskId: string
    fixTaskId: string | null
    failureSignature: string
    failingStep: string
  }
  'task.unblocked': {
    taskId: string
    /** The blocker that completed, or undefined when unblocked via edge removal. */
    blockerTaskId?: string
  }
}

export type InternalEventName = keyof InternalEvents
