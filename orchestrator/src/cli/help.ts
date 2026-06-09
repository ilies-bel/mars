/**
 * Top-level `mars --help` text, derived from the Command registry.
 *
 * The "Commands:" section is generated from {@link groupByTopLevel}, so a new
 * Command added to any `commands/*.ts` file appears in help automatically.
 * Group-fallback leaves (bare 'task', 'proposal', etc. whose summary is
 * '<top> subcommands') are suppressed — only real, invocable verbs are
 * listed. Bare aliases that carry a non-fallback summary (e.g. `action-queue`
 * → "list open action queue items (alias for `list open`)") survive.
 *
 * The intro paragraph, "Plan flags", "Author flag", "Repo resolution", and
 * "Other env" sections are not per-verb and stay hand-written here.
 */

import { groupByTopLevel, type CommandRegistry } from './registry'

/** Column the summary starts at within a generated command line. */
const SUMMARY_COLUMN = 32

const padPath = (path: string): string => {
  if (path.length + 4 >= SUMMARY_COLUMN) {
    // Path is too long for the summary column. Break to a new line so the
    // summary stays aligned with everyone else, rather than collide.
    return `${path}\n${' '.repeat(SUMMARY_COLUMN)}`
  }
  return path.padEnd(SUMMARY_COLUMN - 2)
}

/**
 * Render the "Commands:" body as text. Each leaf is one line of
 * `  <path>   <summary>`, in registry insertion order, grouped by `path[0]`.
 *
 * Bare-group fallback leaves (`path === top` and summary literally equals
 * `'<top> subcommands'`) are suppressed: they exist for routing/help-on-typo
 * and would clutter the top-level list. Real bare aliases (whose summary is
 * something other than '<top> subcommands') are kept.
 */
export const buildCommandList = (registry: CommandRegistry): string => {
  const groups = groupByTopLevel(registry)
  const lines: string[] = []
  for (const [top, cmds] of groups) {
    for (const cmd of cmds) {
      if (cmd.path === top && cmd.summary === `${top} subcommands`) continue
      lines.push(`  ${padPath(cmd.path)}${cmd.summary}`)
    }
  }
  return lines.join('\n')
}

/** Static sections that are not per-verb and stay hand-written. */
const TRAILER = `
  help                          show this message
  --version, -v                 print mars version and exit

Plan flags for 'task add':
  --functional <text|@file>     functional plan text (or @path to read a file)
  --func <text|@file>           alias for --functional
  --technical <text|@file>      technical plan text (or @path to read a file)
  --tech <text|@file>           alias for --technical
  --functional-file <path>      read functional plan from a file
  --technical-file <path>       read technical plan from a file

Author flag for 'task add' / 'proposal add':
  --author <kind:name>          override detected author. kind is human|agent
                                (e.g. --author agent:vega, --author human:alice).
                                When omitted, detected from env: agent if any of
                                MARS_AGENT_NAME, CLAUDE_CODE, CLAUDECODE,
                                CLAUDE_AGENT, ANTHROPIC_AGENT is set; otherwise
                                human (name from git user.email).

Repo resolution (in priority order):
  1. --repo <path>
  2. $MARS_REPO env var
  3. \`git rev-parse --show-toplevel\` from cwd

Other env:
  INTEGRATION_BRANCH       target branch for merges (default: main)
  MARS_REFLECT_DISABLED=1  skip per-task token/cost capture and short-circuit
                           'mars reflect'. Scorers stay attached either way.
`

/**
 * Build the full `mars --help` text: header + generated command list +
 * static trailer.
 */
export const buildUsage = (registry: CommandRegistry): string => {
  return `mars — orchestrator for parallel Claude Code task workflows

Usage:
  mars [--repo <path>] <command> [args]

Commands:
${buildCommandList(registry)}
${TRAILER}`
}
