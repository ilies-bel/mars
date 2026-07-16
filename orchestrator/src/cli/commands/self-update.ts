/**
 * `self-update` command.
 *
 * Sends a POST to the running daemon's `/actions/self-update` route, which
 * downloads the latest release binary, verifies its sha256, atomically swaps
 * it in, and re-execs the daemon. The route hard-refuses dev installs (throws
 * `SelfUpdateError` with code `DEV_INSTALL`); this command surfaces that
 * message verbatim so the user gets the correct instruction
 * (`git pull && npm install`) rather than a crash.
 *
 * Mirrors the thin CLI-over-daemon-HTTP pattern used by `alert.ts` and the
 * HTTP-port-reading pattern used by `run.ts`.
 */

import type { Command } from '../command'
import { readDaemonPort } from './shared'

const NO_DAEMON_MSG =
  'self-update: daemon not running — run `mars daemon start` first'

const selfUpdateCommand: Command = {
  path: 'self-update',
  summary: 'update the mars binary via the running daemon (prod installs only)',
  usage: 'usage: mars self-update',
  run: async (_args, deps) => {
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }

    let body: Record<string, unknown>
    let ok: boolean
    let status: number
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      ok = res.ok
      status = res.status
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }

    if (ok) {
      deps.out('Self-update started; the daemon is replacing its binary and restarting.')
      return { code: 0 }
    }

    // Surface the daemon's error message verbatim. The DEV_INSTALL error from
    // performSelfUpdate already tells the user: "run git pull && npm install".
    const msg =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : `daemon returned ${status}`
    deps.err(`self-update: ${msg}`)
    return { code: 1 }
  },
}

export const selfUpdateCommands: readonly Command[] = [selfUpdateCommand]
