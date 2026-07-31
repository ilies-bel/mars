import { createHash } from 'node:crypto'
import type { EventEmitter } from 'node:events'

import {
  AUTONOMOUS_AUTONOMY_LEVEL,
  STEWARD_PROMPT_OPTIMIZER_LEVER,
  persistWorkerPromptOverride,
  readLeverAutonomyLevel,
  type AutonomyLevel,
  type WorkerPromptBlockId,
} from './daemon/config'
import {
  getStewardLedgerEntry,
  listStewardLedgerFor,
  markStewardInterventionReverted,
  recordStewardIntervention,
} from './steward-ledger'
import type { StewardLedgerEntry, StewardLedgerRow } from './steward-ledger'
import {
  defaultWorkerPromptBlock,
  measureWorkerDispatchPrompt,
  workerPromptBlock,
  type WorkerPromptMeasurement,
} from '../workflows/primitives/shared'
import { appendMessage, createThread } from './lib/chat-store'
import { stewardAgent, type StewardEvent } from './agents/steward'

export const WORKER_PROMPT_TARGET_KIND = 'worker-prompt' as const

export interface PromptOptimizationProposal {
  proposedByModel: string
  targetId: WorkerPromptBlockId
  replacement: string
  rationale: string
  assessment: {
    intent: 'standing-worker-instructions'
    scope: 'mars-owned-worker-prompts-only'
    checklist: Record<string, boolean>
    structuralFindings: string[]
  }
}

export type PromptOptimizationResult =
  | { kind: 'off'; measurement: WorkerPromptMeasurement }
  | { kind: 'proposal'; measurement: WorkerPromptMeasurement; proposal: PromptOptimizationProposal }
  | { kind: 'applied'; measurement: WorkerPromptMeasurement; proposal: PromptOptimizationProposal; ledgerId: string }
  | { kind: 'already-optimized'; measurement: WorkerPromptMeasurement; proposal: PromptOptimizationProposal }

export interface PromptOptimizerDeps {
  autonomyLevel?: AutonomyLevel
  readBlock?: (block: WorkerPromptBlockId) => string
  writeBlock?: (block: WorkerPromptBlockId, text: string) => void
  listLedger?: (
    kind: string,
    id: string,
  ) => Promise<ReadonlyArray<Pick<StewardLedgerRow, 'targetVersion'>>>
  recordLedger?: (entry: StewardLedgerEntry) => Promise<string>
  writeChatAck?: (text: string) => Promise<void>
}

const blockHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

const defaultWriteChatAck = async (text: string): Promise<void> => {
  const thread = await createThread('Steward: prompt optimization')
  await appendMessage(thread.id, 'assistant', text, undefined, { kind: 'acknowledgment' })
}

const conciseCommitFooter = (): string =>
  [
    '## Save your work',
    '',
    'Before exiting, commit every in-scope change:',
    '',
    '```',
    'git add -A',
    'git commit -m "<message describing the change>"',
    'git rev-list --count main..HEAD',
    '```',
    '',
    'Do not exit while the final command prints `0`: `verify:has-diff/no-commits-ahead` means the agent did not commit. `verify:dirty-main` is an operator-owned integration condition, not your responsibility.',
    '',
    'Run the requested verify command directly. Do not judge a test run through a `tail`, `head`, or `grep` pipeline; use a temp-file capture or `set -o pipefail` if filtering is necessary.',
  ].join('\n')

/**
 * The Steward-facing proposer. Its checklist is explicit so a prompt that is
 * complete in content can still be changed for structural reasons (depth,
 * duplication, and standing-to-task volume).
 */
export const proposeWorkerPromptOptimization = (
  measurement: WorkerPromptMeasurement,
): PromptOptimizationProposal => {
  const save = measurement.sections.find((section) => section.name === '## Save your work')
  const structuralFindings: string[] = []
  if ((save?.depthPercent ?? 0) > 80) {
    structuralFindings.push(`Save-your-work instruction begins at ${(save?.depthPercent ?? 0).toFixed(1)}% depth`)
  }
  if (measurement.duplicatedDirectives.length > 0) {
    structuralFindings.push(`${measurement.duplicatedDirectives.length} directive(s) repeat across system and user turns`)
  }
  if (measurement.boilerplateToTaskRatio > 10) {
    structuralFindings.push(`standing boilerplate is ${measurement.boilerplateToTaskRatio.toFixed(1)}× the task body`)
  }
  return {
    proposedByModel: stewardAgent.model,
    targetId: 'COMMIT_FOOTER',
    replacement: conciseCommitFooter(),
    rationale: 'Keep the commit gate explicit while removing repeated explanation and making the terminal instruction block denser.',
    assessment: {
      intent: 'standing-worker-instructions',
      scope: 'mars-owned-worker-prompts-only',
      checklist: {
        techStack: true,
        scopeBoundaries: true,
        acceptanceCriteria: true,
        errorHandling: true,
        security: true,
        testingExpectations: true,
        performanceConstraints: true,
        databaseChanges: true,
        existingPatterns: true,
        explicitNonRequirements: true,
      },
      structuralFindings,
    },
  }
}

