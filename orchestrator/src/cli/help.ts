import type { Command } from './command'
import { groupByTopLevel, type CommandRegistry } from './registry'

const stripUsagePrefix = (usage: string): string => usage.replace(/^usage:\s*/, '')

/** Render detailed help for one registered command from its owned metadata. */
export const renderCommandHelp = (registry: CommandRegistry, command: Command): string => {
  if (command.helpBody) return command.helpBody

  const children = command.path.includes(' ')
    ? []
    : (groupByTopLevel(registry).get(command.path) ?? []).filter(
        (candidate) => candidate.path !== command.path,
      )
  let subcommands = ''
  if (children.length > 0) {
    const width = Math.max(...children.map((child) => stripUsagePrefix(child.usage).length))
    subcommands = `\n\nSubcommands:\n${children
      .map((child) => `  ${stripUsagePrefix(child.usage).padEnd(width)}  ${child.summary}`)
      .join('\n')}`
  }

  let flags = ''
  if (command.flags && command.flags.length > 0) {
    const width = Math.max(...command.flags.map((flag) => flag.syntax.length))
    flags = `\n\nFlags:\n${command.flags
      .map((flag) => `  ${flag.syntax.padEnd(width)}  ${flag.description}`)
      .join('\n')}`
  }

  return `${stripUsagePrefix(command.usage)}\n\n${command.summary}${subcommands}${flags}`
}

/** Render the top-level discovery screen from the registry's insertion order. */
export const renderTopLevelHelp = (registry: CommandRegistry): string => {
  const commands = [...registry.values()]
  return `mars — provider-agnostic orchestrator for parallel agent task workflows

Usage:
  mars [--repo <path>] <command> [args]

Commands:
${commands
  .map(
    (command) =>
      `  ${stripUsagePrefix(command.usage).replace(/^mars\s+/, '')}\n      ${command.summary}`,
  )
  .join('\n')}

Run 'mars help <command>' or 'mars <command> --help' for details.`
}
