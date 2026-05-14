export interface InternalEvents {
  'task.blocked': {
    taskId: string
    fixTaskId: string | null
    failureSignature: string
    failingStep: string
  }
  'task.unblocked': {
    taskId: string
    blockerTaskId: string
  }
}

export type InternalEventName = keyof InternalEvents
