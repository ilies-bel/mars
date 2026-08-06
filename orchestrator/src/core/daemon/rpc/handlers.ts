/**
 * The full set of daemon RPC leaf handlers, one per `op`, assembled into the
 * flat path-keyed registry in `registry.ts`.
 *
 * Each leaf's `run(req, deps)` does EXACTLY what the corresponding case in the
 * old `switch (req.op)` inside `startDaemon` did: it narrows `req` to the
 * matching variant via the `op` discriminant, reads its args, and pulls
 * capabilities from the injected {@link DaemonDeps}. No behaviour changed —
 * including the custom `init` error-code mapping, the three-mode shutdown
 * semantics, the SIGKILL-children `kill` path, and the work-spawning
 * `acceptingWork` gate (which lives in the dispatcher, see `registry.ts`).
 *
 * Per ADR-0024 these leaves do NOT contain drain/dispatch/tracker logic; they
 * reach that machinery through `deps`.
 */

import { existsSync, unlinkSync } from 'node:fs'
import { DAEMON_KILLED_SIGNATURE } from '../../lib/retry-budget'
import { applyControlLevers, loadDaemonConfig } from '../config'
import { setSemLimit } from '../semaphore'
import { setInstallSemCap } from '../../lib/worktree-install'
import { updateTask, getTask, listBlockers } from '../../queue'
import { Arc } from '../../arc'
import type { DaemonRequest, DaemonResponse } from '../protocol'
import type { DaemonDeps, RpcHandler } from './types'

// Narrowing helper: each leaf only ever receives its own variant, so a single
// cast at the top keeps the bodies a verbatim copy of the old switch arms
// without per-field re-validation. `req.op` already selected the handler.
type Op = DaemonRequest['op']
type Req<O extends Op> = Extract<DaemonRequest, { op: O }>

const handler = <O extends Op>(
  op: O,
  run: (req: Req<O>, deps: DaemonDeps) => Promise<DaemonResponse>,
): RpcHandler => ({
  op,
  run: (req, deps) => run(req as Req<O>, deps),
})

const addHandler = handler('add', async (req, deps) => {
  if (typeof req.prompt !== 'string') {
    return {
      ok: false,
      error: `add: prompt must be a string; got ${typeof req.prompt}`,
    }
  }
  const task = await deps.handleAdd(
    req.prompt,
    req.plan,
    req.skipTriage,
    req.author,
    req.blockerIds,
    req.priority,
    req.tags,
    req.spec,
    req.intent,
    req.originSessionId,
    req.workflow,
    req.qa,
    req.deferrable,
  )
  return { ok: true, data: task }
})

const taskPriorityHandler = handler('task.priority', async (req, deps) => {
  const task = await deps.setTaskPriority(req.id, req.priority)
  return { ok: true, data: task }
})

const updateHandler = handler('update', async (req, deps) => {
  await deps.handleUpdate(req.id, req.patch)
  return { ok: true }
})

const continueHandler = handler('continue', async (req, deps) => {
  const continueResult = await deps.handleContinue(req.id)
  return { ok: true, data: continueResult }
})

const stopTaskHandler = handler('stop-task', async (req, deps) => {
  await deps.handleStop(req.id)
  return { ok: true }
})

const restartHandler = handler('restart', async (req, deps) => {
  const result = await deps.handleRestart(req.id, req.force)
  return { ok: true, data: result }
})

const remergeHandler = handler('remerge', async (req, deps) => {
  const result = await deps.handleRemerge(req.id)
  return { ok: true, data: result }
})

const purgeHandler = handler('purge', async (req, deps) => {
  const result = await deps.handlePurge(req.id, req.force ?? false)
  return { ok: true, data: result }
})

const arcPurgeHandler = handler('arc-purge', async (req, deps) => {
  const arcResult = await deps.handleArcPurge(req.id, req.force ?? false)
  return { ok: true, data: arcResult }
})

const dropHandler = handler('drop', async (req, deps) => {
  const result = await deps.handleDrop(req.id, req.force ?? false)
  return { ok: true, data: result }
})

