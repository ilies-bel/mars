/**
 * `memory` command group — domain-scoped memory packets in .mars/mars.db.
 *
 * Three subcommands:
 *   memory list   — list active packets for a domain
 *   memory add    — insert a new packet
 *   memory retire — soft-delete a packet by id
 *
 * The store functions live in core/store/memory-packet-store (slice 1 of
 * PRD 6544c0a0). Salience is validated with Zod before insertion.
 */

import { z } from 'zod'
import {
  insertMemoryPacket,
  listMemoryPackets,
  retireMemoryPacket,
} from '../../core/store/memory-packet-store'
import type { Command } from '../command'

const salienceSchema = z.number().min(0).max(1)

const memoryGroup: Command = {
  path: 'memory',
  summary: 'manage domain-scoped memory packets',
  usage: 'usage: mars memory <list|add|retire>',
  run: async (_, deps) => {
    deps.err('usage: mars memory <list|add|retire>')
    deps.err('')
    deps.err('  list   --domain <d> [--min-salience <n>] [--limit <n>]')
    deps.err('  add    --domain <d> --text "<text>" [--salience <n>] [--origin-arc <id>]')
    deps.err('  retire <id>')
    return { code: 2 }
  },
}

const memoryList: Command = {
  path: 'memory list',
  summary: 'list active memory packets for a domain',
  usage:
    'usage: mars memory list --domain <d> [--min-salience <n>] [--limit <n>]',
  run: async (args, deps) => {
    const domain = args.flags['--domain']
    if (!domain) {
      deps.err('--domain is required')
      return { code: 1 }
    }

    const minSalienceRaw = args.flags['--min-salience']
    const limitRaw = args.flags['--limit']

    const minSalience = minSalienceRaw !== undefined ? Number(minSalienceRaw) : 0.7
    const limit = limitRaw !== undefined ? Number(limitRaw) : 20

    if (!Number.isFinite(minSalience) || minSalience < 0 || minSalience > 1) {
      deps.err('--min-salience must be a number between 0 and 1')
      return { code: 1 }
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      deps.err('--limit must be a positive integer')
      return { code: 1 }
    }

    const packets = await listMemoryPackets({ domain, minSalience, limit })

    if (packets.length === 0) {
      deps.out('no memory packets found')
      return { code: 0 }
    }

    deps.out(
      `${'id'.padEnd(20)} ${'salience'.padEnd(8)} ${'domain'.padEnd(16)} ${'text'.padEnd(40)} created_at`,
    )
    deps.out(
      `${'--'.padEnd(20)} ${'--------'.padEnd(8)} ${'------'.padEnd(16)} ${'----'.padEnd(40)} ----------`,
    )
    for (const p of packets) {
      const id = p.id.padEnd(20)
      const sal = p.salience.toFixed(2).padEnd(8)
      const dom = p.domain.slice(0, 16).padEnd(16)
      const txt =
        p.text.length > 40 ? p.text.slice(0, 37) + '…' : p.text.padEnd(40)
      deps.out(`${id} ${sal} ${dom} ${txt} ${p.createdAt}`)
    }

    return { code: 0 }
  },
}

const memoryAdd: Command = {
  path: 'memory add',
  summary: 'insert a new domain-scoped memory packet',
  usage:
    'usage: mars memory add --domain <d> --text "<text>" [--salience <n>] [--origin-arc <id>]',
  run: async (args, deps) => {
    const domain = args.flags['--domain']
    const text = args.flags['--text']

    if (!domain) {
      deps.err('--domain is required')
      return { code: 1 }
    }
    if (!text) {
      deps.err('--text is required')
      return { code: 1 }
    }

    const salienceRaw = args.flags['--salience']
    const salienceVal = salienceRaw !== undefined ? Number(salienceRaw) : 0.7

    const parsed = salienceSchema.safeParse(salienceVal)
    if (!parsed.success) {
      deps.err(
        `--salience: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      )
      return { code: 1 }
    }

    const originArcId = args.flags['--origin-arc'] ?? null

    const packet = await insertMemoryPacket({
      domain,
      text,
      salience: parsed.data,
      originArcId,
    })

    deps.out(packet.id)
    return { code: 0 }
  },
}

const memoryRetire: Command = {
  path: 'memory retire',
  summary: 'retire (soft-delete) a memory packet by id',
  usage: 'usage: mars memory retire <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('id is required')
      return { code: 1 }
    }

    const ok = await retireMemoryPacket(id)
    if (!ok) {
      deps.err(`unknown or already retired: ${id}`)
      return { code: 1 }
    }

    deps.out(`retired ${id}`)
    return { code: 0 }
  },
}

export const memoryCommands: readonly Command[] = [
  memoryGroup,
  memoryList,
  memoryAdd,
  memoryRetire,
]
