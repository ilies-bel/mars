/**
 * `tool-promotion approve/reject/list` CLI commands.
 *
 * approve: verify attempt is 'benchmarked', copy helper files into the
 *   bundled templates directory, set status='promoted', resolve the matching
 *   action-queue row.
 * reject:  set status='retired', resolve the action-queue row, no files copied.
 * list:    list attempts by status (defaults to 'benchmarked').
 */

import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from '../command'
import type { ToolPromotionStatus } from '../../core/store/tool-promotion-store'

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Base directory where tool-forge coder tasks write helper modules.
 * Tests override via MARS_TOOL_FORGE_SRC_DIR.
 *
 * Default: <pkg-root>/src/tools  (i.e. src/cli/commands → ../../tools)
 */
const resolveToolsSrcBase = (): string => {
  if (process.env.MARS_TOOL_FORGE_SRC_DIR) return process.env.MARS_TOOL_FORGE_SRC_DIR
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools')
}

/**
 * Base directory for bundled tool templates delivered via `mars init`.
 * Tests override via MARS_TOOL_FORGE_TEMPLATES_TOOLS_DIR.
 *
 * Default: <pkg-root>/src/init/templates/tools
 */
const resolveTemplatesToolsBase = (): string => {
  if (process.env.MARS_TOOL_FORGE_TEMPLATES_TOOLS_DIR)
    return process.env.MARS_TOOL_FORGE_TEMPLATES_TOOLS_DIR
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'init', 'templates', 'tools')
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const toolPromotionGroup: Command = {
  path: 'tool-promotion',
  summary: 'tool-promotion subcommands',
  usage: 'usage: mars tool-promotion <approve|reject|list>',
  run: (_args, deps) => {
    deps.err('usage: mars tool-promotion <approve|reject|list>')
    return { code: 1 }
  },
}

const toolPromotionApprove: Command = {
  path: 'tool-promotion approve',
  summary: 'copy helper into bundled templates and mark attempt promoted',
  usage: 'usage: mars tool-promotion approve <attempt-id>',
  run: async (args, deps) => {
    const attemptId = args.positional[0]
    if (!attemptId) {
      deps.err('usage: mars tool-promotion approve <attempt-id>')
      return { code: 1 }
    }

    const { resolveStateClient } = await import('../../core/store/state-client')
    const { initToolPromotionAttempts, getAttempt, updateAttemptStatus } = await import(
      '../../core/store/tool-promotion-store'
    )

    await initToolPromotionAttempts()
    const db = resolveStateClient()

    const attempt = await getAttempt(db, attemptId)
    if (!attempt) {
      deps.err(`error: attempt not found: ${attemptId}`)
      return { code: 1 }
    }

    if (attempt.status !== 'benchmarked') {
      deps.err(
        `error: attempt ${attemptId} has status '${attempt.status}'; only 'benchmarked' attempts can be approved`,
      )
      return { code: 1 }
    }

    const srcDir = resolve(resolveToolsSrcBase(), attempt.helperKey)
    if (!existsSync(srcDir)) {
      deps.err(`error: source directory not found: ${srcDir}`)
      return { code: 1 }
    }

    const destDir = resolve(resolveTemplatesToolsBase(), attempt.helperKey)
    await mkdir(destDir, { recursive: true })
    await cp(srcDir, destDir, { recursive: true })

    const decidedAt = Math.floor(Date.now() / 1000)
    await updateAttemptStatus(db, attemptId, 'promoted', { decidedAt })

    try {
      const { supersedeActionQueueItemsBySignature } = await import(
        '../../core/lib/action-queue'
      )
      await supersedeActionQueueItemsBySignature(
        'tool-promotion',
        `tool-promotion:${attemptId}`,
        'tool-promotion-decided',
        'operator:tool-promotion-approve',
      )
    } catch {
      // Non-fatal: DB update already committed.
    }

    deps.out(`approved: ${attemptId} (${attempt.helperKey})`)
    deps.out(`  copied: ${srcDir} → ${destDir}`)
    return { code: 0 }
  },
}

const toolPromotionReject: Command = {
  path: 'tool-promotion reject',
  summary: 'mark attempt retired without copying any files',
  usage: 'usage: mars tool-promotion reject <attempt-id>',
  run: async (args, deps) => {
    const attemptId = args.positional[0]
    if (!attemptId) {
      deps.err('usage: mars tool-promotion reject <attempt-id>')
      return { code: 1 }
    }

    const { resolveStateClient } = await import('../../core/store/state-client')
    const { initToolPromotionAttempts, getAttempt, updateAttemptStatus } = await import(
      '../../core/store/tool-promotion-store'
    )

    await initToolPromotionAttempts()
    const db = resolveStateClient()

    const attempt = await getAttempt(db, attemptId)
    if (!attempt) {
      deps.err(`error: attempt not found: ${attemptId}`)
      return { code: 1 }
    }

    if (attempt.status !== 'benchmarked') {
      deps.err(
        `error: attempt ${attemptId} has status '${attempt.status}'; only 'benchmarked' attempts can be rejected`,
      )
      return { code: 1 }
    }

    const decidedAt = Math.floor(Date.now() / 1000)
    await updateAttemptStatus(db, attemptId, 'retired', { decidedAt })

    try {
      const { supersedeActionQueueItemsBySignature } = await import(
        '../../core/lib/action-queue'
      )
      await supersedeActionQueueItemsBySignature(
        'tool-promotion',
        `tool-promotion:${attemptId}`,
        'tool-promotion-decided',
        'operator:tool-promotion-reject',
      )
    } catch {
      // Non-fatal: DB update already committed.
    }

    deps.out(`rejected: ${attemptId} (${attempt.helperKey})`)
    return { code: 0 }
  },
}

const toolPromotionList: Command = {
  path: 'tool-promotion list',
  summary: 'list promotion attempts filtered by status',
  usage:
    'usage: mars tool-promotion list [--status <proposed|benchmarked|promoted|retired>]',
  run: async (args, deps) => {
    const status = (args.flags['--status'] ?? 'benchmarked') as string

    const validStatuses: ToolPromotionStatus[] = [
      'proposed',
      'benchmarked',
      'promoted',
      'retired',
    ]
    if (!validStatuses.includes(status as ToolPromotionStatus)) {
      deps.err(
        `error: invalid status '${status}'; must be one of: ${validStatuses.join(', ')}`,
      )
      return { code: 1 }
    }

    const { resolveStateClient } = await import('../../core/store/state-client')
    const { initToolPromotionAttempts, listAttemptsByStatus } = await import(
      '../../core/store/tool-promotion-store'
    )

    await initToolPromotionAttempts()
    const db = resolveStateClient()

    const attempts = await listAttemptsByStatus(db, status as ToolPromotionStatus)

    if (attempts.length === 0) {
      deps.out(`no attempts with status '${status}'`)
      return { code: 0 }
    }

    for (const a of attempts) {
      deps.out(`${a.id}\t${a.status}\t${a.helperKey}`)
    }
    return { code: 0 }
  },
}

export const toolPromotionCommands: readonly Command[] = [
  toolPromotionGroup,
  toolPromotionApprove,
  toolPromotionReject,
  toolPromotionList,
]