const unblockHandler = handler('unblock', async (req, deps) => {
  const result = await deps.handleUnblock(req.id)
  return { ok: true, data: result }
})

const blockHandler = handler('block', async (req, deps) => {
  const result = await deps.handleBlock(req.id, req.blockerIds ?? [])
  return { ok: true, data: result }
})

const removeBlockersHandler = handler('remove-blockers', async (req, deps) => {
  const result = await deps.handleRemoveBlockers(req.id, req.blockerIds ?? [])
  return { ok: true, data: result }
})

const recoverHandler = handler('recover', async (req, deps) => {
  const result = await deps.handleRecover(req.id)
  return { ok: true, data: result }
})

const syncHandler = handler('sync', async (_req, deps) => {
  const summary = await deps.runSync()
  return { ok: true, data: summary }
})

const proposalPromoteHandler = handler('proposal.promote', async (req, deps) => {
  const r = await deps.handleProposalPromote(
    req.proposalId,
    req.priority,
    req.coordinated,
  )
  return { ok: true, data: r }
})

const proposalSliceHandler = handler('proposal.slice', async (req, deps) => {
  const r = await deps.handleProposalSlice(
    req.proposalId,
    undefined,
    req.priority,
    req.acceptDefaults as boolean | undefined,
  )
  return { ok: true, data: r }
})

const proposalResliceHandler = handler('proposal.reslice', async (req, deps) => {
  const r = await deps.handleProposalReslice(req.proposalId, req.feedback, req.priority)
  return { ok: true, data: r }
})

const proposalTakeHandler = handler('proposal.take', async (req, deps) => {
  const r = await deps.handleProposalTake(req.proposalId, req.workflow)
  return { ok: true, data: r }
})

const refineHandler = handler('refine', async (req, deps) => {
  await deps.handleRefine(req.id, req.refresh ?? false)
  return { ok: true }
})

const glossaryWriteHandler = handler('glossary-write', async (req, deps) => {
  if (req.kind !== 'set' && req.kind !== 'remove') {
    return { ok: false, error: `unknown glossary-write kind: ${req.kind}` }
  }
  if (!req.term || req.term.trim().length === 0) {
    return { ok: false, error: 'glossary-write requires a non-empty term' }
  }
  if (req.kind === 'set' && (!req.definition || req.definition.trim().length === 0)) {
    return { ok: false, error: 'glossary-write set requires a definition' }
  }
  void deps.dispatchGlossaryWrite({
    kind: req.kind,
    term: req.term,
    definition: req.definition,
    aliases: req.aliases,
  })
  return { ok: true, data: { enqueued: true } }
})

const adrAddHandler = handler('adr-add', async (req, deps) => {
  if (!req.title || req.title.trim().length === 0) {
    return { ok: false, error: 'adr-add requires a non-empty title' }
  }
  if (!req.body || req.body.trim().length === 0) {
    return { ok: false, error: 'adr-add requires a non-empty body' }
  }
  void deps.dispatchAdrAdd({ title: req.title.trim(), body: req.body })
  return { ok: true, data: { enqueued: true } }
})

/**
 * Write the product vision to `docs/knowledge/vision.md`.
 *
 * Unlike `glossary-write` / `adr-add` (fire-and-forget), this handler
 * **awaits** `dispatchVisionWrite` so the CLI exits only after the merge
 * finishes — satisfying the "completes only after the structured write merges"
 * acceptance criterion.
 */
const visionWriteHandler = handler('vision-write', async (req, deps) => {
  if (typeof req.content !== 'string' || req.content.trim().length === 0) {
    return { ok: false, error: 'vision-write requires a non-empty content string' }
  }
  await deps.dispatchVisionWrite(req.content)
  return { ok: true }
})

const initHandler = handler('init', async (req, deps) => {
  const result = await deps.handleInit(req.opts)
  return { ok: true, data: result }
})

const statusHandler = handler('status', async (_req, deps) => {
  return { ok: true, data: await deps.handleStatus() }
})

