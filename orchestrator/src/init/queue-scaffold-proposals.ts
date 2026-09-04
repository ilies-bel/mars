import { spawnSync } from 'node:child_process'
import { createProposal } from '../core/proposals'

export interface ScaffoldProposalResult {
  raised: string[]
  skipped: string[]
}

/** Return true when `codegraph` is on PATH. */
const isCodegraphAvailable = (): boolean => {
  try {
    const probe = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['codegraph'],
      { encoding: 'utf8', shell: false },
    )
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}

/**
 * Create one draft-proposal per deferred scaffold component so each appears
 * in the action queue as a separate row the operator can accept individually.
 *
 * Using `fingerprint` makes the function idempotent — re-running `mars init`
 * on an already-initialised repo updates the existing proposal rather than
 * creating a duplicate.
 *
 * The proposals do NOT automatically write files on acceptance; operators use
 * the solution instructions (e.g. `mars scaffold claude-md`) to apply each
 * piece manually. A future operator-decision kind can automate this, but the
 * current draft-proposal kind is sufficient to surface each item in the queue.
 */
export const queueScaffoldProposals = async (
  repoRoot: string,
): Promise<ScaffoldProposalResult> => {
  const raised: string[] = []
  const skipped: string[] = []

  const codegraphFound = isCodegraphAvailable()

  const items = [
    {
      key: 'init:scaffold-claude-md',
      title: 'Add CLAUDE.md routing guide',
      problem:
        `The Mars CLAUDE.md routing guide is not yet present in ${repoRoot}.\n\n` +
        'This file tells Claude Code how to route tasks between the four Mars pipelines ' +
        '(grill → background task → live task → report pipeline) and supplies the ' +
        'project-specific ADR and glossary context. Without it Claude Code sessions ' +
        'do not know how to use Mars.',
      solution:
        'Run `mars scaffold claude-md` to write the bundled CLAUDE.md template into the repo root. ' +
        'Review and commit it as part of your initial Mars scaffold commit.',
    },
    {
      key: 'init:scaffold-mcp-json',
      title: codegraphFound
        ? 'Add codegraph MCP config (.mcp.json) — codegraph found on PATH'
        : 'Add codegraph MCP config (.mcp.json) — install codegraph first',
      problem:
        'The `.mcp.json` that registers the codegraph MCP server is not present.\n\n' +
        'Without it Claude Code sessions cannot use graph-intelligence tools ' +
        '(`codegraph_explore`, `codegraph_callers`, etc.).',
      solution: codegraphFound
        ? 'Run `mars scaffold mcp-json` to write `.mcp.json`. ' +
          'codegraph was found on PATH so graph tools will be active immediately.'
        : 'Install codegraph first (`npm i -g codegraph && codegraph index`), ' +
          'then run `mars scaffold mcp-json` to write `.mcp.json`.',
    },
    {
      key: 'init:scaffold-workflows',
      title: 'Scaffold workflow templates (.mars/workflows/*.js)',
      problem:
        'The user-owned workflow templates have not been copied yet.\n\n' +
        'These `.js` files let you customise each Mars pipeline step. ' +
        'Without them `mars workflow list` shows only the built-in defaults and ' +
        'there is no per-repo customisation surface.',
      solution:
        'Run `mars scaffold workflows` to copy the bundled templates into `.mars/workflows/`. ' +
        'The directory is gitignored, so the files are local and safe to edit freely.',
    },
    {
      key: 'init:activate-plugin',
      title: 'Activate Mars Claude Code plugin (mars:* skills)',
      problem:
        'The Mars Claude Code plugin is not yet registered in ~/.claude/settings.json.\n\n' +
        'Without activation the `/mars:chat`, `/mars:task`, `/mars:grill` and other ' +
        '`mars:*` slash commands are unavailable in Claude Code sessions.',
      solution: 'Run `mars plugin activate` to register the plugin in your user-level Claude Code settings.',
    },
    {
      key: 'init:register-project',
      title: 'Register this repo in the global project list',
      problem:
        'This repository is not yet in the global Mars project registry.\n\n' +
        'Without registration the `mars ui` dashboard cannot locate it from other ' +
        'directories and per-project stats are absent.',
      solution: 'Run `mars project add` to register this repository.',
    },
  ]

  for (const item of items) {
    try {
      await createProposal(item.title, {
        explicitTitle: item.title,
        problem: item.problem,
        solution: item.solution,
        source: 'human',
        fingerprint: item.key,
      })
      raised.push(item.title)
    } catch (err) {
      // Surface non-idempotency errors as warnings; never block init on a
      // proposal-creation failure — the scaffold suggestions are advisory.
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `[mars init] warning: could not queue scaffold proposal "${item.title}": ${msg}\n`,
      )
      skipped.push(item.title)
    }
  }

  return { raised, skipped }
}
