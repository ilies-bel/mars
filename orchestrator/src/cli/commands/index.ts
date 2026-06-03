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
import { diagnoseCommands } from './diagnose'
import { miscCommands } from './misc'
import { reflectCommands } from './reflect'
import { installCommands } from './install'

export const allCommands: readonly Command[] = [
  ...taskCommands,
  ...proposalCommands,
  ...lifecycleCommands,
  ...workerCommands,
  ...glossaryCommands,
  ...adrCommands,
  ...daemonCommands,
  ...actionQueueCommands,
  ...diagnoseCommands,
  ...miscCommands,
  ...reflectCommands,
  ...installCommands,
]

export const registry: CommandRegistry = buildRegistry(allCommands)