const reloadConfigHandler = handler('reload-config', async (_req, deps) => {
  const caps = loadDaemonConfig().caps
  setSemLimit(deps.sems.implement, caps.implement)
  setSemLimit(deps.sems.triage, caps.triage)
  setSemLimit(deps.sems.refine, caps.refine)
  // Install semaphore lives in worktree-install.ts as a module-level singleton;
  // update it via the exported setter so the new cap takes effect immediately.
  setInstallSemCap(caps.setupInstall)
  setSemLimit(deps.sems.verify, caps.verify)
  deps.log(
    `concurrency reloaded: implement=${caps.implement} triage=${caps.triage} refine=${caps.refine} setup-install=${caps.setupInstall} verify=${caps.verify}`,
  )
  void deps.drain()
  return {
    ok: true,
    data: {
      caps: {
        implement: caps.implement,
        triage: caps.triage,
        refine: caps.refine,
        'setup-install': caps.setupInstall,
        verify: caps.verify,
      },
    },
  }
})

const pingHandler = handler('ping', async (_req, _deps) => {
  return { ok: true, data: { pid: process.pid } }
})

/**
 * Apply the `dispatch` lever to the running daemon.
 *
 * This leaf owns only the LIVE half of the lever. Durability belongs to the
 * CLI (`mars operator set dispatch` writes daemon.json first, then sends this),
 * exactly as `operator set recovery` writes the lever then sends `apply-lever`
 * — one writer for the file, one for the process.
 */
const setDispatchHandler = handler('set-dispatch', async (req, deps) => {
  if (req.value !== 'on' && req.value !== 'off') {
    return {
      ok: false,
      error: `set-dispatch: value must be 'on' or 'off'; got '${req.value}'`,
    }
  }
  if (req.value === 'off') {
    // First cause wins: when the storm breaker or a quota rejection already
    // paused dispatch, an operator pause does not overwrite that reason —
    // status keeps naming the real cause, and one resume clears it.
    deps.pauseDispatch('operator', 'operator set dispatch off')
    const state = deps.getPauseState()
    deps.log(
      `set-dispatch: off; dispatch suspended (reason=${state.reason}, inFlight=${deps.tracker.inFlightCount()})`,
    )
    return {
      ok: true,
      data: {
        paused: true,
        reason: state.reason,
        inFlight: deps.tracker.inFlightCount(),
      },
    }
  }
  const previous = deps.getPauseState()
  deps.resumeDispatch()
  // Clear the persisted signature-storm tripped flag so a subsequent daemon
  // restart does not re-pause a queue the operator deliberately resumed.
  // `resumeDispatch` already clears it for a pause whose reason IS 'storm';
  // this covers the case where an earlier cause (operator, quota) won the
  // pause slot while the breaker tripped underneath it, leaving the durable
  // flag armed with nothing in memory pointing at it. Idempotent when no
  // storm was active: the UPDATE is a no-op when the row has tripped=false
  // or does not exist.
  await deps.resetSignatureStorm()
  void deps.drain()
  deps.log(
    `set-dispatch: on; dispatch re-enabled (cleared reason=${previous.reason ?? 'none'})`,
  )
  return { ok: true, data: { paused: false, clearedReason: previous.reason } }
})

const KNOWN_LEVERS = new Set(['recovery', 'scoring'])

const applyLeverHandler = handler('apply-lever', async (req, deps) => {
  if (!KNOWN_LEVERS.has(req.name)) {
    return { ok: false, error: `apply-lever: unknown lever '${req.name}'` }
  }
  if (req.value !== 'on' && req.value !== 'off') {
    return {
      ok: false,
      error: `apply-lever: value must be 'on' or 'off'; got '${req.value}'`,
    }
  }
  const current = loadDaemonConfig().controlLevers
  applyControlLevers({ ...current, [req.name]: req.value })
  const envKey = req.name === 'recovery' ? 'MARS_RECOVERY_DISABLED' : 'MARS_SCORING_DISABLED'
  deps.log(
    `apply-lever: ${req.name}=${req.value} (${envKey}=${process.env[envKey] ?? '<unset>'})`,
  )
  return { ok: true, data: { name: req.name, value: req.value } }
})

