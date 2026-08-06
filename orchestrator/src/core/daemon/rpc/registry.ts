/**
 * The flat, op-keyed RPC registry and its dispatcher — the daemon-protocol
 * mirror of `cli/registry.ts` (ADR-0023 §1).
 *
 * Every leaf is registered by its `op` ('add', 'purge', 'ping', …). The
 * dispatcher ({@link dispatchRpc}) looks up `req.op`, applies the two
 * cross-cutting concerns the old `handleRequest` wrapped the switch in — the
 * work-spawning `acceptingWork` drain gate, and the uniform error mapping — and
 * calls the matched leaf's `run`. A miss returns the same shape the old
 * `default:` arm produced.
 */

import { mapDaemonError } from '../stale-detection'
import type { DaemonRequest, DaemonResponse } from '../protocol'
import type { DaemonDeps, RpcHandler } from './types'
import { allRpcHandlers } from './handlers'

/** The flat op-keyed registry. Insertion order is preserved for discovery. */
export type RpcRegistry = ReadonlyMap<DaemonRequest['op'], RpcHandler>

/**
 * Build a registry from a flat list of handlers, rejecting duplicate ops.
 * Mirrors `buildRegistry` in `cli/registry.ts`.
 */
export const buildRpcRegistry = (
  handlers: readonly RpcHandler[],
): RpcRegistry => {
  const map = new Map<DaemonRequest['op'], RpcHandler>()
  for (const h of handlers) {
    if (map.has(h.op)) {
      throw new Error(`duplicate RPC op in registry: '${h.op}'`)
    }
    map.set(h.op, h)
  }
  return map
}

/** The singleton registry assembled from the full leaf set. */
export const rpcRegistry: RpcRegistry = buildRpcRegistry(allRpcHandlers)

/**
 * The ops that spawn new work (Claude processes / dispatch) or continue
 * in-flight work. While the daemon is draining (`acceptingWork === false`)
 * these are refused with a `DRAINING` error code, exactly as the old
 * `handleRequest` prologue did. The HTTP handler gates the same surface on
 * `isAcceptingWork`.
 *
 * `add` is intentionally NOT in this set: recording a task during a drain is
 * safe — it writes a `queued` row and nothing dispatches until the daemon
 * restarts. Refusing `add` during drain forces operators to use destructive
 * `kill` just to file a loose end, which is the wrong trade-off.
 */
const WORK_SPAWNING_OPS: ReadonlySet<DaemonRequest['op']> = new Set([
  'continue',
  'restart',
  'refine',
  'proposal.promote',
  'proposal.slice',
  'proposal.reslice',
  'proposal.take',
  'glossary-write',
  'adr-add',
  'vision-write',
  'init',
  // investigate and diagnose-failure spawn Claude processes; consistent with
  // the HTTP handler which gates all POST /actions/:op/:id on isAcceptingWork.
  'investigate',
  'diagnose-failure',
])

/**
 * Resolve `req.op` to a leaf and run it, applying the drain gate and uniform
 * error mapping the old `handleRequest` wrapped the switch in. A miss returns
 * the `default:`-arm shape (`{ ok: false, error: 'unknown op: …' }`).
 */
export const dispatchRpc = async (
  registry: RpcRegistry,
  req: DaemonRequest,
  deps: DaemonDeps,
): Promise<DaemonResponse> => {
  if (!deps.getAcceptingWork() && WORK_SPAWNING_OPS.has(req.op)) {
    return {
      ok: false,
      error:
        'daemon draining; new work refused. Use `mars daemon kill` to abort, or wait for shutdown',
      errorCode: 'DRAINING',
    }
  }
  const handler = registry.get(req.op)
  if (!handler) {
    return { ok: false, error: `unknown op: ${JSON.stringify(req)}` }
  }
  try {
    return await handler.run(req, deps)
  } catch (err) {
    return { ok: false, error: mapDaemonError((err as Error).message) }
  }
}