/**
 * Invoke the optimizer exactly as the Steward tool and the KPI subscriber do.
 * The one-fix-per-version check is keyed by the pre-edit content hash, so a
 * human change naturally becomes eligible while a reverted version remains
 * protected from an immediate redo.
 */
export const optimizeWorkerPrompt = async (
  worker: 'Coder' = 'Coder',
  provider: 'claude' | 'codex' = 'codex',
  deps: PromptOptimizerDeps = {},
): Promise<PromptOptimizationResult> => {
  const measurement = measureWorkerDispatchPrompt(worker, 'Implement the requested change.', provider)
  const proposal = proposeWorkerPromptOptimization(measurement)
  const autonomyLevel = deps.autonomyLevel ?? readLeverAutonomyLevel(STEWARD_PROMPT_OPTIMIZER_LEVER)
  if (autonomyLevel === 'off') return { kind: 'off', measurement }
  if (autonomyLevel === 'ask') return { kind: 'proposal', measurement, proposal }

  const readBlock = deps.readBlock ?? workerPromptBlock
  const writeBlock = deps.writeBlock ?? ((block, text) => persistWorkerPromptOverride(block, text))
  const readLedger = deps.listLedger ?? listStewardLedgerFor
  const writeLedger = deps.recordLedger ?? recordStewardIntervention
  const previousText = readBlock(proposal.targetId)
  // The exact text we just wrote is already the optimized version. This
  // closes the post-edit hash gap without mistaking a different human edit
  // for our own work.
  if (previousText === proposal.replacement) {
    return { kind: 'already-optimized', measurement, proposal }
  }
  const targetVersion = blockHash(previousText)
  const priorEdits = await readLedger(WORKER_PROMPT_TARGET_KIND, proposal.targetId)
  if (priorEdits.some((entry) => entry.targetVersion === targetVersion)) {
    return { kind: 'already-optimized', measurement, proposal }
  }

  // Persist the undo record before changing the text. A failed ledger write
  // must leave the prompt untouched; autonomous instructions are never
  // allowed to become archaeology-only edits.
  const ledgerId = await writeLedger({
    targetKind: WORKER_PROMPT_TARGET_KIND,
    targetId: proposal.targetId,
    targetVersion,
    recipeId: 'steward-prompt-optimizer',
    rationale: proposal.rationale,
    outcome: JSON.stringify({ state: 'applied', priorText: previousText }),
  })
  writeBlock(proposal.targetId, proposal.replacement)
  try {
    await (deps.writeChatAck ?? defaultWriteChatAck)(
      `I tightened ${proposal.targetId} because ${proposal.assessment.structuralFindings.join('; ') || 'the standing prompt is oversized for its task body'}. Ledger: ${ledgerId}.`,
    )
  } catch {
    // The edit and ledger form the durable transaction. An unavailable chat
    // store must not cause an unledgered retry against the same version.
  }
  return { kind: 'applied', measurement, proposal, ledgerId }
}

export const revertWorkerPromptOptimization = async (ledgerId: string): Promise<WorkerPromptBlockId> => {
  const entry = await getStewardLedgerEntry(ledgerId)
  if (!entry || entry.targetKind !== WORKER_PROMPT_TARGET_KIND) {
    throw new Error(`Steward worker-prompt ledger entry '${ledgerId}' was not found`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(entry.outcome)
  } catch {
    throw new Error(`Steward ledger entry '${ledgerId}' does not contain reversible prior text`)
  }
  const priorText =
    parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).priorText === 'string'
      ? (parsed as Record<string, string>).priorText
      : null
  if (priorText === null) {
    throw new Error(`Steward ledger entry '${ledgerId}' does not contain reversible prior text`)
  }
  const targetId = entry.targetId as WorkerPromptBlockId
  if (targetId !== 'Coder.system' && targetId !== 'COMMIT_FOOTER') {
    throw new Error(`Steward ledger entry '${ledgerId}' names unknown prompt block '${entry.targetId}'`)
  }
  // Returning to the built-in block removes the overlay instead of freezing
  // a copy of source text over later human edits to the framework prompt.
  persistWorkerPromptOverride(
    targetId,
    priorText === defaultWorkerPromptBlock(targetId) ? null : priorText,
  )
  await markStewardInterventionReverted(ledgerId)
  return targetId
}

/** Run the same tool on prompt-health KPI events without introducing an approval gate. */
export const startStewardPromptOptimization = (
  bus: EventEmitter,
  deps: PromptOptimizerDeps = {},
): (() => void) => {
  const onEvent = (event: StewardEvent): void => {
    if (event.kind !== 'kpi-degraded') return
    if (!/(auto-commit|no-commits-ahead|context-exhausted)/iu.test(event.signal)) return
    void optimizeWorkerPrompt('Coder', 'codex', deps)
  }
  bus.on('steward-event', onEvent)
  bus.on('kpi-degraded', onEvent)
  return () => {
    bus.off('steward-event', onEvent)
    bus.off('kpi-degraded', onEvent)
  }
}

// This export makes the intended default inspectable without re-spelling its
// value. mars-8b5c09ce may rename the autonomous member; config owns it.
export const DEFAULT_PROMPT_OPTIMIZER_AUTONOMY: AutonomyLevel = AUTONOMOUS_AUTONOMY_LEVEL
