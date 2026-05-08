import { listTasks, claimReadyTask, updateTask, type Task } from './queue'

export interface WatcherOptions {
  intervalMs?: number
  integrationBranch?: string
  onLog?: (message: string) => void
}

const DEFAULT_INTERVAL_MS = 2000

export const startWatcher = (opts: WatcherOptions = {}): { stop: () => Promise<void> } => {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const integrationBranch = opts.integrationBranch ?? 'integration'
  const log = opts.onLog ?? ((m: string) => console.log(m))

  const inFlight = new Set<string>()
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const dispatch = async (task: Task): Promise<void> => {
    inFlight.add(task.id)
    log(`[watch] dispatching ${task.id}`)
    try {
      const { mastra } = await import('./index')
      const wf = mastra.getWorkflow('implementWorkflow')
      const run = await wf.createRun()
      const result = await run.start({
        inputData: {
          taskId: task.id,
          prompt: task.prompt,
          plan: task.plan,
          integrationBranch,
        },
      })
      log(`[watch] ${task.id} -> ${result.status}`)
    } catch (err) {
      log(`[watch] ${task.id} failed: ${(err as Error).message}`)
      try {
        await updateTask(task.id, {
          status: 'failed',
          error: (err as Error).message,
        })
      } catch {
        // best-effort
      }
    } finally {
      inFlight.delete(task.id)
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const ready = await listTasks('ready')
      for (const t of ready) {
        if (inFlight.has(t.id)) continue
        const claimed = await claimReadyTask(t.id)
        if (!claimed) continue
        void dispatch(claimed)
      }
    } catch (err) {
      log(`[watch] poll error: ${(err as Error).message}`)
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void tick()
        }, intervalMs)
      }
    }
  }

  void tick()

  return {
    stop: async (): Promise<void> => {
      stopped = true
      if (timer) clearTimeout(timer)
      while (inFlight.size > 0) {
        await new Promise((r) => setTimeout(r, 100))
      }
    },
  }
}
