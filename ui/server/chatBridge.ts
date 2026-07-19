/**
 * chatBridge — connects to the daemon's `/view/stream` SSE channel and
 * forwards `chat` events to the UI's per-project `SseHub`.
 *
 * Event routing:
 * - daemon `chat` with `{ threadId, event }` payload → UI `chat-delta`
 *   (live segment streaming; consumed by ChatPage via the chatBuffer store)
 * - daemon `chat` with `{}` payload → UI `chat`
 *   (cache-invalidation ping; consumed by SseInvalidator)
 *
 * Reconnects with exponential backoff whenever the daemon is unreachable,
 * restarts, or the SSE connection drops.
 */

import { readDaemonHttpPort } from './daemonHttp.ts'
import type { SseHub } from './sse.ts'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Start the daemon→UI chat event bridge for `stateDir`.
 * Runs indefinitely in the background; returns a stop function for cleanup.
 */
export function startChatBridge(stateDir: string, hub: SseHub): () => void {
  let stopped = false

  void runBridge(stateDir, hub, () => stopped)

  return (): void => {
    stopped = true
  }
}

async function runBridge(
  stateDir: string,
  hub: SseHub,
  isStopped: () => boolean,
): Promise<void> {
  let delay = RECONNECT_BASE_MS

  while (!isStopped()) {
    const port = await readDaemonHttpPort(stateDir)
    if (port === null) {
      // Daemon not running yet — wait and retry.
      await sleep(delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
      continue
    }
    delay = RECONNECT_BASE_MS

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/view/stream`, {
        headers: { Accept: 'text/event-stream' },
      })

      if (!resp.ok || resp.body === null) {
        await sleep(RECONNECT_BASE_MS)
        continue
      }

      const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader()
      let lineBuffer = ''
      let currentEvent = ''
      let currentData = ''

      while (!isStopped()) {
        const { done, value } = await reader.read()
        if (done) break

        // Accumulate decoded text and split into lines. The last element may
        // be an incomplete line — keep it in lineBuffer for the next read.
        lineBuffer += value
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trimEnd()
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice('event: '.length)
          } else if (trimmed.startsWith('data: ')) {
            currentData = trimmed.slice('data: '.length)
          } else if (trimmed === '') {
            // Empty line signals end of one SSE event.
            if (currentEvent === 'chat') {
              routeChatEvent(currentData, hub)
            }
            currentEvent = ''
            currentData = ''
          }
          // Ignore comment lines (': ping'), id:, retry: etc.
        }
      }

      try {
        reader.releaseLock()
      } catch {
        // Ignore errors when releasing a reader that already errored.
      }
    } catch {
      // Connection failed or dropped — fall through to reconnect delay.
    }

    if (!isStopped()) {
      await sleep(delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  }
}

/**
 * Route a parsed `chat` SSE payload to the appropriate UI hub event.
 *
 * - `{ threadId, event }` → `chat-delta` (live segment)
 * - anything else         → `chat` (invalidation ping)
 */
function routeChatEvent(dataStr: string, hub: SseHub): void {
  try {
    const data = JSON.parse(dataStr) as unknown
    if (
      typeof data === 'object' &&
      data !== null &&
      'threadId' in data &&
      'event' in data
    ) {
      hub.broadcast('chat-delta', data)
    } else {
      hub.broadcast('chat')
    }
  } catch {
    // Malformed JSON payload — ignore.
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
