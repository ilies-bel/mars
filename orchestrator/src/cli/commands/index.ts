/**
 * The full leaf set, assembled into the flat path-keyed registry.
 *
 * Every invocable path in the CLI is one entry here. The order within a group
 * is help/discovery order; the registry rejects duplicate paths.
 */

import { buildRegistry, type CommandRegistry } from '../registry'
import type { Command } from '../command'
import { taskCommands } from './task'
import { proposalCommands } from './proposal'
import { lifecycleCommands } from './lifecycle'
import { workerCommands } from './worker'
import { glossaryCommands } from './glossary'
import { adrCommands } from './adr'
import { daemonCommands } from './daemon'
import { actionQueueCommands } from './action-queue'
import { alertCommands } from './alert'
import { noticeCommands } from './notice'
import { diagnoseCommands } from './diagnose'
import { miscCommands } from './misc'
import { reflectCommands } from './reflect'
import { scorerCommands } from './scorer'
import { installCommands } from './install'
import { doctorCommands } from './doctor'
import { runCommands } from './run'
import { workflowCommands } from './workflow'
import { stepCommands } from './step'
import { enrichCommands } from './enrich'
import { notificationsCommands } from './notifications'
import { selfUpdateCommands } from './self-update'
import { skillForgeCommands } from './skill-forge'
import { toolForgeCommands } from './tool-forge'
import { toolPromotionCommands } from './tool-promotion'
import { memoryCommands } from './memory'
import { visionCommands } from './vision'
import { operatorCommands } from './operator'
import { chatFeedbackCommands } from './chat-feedback'
import { releaseNotesCommands } from './release-notes'
import { verifyGateCommands } from './verify-gate'
import { verifyCommands } from './verify'
import { credentialsCommands } from './credentials'
import { proposeCommands } from './propose'
import { mergeCommands } from './merge'
import { deployCommands } from './deploy'
import { purgeCommands } from './purge'
import { mcpWorkerCommands } from './mcp-worker'
import { worktreeCommands } from './worktree'
import { stewardCommands } from './steward'
import { previewValidationCommands } from './preview-validation'
import { leverCommands } from './lever'

export const allCommands: readonly Command[] = [
  ...taskCommands,
  ...proposalCommands,
  ...lifecycleCommands,
  ...stepCommands,
  ...previewValidationCommands,
  ...workerCommands,
  ...glossaryCommands,
  ...adrCommands,
  ...daemonCommands,
  ...actionQueueCommands,
  ...alertCommands,
  ...noticeCommands,
  ...diagnoseCommands,
  ...miscCommands,
  ...reflectCommands,
  ...scorerCommands,
  ...skillForgeCommands,
  ...toolForgeCommands,
  ...toolPromotionCommands,
  ...installCommands,
  ...doctorCommands,
  ...runCommands,
  ...workflowCommands,
  ...enrichCommands,
  ...notificationsCommands,
  ...selfUpdateCommands,
  ...memoryCommands,
  ...visionCommands,
  ...operatorCommands,
  ...chatFeedbackCommands,
  ...releaseNotesCommands,
  ...verifyGateCommands,
  ...verifyCommands,
  ...credentialsCommands,
  ...proposeCommands,
  ...mergeCommands,
  ...deployCommands,
  ...purgeCommands,
  ...mcpWorkerCommands,
  ...worktreeCommands,
  ...stewardCommands,
  ...leverCommands,
]

export const registry: CommandRegistry = buildRegistry(allCommands)
