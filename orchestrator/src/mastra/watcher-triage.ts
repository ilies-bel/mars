import { listTasks, type Task } from './queue'

export interface TriageWatcherOptions {
  intervalMs?: number
  cooldownMs?: number
  onLog?: (message: string) => void
}

const DEFAULT_INTERVAL_MS = 3000
const DEFAULT_COOLDOWN_MS = 60_000

export const startTriageWatcher = (
  opts: TriageWatcherOptions = {},
): { stop: () => Promise<void> } => {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const log = opts.onLog ?? ((m: string) => console.log(m))

  const inFlight = new Set<string>()
  const lastTriagedAt = new Map<string, number>()
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const dispatch = async (task: Task): Promise<void> => {
    inFlight.add(task.id)
    log(`[triage] dispatching ${task.id}`)
    try {
      const { runTriage } = await import('./workflows/triage-workflow')
      const result = await runTriage(task.id)
      log(
        `[triage] ${task.id} -> actionable=${result.actionable} blockers=${result.blockerCount} suggestions=${result.suggestionCount}`,
      )
    } catch (err) {
      log(`[triage] ${task.id} failed: ${(err as Error).message}`)
    } finally {
      lastTriagedAt.set(task.id, Date.now())
      inFlight.delete(task.id)
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const drafts = await listTasks('draft')
      const now = Date.now()
      const ready = drafts.filter((t) => {
        if (inFlight.has(t.id)) return false
        const last = lastTriagedAt.get(t.id)
        if (last !== undefined && now - last < cooldownMs) return false
        return true
      })
      await Promise.allSettled(ready.map((t) => dispatch(t)))
    } catch (err) {
      log(`[triage] poll error: ${(err as Error).message}`)
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
