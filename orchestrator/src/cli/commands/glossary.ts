/**
 * `glossary` command group: `set`, `remove` (daemon-routed writes to
 * CONTEXT.md) and `list`, `show` (local reads). The grouping is path-keyed;
 * transport varies per-subcommand (writes via daemon, reads via the local
 * glossary file), which is exactly why transport is injected, not a taxonomy.
 */

import { resolve as resolvePath } from 'node:path'
import {
  readGlossaryFile,
  generateDefaultSurfaceForms,
} from '../../core/lib/glossary'
import type { Command } from '../command'
import { spawnNoticeErr } from './shared'

const contextPathFor = (repoRoot: string): string =>
  resolvePath(repoRoot, 'CONTEXT.md')

const glossarySet: Command = {
  path: 'glossary set',
  summary: 'set a glossary term (daemon-routed write to CONTEXT.md)',
  usage:
    'usage: mars glossary set "<term>" "<definition>" [--avoid alias1,alias2] [--surface-form f1 ...]',
  run: async (args, deps) => {
    const term = args.positional[0]
    const definition = args.positional[1]
    if (!term || !definition) {
      deps.err(
        'usage: mars glossary set "<term>" "<definition>" [--avoid alias1,alias2] [--surface-form f1 ...]',
      )
      return { code: 2 }
    }
    const aliasFlag = args.flags['--avoid']
    const aliases = aliasFlag
      ? aliasFlag
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a.length > 0)
      : []
    const sfFlags = args.multiFlags['--surface-form'] ?? []
    const surfaceForms = sfFlags.length > 0 ? sfFlags : undefined
    await deps.daemon.sendRequest(
      {
        op: 'glossary-write',
        kind: 'set',
        term,
        definition,
        aliases,
        surfaceForms,
      },
      { onSpawnNotice: spawnNoticeErr(deps.err) },
    )
    deps.out(`glossary set dispatched: "${term}"`)
    return { code: 0 }
  },
}

const glossaryRemove: Command = {
  path: 'glossary remove',
  summary: 'remove a glossary term (daemon-routed write)',
  usage: 'usage: mars glossary remove "<term>"',
  run: async (args, deps) => {
    const term = args.positional[0]
    if (!term) {
      deps.err('usage: mars glossary remove "<term>"')
      return { code: 2 }
    }
    await deps.daemon.sendRequest(
      { op: 'glossary-write', kind: 'remove', term },
      { onSpawnNotice: spawnNoticeErr(deps.err) },
    )
    deps.out(`glossary remove dispatched: "${term}"`)
    return { code: 0 }
  },
}

const glossaryList: Command = {
  path: 'glossary list',
  summary: 'list glossary terms (local read)',
  usage: 'usage: mars glossary list',
  run: async (_args, deps) => {
    const doc = await readGlossaryFile(contextPathFor(deps.ctx.repoRoot))
    if (doc.terms.length === 0) {
      deps.out('(no glossary terms; CONTEXT.md is empty or missing)')
      return { code: 0 }
    }
    for (const t of doc.terms) {
      const aliases =
        t.aliases.length > 0 ? `  (avoid: ${t.aliases.join(', ')})` : ''
      deps.out(`${t.term}${aliases}`)
    }
    return { code: 0 }
  },
}

const glossaryShow: Command = {
  path: 'glossary show',
  summary: 'show a single glossary term (local read)',
  usage: 'usage: mars glossary show "<term>"',
  run: async (args, deps) => {
    const term = args.positional[0]
    if (!term) {
      deps.err('usage: mars glossary show "<term>"')
      return { code: 2 }
    }
    const doc = await readGlossaryFile(contextPathFor(deps.ctx.repoRoot))
    const lower = term.toLowerCase()
    const found = doc.terms.find((t) => t.term.toLowerCase() === lower)
    if (!found) {
      deps.err(`term "${term}" not found in CONTEXT.md`)
      return { code: 1 }
    }
    deps.out(`term:        ${found.term}`)
    deps.out(`definition:  ${found.definition}`)
    if (found.aliases.length > 0) {
      deps.out(`avoid:       ${found.aliases.join(', ')}`)
    }
    const forms =
      found.surfaceForms.length > 0
        ? found.surfaceForms
        : generateDefaultSurfaceForms(found.term)
    deps.out(`surface forms: ${[...forms].join(', ')}`)
    return { code: 0 }
  },
}

const glossaryGroup: Command = {
  path: 'glossary',
  summary: 'glossary subcommands',
  usage: 'usage: mars glossary <set|remove|list|show> ...',
  run: (_args, deps) => {
    deps.err('usage: mars glossary <set|remove|list|show> ...')
    return { code: 2 }
  },
}

export const glossaryCommands: readonly Command[] = [
  glossarySet,
  glossaryRemove,
  glossaryList,
  glossaryShow,
  glossaryGroup,
]
