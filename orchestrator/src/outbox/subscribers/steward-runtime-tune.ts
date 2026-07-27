import type { EventEmitter } from 'node:events'
import type { Semaphore } from '../../core/daemon/server.js'
import { setSemLimit } from '../../core/daemon/server.js'
import { createThread, appendMessage } from '../../core/lib/chat-store.js'

/**
 * Steward autonomous runtime-knob tuning.
 *
 * When the daemon detects a sustained implement-queue backlog, this
 * handler bumps the implement semaphore cap (bounded at 2× baseline)
 * and posts a first-person acknowledgment to the chat feed. No
 * validation action-queue item is raised — the tuning is autonomous
 * per ADR-0077.
 */
export interface StewardRuntimeTuneDeps {
  bus: EventEmitter
  implementSem: Semaphore
  baselineCap: number
  log: (line: string) => void
  /** Override for testing — defaults to real chat-store writes. */
  writeChatAck?: (text: string) => Promise<void>
}

const BUMP_FACTOR = 1.33

async function defaultWriteChatAck(text: string): Promise<void> {
  const thread = await createThread('Steward: runtime tuning')
  await appendMessage(thread.id, 'assistant', text, undefined, {
    kind: 'acknowledgment',
  })
}

export function startStewardRuntimeTune(deps: StewardRuntimeTuneDeps): void {
  const { bus, implementSem, baselineCap, log } = deps
  const writeChatAck = deps.writeChatAck ?? defaultWriteChatAck
  const maxCap = baselineCap * 2

  bus.on('kpi.backlog.degraded', (payload: { pending: number; cap: number; sustainedMs: number }) => {
    void (async () => {
      const oldCap = implementSem.limit
      if (oldCap >= maxCap) {
        log(`[steward-tune] implement cap already at max (${maxCap}), skipping`)
        return
      }

      const newCap = Math.min(Math.ceil(oldCap * BUMP_FACTOR), maxCap)
      if (newCap === oldCap) return

      setSemLimit(implementSem, newCap)
      log(`[steward-tune] bumped implement cap ${oldCap} → ${newCap} (backlog: ${payload.pending} pending, sustained ${Math.round(payload.sustainedMs / 1000)}s)`)

      const text = `I bumped implement workers from ${oldCap} to ${newCap} because backlog held above ${Math.round(payload.cap * 0.75)} for ${Math.round(payload.sustainedMs / 1000)}s.`
      try {
        await writeChatAck(text)
      } catch (err) {
        log(`[steward-tune] chat ack failed: ${(err as Error).message}`)
      }
    })()
  })
}
