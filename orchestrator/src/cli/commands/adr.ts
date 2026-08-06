/**
 * `adr` command group: `add` and `supersede` (daemon-routed writes to
 * docs/knowledge/decisions/) plus `list` and `show` (local filesystem reads).
 */

import { resolve as resolvePath } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { readMaybeFile } from '../args'
import type { Command } from '../command'
import { spawnNoticeErr } from './shared'
import { parseAdrStatus } from '../../core/lib/adr'

const adrDirFor = (repoRoot: string): string =>
  resolvePath(repoRoot, 'docs/knowledge/decisions')

const adrAdd: Command = {
  path: 'adr add',
  summary: 'add an ADR (daemon-routed write to docs/knowledge/decisions/)',
  usage: 'usage: mars adr add "<title>" "<body>" (body may be @path)',
  run: async (args, deps) => {
    const title = args.positional[0]
    const bodyArg = args.positional.slice(1).join(' ')
    if (!title || !bodyArg) {
      deps.err(
        'usage: mars adr add "<title>" "<body>" (body may be @path to read a file)',
      )
      return { code: 2 }
    }
    const body = readMaybeFile(bodyArg)
    await deps.daemon.sendRequest(
      { op: 'adr-add', title, body },
      { onSpawnNotice: spawnNoticeErr(deps.err) },
    )
    deps.out(`adr add dispatched: "${title}"`)
    return { code: 0 }
  },
}

const adrSupersede: Command = {
  path: 'adr supersede',
  summary: 'mark an ADR as superseded by another (daemon-routed write)',
  usage: 'usage: mars adr supersede <old-NNNN> <new-NNNN>',
  run: async (args, deps) => {
    const oldArg = args.positional[0]
    const newArg = args.positional[1]
    if (!oldArg || !newArg || !/^\d+$/.test(oldArg) || !/^\d+$/.test(newArg)) {
      deps.err('usage: mars adr supersede <old-NNNN> <new-NNNN>')
      return { code: 2 }
    }
    const oldNumber = oldArg.padStart(4, '0')
    const newNumber = newArg.padStart(4, '0')
    await deps.daemon.sendRequest(
      { op: 'adr-supersede', oldNumber, newNumber },
      { onSpawnNotice: spawnNoticeErr(deps.err) },
    )
    deps.out(`adr supersede dispatched: ${oldNumber} → ${newNumber}`)
    return { code: 0 }
  },
}

const adrList: Command = {
  path: 'adr list',
  summary: 'list ADRs (local read); superseded entries are marked',
  usage: 'usage: mars adr list',
  run: async (_args, deps) => {
    const adrDir = adrDirFor(deps.ctx.repoRoot)
    let entries: string[]
    try {
      entries = await readdir(adrDir)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        deps.out('(no ADRs; docs/knowledge/decisions/ does not exist yet)')
        return { code: 0 }
      }
      throw err
    }
    const adrs = entries
      .filter((n) => /^\d{4}-[a-z0-9-]+\.md$/.test(n))
      .sort()
    if (adrs.length === 0) {
      deps.out('(no ADRs in docs/knowledge/decisions/)')
      return { code: 0 }
    }
    for (const name of adrs) {
      const text = await readFile(resolvePath(adrDir, name), 'utf8')
      const firstLine = text.split('\n', 1)[0] ?? ''
      const title = firstLine.replace(/^#\s*/, '').trim()
      const statusInfo = parseAdrStatus(text)
      const statusSuffix = statusInfo ? ` [superseded → ${statusInfo.supersededBy}]` : ''
      deps.out(`${name}\t${title}${statusSuffix}`)
    }
    return { code: 0 }
  },
}

const adrShow: Command = {
  path: 'adr show',
  summary: 'show an ADR by number or filename (local read)',
  usage: 'usage: mars adr show <NNNN|filename>',
  run: async (args, deps) => {
    const arg = args.positional[0]
    if (!arg) {
      deps.err('usage: mars adr show <NNNN|filename>')
      return { code: 2 }
    }
    const adrDir = adrDirFor(deps.ctx.repoRoot)
    let entries: string[]
    try {
      entries = await readdir(adrDir)
    } catch {
      deps.err(`no ADR matching "${arg}" (docs/knowledge/decisions/ does not exist)`)
      return { code: 1 }
    }
    const padded = /^\d+$/.test(arg) ? arg.padStart(4, '0') : null
    const match = entries.find((name) => {
      if (name === arg) return true
      if (padded && name.startsWith(`${padded}-`)) return true
      return false
    })
    if (!match) {
      deps.err(`no ADR matching "${arg}" in docs/knowledge/decisions/`)
      return { code: 1 }
    }
    const text = await readFile(resolvePath(adrDir, match), 'utf8')
    // Preserve exact byte-for-byte body (no trailing newline injection).
    deps.out(text.endsWith('\n') ? text.slice(0, -1) : text)
    return { code: 0 }
  },
}

const adrGroup: Command = {
  path: 'adr',
  summary: 'adr subcommands',
  usage: 'usage: mars adr <add|list|show|supersede> ...',
  run: (_args, deps) => {
    deps.err('usage: mars adr <add|list|show|supersede> ...')
    return { code: 2 }
  },
}

export const adrCommands: readonly Command[] = [
  adrAdd,
  adrSupersede,
  adrList,
  adrShow,
  adrGroup,
]