const investigateHandler = handler('investigate', async (req, deps) => {
  const result = await deps.investigateWorktree(req.id)
  return { ok: true, data: result }
})

const diagnoseFailureHandler = handler('diagnose-failure', async (req, deps) => {
  const result = await deps.diagnoseFailure(req.id)
  return { ok: true, data: result }
})

const releaseLeaseHandler = handler('release-lease', async (req, deps) => {
  await deps.handleReleaseLease(req.id, req.abort ?? false, req.note)
  return { ok: true }
})

const stepDoneHandler = handler('step-done', async (req, deps) => {
  await deps.handleStepDone(req.id)
  return { ok: true }
})

const stepResetHandler = handler('step-reset', async (req, deps) => {
  const result = await deps.handleStepReset(req.id, req.stepName)
  return { ok: true, data: result }
})

const shutdownHandler = handler('shutdown', async (req, deps) => {
  // Three modes:
  //   drain=true  → stop picking new work, wait for in-flight to
  //                 finish, then exit. No timeout.
  //   force=true  → exit now and abandon in-flight (legacy
  //                 fast-path; in-flight tasks remain at
  //                 running/verifying in the queue).
  //   neither     → exit only if idle; refuse otherwise so the
  //                 user can pick drain or kill explicitly.
  if (req.drain) {
    if (deps.getAcceptingWork()) {
      deps.setAcceptingWork(false)
      deps.tracker.clearPending()
      deps.log(
        `drain requested; stopped accepting new work (inFlight=${deps.tracker.inFlightCount()})`,
      )
    }
    queueMicrotask(() => {
      void deps.shutdown(false)
    })
    return {
      ok: true,
      data: { inFlight: deps.tracker.inFlightCount(), draining: true },
    }
  }
  if (!req.force && deps.tracker.inFlightCount() > 0) {
    return {
      ok: false,
      error: `${deps.tracker.inFlightCount()} task(s) in flight; pass drain=true to wait or use \`mars daemon kill\` to abort`,
    }
  }
  queueMicrotask(() => {
    void deps.shutdown(req.force === true)
  })
  return { ok: true }
})

const killHandler = handler('kill', async (_req, deps) => {
  // Hard stop: mark every in-flight task failed, then SIGKILL the
  // daemon's process group so every spawned `claude -p` (and any
  // child git/verify processes) dies with it.
  deps.setAcceptingWork(false)
  deps.tracker.clearPending()
  const victims = deps.tracker.inFlightSnapshot()
  deps.log(
    `kill requested; aborting ${victims.length} in-flight task(s): ${
      victims.map((v) => `${v.taskId}(${v.kind})`).join(', ') || '(none)'
    }`,
  )
  // Mark task rows failed so the queue reflects reality after the
  // children are gone. Best-effort — don't block kill on DB I/O.
  for (const v of victims) {
    if (v.kind !== 'implement' && v.kind !== 'triage' && v.kind !== 'refine') continue
    try {
      await updateTask(v.taskId, {
        status: 'failed',
        error: 'killed by `mars daemon kill`',
        failureSignature: DAEMON_KILLED_SIGNATURE,
        failureReason: 'killed by `mars daemon kill`',
        failureReasonCode: 'unknown',
      })
    } catch {
      // best-effort
    }
  }
  // SIGKILL every tracked child (claude -p + any git/verify
  // subprocess) explicitly so the work dies even when we can't
  // safely signal our process group (foreground daemons share the
  // user's terminal pgid). killAllChildren() is a no-op if nothing
  // is in flight.
  const { killAllChildren } = await import('../../lib/git/claude')
  const killedPids = killAllChildren()
  if (killedPids.length > 0) {
    deps.log(`SIGKILL'd ${killedPids.length} child pid(s): ${killedPids.join(', ')}`)
  }
  // Respond before pulling the rug on the event loop. Use a short
  // setTimeout so the response flush actually lands on the wire.
  const { socketPath, pidFile, httpPortFile } = deps.paths
  setTimeout(() => {
    try {
      for (const f of [socketPath, pidFile, httpPortFile]) {
        if (existsSync(f)) {
          try {
            unlinkSync(f)
          } catch {
            // best-effort
          }
        }
      }
    } finally {
      // Belt-and-suspenders: SIGKILL our own process group too when
      // we lead it (detached mode). Catches anything killAllChildren
      // missed (e.g. a child that spawned its own subprocess and
      // exited before we got the pid). In foreground mode the pgid
      // is the user's terminal, so we only kill ourselves.
      try {
        // process.getpgrp is POSIX-only and not in @types/node; cast
        // through unknown so the type checker accepts the lookup.
        const getpgrp = (process as unknown as {
          getpgrp?: () => number
        }).getpgrp
        const pgid = typeof getpgrp === 'function' ? getpgrp() : -1
        if (pgid === process.pid) {
          process.kill(-process.pid, 'SIGKILL')
        } else {
          process.kill(process.pid, 'SIGKILL')
        }
      } catch {
        process.kill(process.pid, 'SIGKILL')
      }
    }
  }, 50)
  return {
    ok: true,
    data: {
      killed: victims.map((v) => ({ taskId: v.taskId, kind: v.kind })),
      killedPids,
    },
  }
})

const previewSpawnHandler = handler('preview.spawn', async (req, deps) => {
  const result = await deps.handlePreviewSpawn(req.taskId, req.cmd, req.cwd)
  return { ok: true, data: result }
})

const previewStatusHandler = handler('preview.status', async (req, deps) => {
  const result = deps.handlePreviewStatus(req.taskId)
  return { ok: true, data: result }
})

const previewTeardownHandler = handler('preview.teardown', async (req, deps) => {
  await deps.handlePreviewTeardown(req.taskId)
  return { ok: true }
})

const mergeCancelHandler = handler('merge.cancel', async (req, deps) => {
  const result = await deps.handleCancelMergeJob(req.jobId)
  return { ok: true, data: result }
})

const taskNoteHandler = handler('task.note', async (req, deps) => {
  const entry = await deps.appendProgress({
    taskId: req.id,
    author: req.author ?? 'cli',
    kind: 'note',
    body: req.body,
  })
  return { ok: true, data: entry }
})

const taskCheckHandler = handler('task.check', async (req, deps) => {
  const entry = await deps.appendProgress({
    taskId: req.id,
    author: req.author ?? 'cli',
    kind: req.uncheck ? 'uncheck' : 'check',
    body: '',
    criterionIndex: req.criterionIndex,
  })
  return { ok: true, data: entry }
})

const mcpAuditAppendHandler = handler('mcp.audit.append', async (req, deps) => {
  await deps.appendMcpWorkerAudit({
    toolName: req.toolName,
    taskId: req.taskId,
    argsJson: req.argsJson,
    ok: req.ok,
    errorMessage: req.errorMessage,
  })
  return { ok: true }
})

const spendControlShowHandler = handler('spend-control.show', async (_req, deps) => {
  const levers = await deps.handleSpendControlShow()
  return { ok: true, data: levers }
})

const spendControlSetHandler = handler('spend-control.set', async (req, deps) => {
  const { patch } = req

  // Range validation — checked before touching the DB.
  if (
    patch.pauseThresholdPct !== undefined &&
    (patch.pauseThresholdPct < 0 || patch.pauseThresholdPct > 100)
  ) {
    return {
      ok: false,
      error: `spend-control.set: pause-at must be 0–100; got ${patch.pauseThresholdPct}`,
    }
  }
  if (
    patch.resumeThresholdPct !== undefined &&
    (patch.resumeThresholdPct < 0 || patch.resumeThresholdPct > 100)
  ) {
    return {
      ok: false,
      error: `spend-control.set: resume-at must be 0–100; got ${patch.resumeThresholdPct}`,
    }
  }
  if (patch.perKindCeilings !== null && patch.perKindCeilings !== undefined) {
    for (const [kind, ceil] of Object.entries(patch.perKindCeilings)) {
      if (!Number.isInteger(ceil) || ceil < 1) {
        return {
          ok: false,
          error: `spend-control.set: ceiling for '${kind}' must be a positive integer; got ${ceil}`,
        }
      }
    }
  }

  // Cross-field check: resume-at < pause-at after merging with current values.
  const current = await deps.handleSpendControlShow()
  const effectivePause = patch.pauseThresholdPct ?? current.pauseThresholdPct
  const effectiveResume = patch.resumeThresholdPct ?? current.resumeThresholdPct
  if (effectiveResume >= effectivePause) {
    return {
      ok: false,
      error: `spend-control.set: resume-at (${effectiveResume}) must be less than pause-at (${effectivePause})`,
    }
  }

  const updated = await deps.handleSpendControlSet(patch)
  return { ok: true, data: updated }
})

const taskContextForWorkerHandler = handler('task.contextForWorker', async (req, _deps) => {
  const task = await getTask(req.id)
  if (!task) {
    return { ok: false, error: `task.contextForWorker: task '${req.id}' not found` }
  }
  const [progressEntries, blockerIds] = await Promise.all([
    Arc.listProgress(req.id),
    listBlockers(req.id),
  ])
  const doneCriteria = task.spec?.doneCriteria ?? []
  const checklist = Arc.deriveChecklist(progressEntries, doneCriteria)
  return {
    ok: true,
    data: {
      id: task.id,
      title: task.intent,
      prompt: task.prompt,
      files: Array.from(task.spec?.files ?? []),
      verify: task.spec?.verifyCmd ?? null,
      done: checklist.map((c) => ({ text: c.criterion, checked: c.checked })),
      mergeMode: task.spec?.mergeMode ?? 'auto',
      status: task.status,
      blockers: blockerIds,
    },
  }
})

/**
 * Clear the durable signature-storm breaker flag.
 *
 * Always calls `resetSignatureStorm()` to clear the durable DB flag. If
 * dispatch is paused with reason 'storm', also resumes dispatch and kicks
 * drain so queued work can proceed. An operator or quota pause is left intact
 * — only the storm-owned flag is cleared, not the entire pause state.
 *
 * The response payload includes `{ resumedDispatch: boolean }` so the CLI can
 * tell the operator whether dispatch was also resumed (true) or only the stale
 * flag was cleaned up (false).
 */
const resetBreakerHandler = handler('reset-breaker', async (_req, deps) => {
  const prevPauseState = deps.getPauseState()
  // Always clear the durable DB flag — this is the whole point of the verb.
  await deps.resetSignatureStorm()
  // Resume dispatch only when the storm breaker was the active pause cause.
  const resumedDispatch = prevPauseState.reason === 'storm'
  if (resumedDispatch) {
    deps.resumeDispatch()
    void deps.drain()
  }
  return {
    ok: true,
    data: { cleared: true, resumedDispatch },
  }
})

/**
 * The full leaf set. Order is help/discovery order; the registry rejects
 * duplicate ops. Mirrors `cli/commands/index.ts`'s `allCommands`.
 */
export const allRpcHandlers: readonly RpcHandler[] = [
  addHandler,
  taskPriorityHandler,
  updateHandler,
  continueHandler,
  stopTaskHandler,
  restartHandler,
  remergeHandler,
  purgeHandler,
  arcPurgeHandler,
  dropHandler,
  unblockHandler,
  blockHandler,
  removeBlockersHandler,
  recoverHandler,
  syncHandler,
  proposalPromoteHandler,
  proposalSliceHandler,
  proposalResliceHandler,
  proposalTakeHandler,
  refineHandler,
  glossaryWriteHandler,
  adrAddHandler,
  visionWriteHandler,
  initHandler,
  statusHandler,
  reloadConfigHandler,
  setDispatchHandler,
  pingHandler,
  investigateHandler,
  diagnoseFailureHandler,
  releaseLeaseHandler,
  stepDoneHandler,
  stepResetHandler,
  shutdownHandler,
  killHandler,
  taskNoteHandler,
  taskCheckHandler,
  mcpAuditAppendHandler,
  taskContextForWorkerHandler,
  previewSpawnHandler,
  previewStatusHandler,
  previewTeardownHandler,
  mergeCancelHandler,
  spendControlShowHandler,
  spendControlSetHandler,
  applyLeverHandler,
  resetBreakerHandler,
]
