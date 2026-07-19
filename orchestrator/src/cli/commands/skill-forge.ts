/**
 * `skill-forge scan` CLI command.
 *
 * Reads completed arc deep-reflection reports, runs the cross-arc lesson
 * detector, synthesizes a draft SKILL.md per surviving lesson, and files one
 * draft proposal (source='skill-forge') per lesson.  Re-running is idempotent:
 * a lesson whose title already has a skill-forge proposal is skipped.
 */

import type { Command } from '../command'

/**
 * Core scan logic: detects cross-arc lessons, synthesizes SKILL.md drafts, and
 * files draft proposals (source='skill-forge'). Idempotent: lessons with an
 * existing proposal are counted as skipped, not duplicated.
 *
 * Called from both `skill-forge scan` and the `reflect` tail so recurring
 * lessons surface without a separate operator gesture.
 */
export async function runSkillForgeScan(options?: {
  limit?: number
}): Promise<{ filed: number; skipped: number }> {
  const limit = options?.limit ?? 50

  const { loadRecentDeepReflectRows } = await import('../../core/lib/deep-reflect-query')
  const { detectCrossArcLessons } = await import('../../core/lib/skill-forge-detector')
  const { synthesizeSkillMarkdown } = await import('../../core/lib/skill-forge-synthesizer')
  const { validateSkillAgainstArc } = await import('../../core/lib/skill-forge-validate')
  const { createProposal, listProposals, initProposals } = await import('../../core/proposals')

  await initProposals()

  const rows = await loadRecentDeepReflectRows({ limit })
  if (rows.length === 0) {
    return { filed: 0, skipped: 0 }
  }

  const lessons = detectCrossArcLessons(rows)
  if (lessons.length === 0) {
    return { filed: 0, skipped: 0 }
  }

  const existing = await listProposals({ source: 'skill-forge' })
  const existingTitles = new Set(existing.map((p) => p.title))

  let filed = 0
  let skipped = 0
  for (const lesson of lessons) {
    const { name, markdown } = synthesizeSkillMarkdown(lesson)
    const title = `Skill: ${name}`

    if (existingTitles.has(title)) {
      skipped++
      continue
    }

    const arcOriginId = lesson.motivatingArcOriginIds[0]
    const arcRows = rows.filter((r) => r.originId === arcOriginId)
    const { verdict, evidence } = validateSkillAgainstArc(markdown, arcRows)

    const ids = lesson.motivatingArcOriginIds.join(',')
    const notes = `validation: ${verdict}\nevidence: ${evidence}\n\nmotivating_arcs: ${ids}\n\n${markdown}`

    await createProposal(title, {
      source: 'skill-forge',
      solution: markdown,
      notes,
    })
    filed++
  }

  return { filed, skipped }
}

const skillForgeGroup: Command = {
  path: 'skill-forge',
  summary: 'skill-forge subcommands',
  usage: 'usage: mars skill-forge <scan>',
  run: (_args, deps) => {
    deps.err('usage: mars skill-forge <scan>')
    return { code: 1 }
  },
}

const skillForgeScan: Command = {
  path: 'skill-forge scan',
  summary: 'synthesize recurring deep-reflect lessons into draft skill proposals',
  usage: 'usage: mars skill-forge scan [--limit <n>]',
  run: async (args, deps) => {
    const limitFlag = args.flags['--limit']
    const limit = limitFlag !== undefined ? Number(limitFlag) : 50
    if (!Number.isFinite(limit) || limit <= 0) {
      deps.err('--limit must be a positive integer')
      return { code: 1 }
    }

    const result = await runSkillForgeScan({ limit })

    if (result.filed === 0 && result.skipped === 0) {
      deps.out(
        'no skill-forge proposals created — run `mars arc reflect <id>` to generate arc data (need 3+ distinct arcs sharing a lesson)',
      )
    } else {
      deps.out(`\nDone: ${result.filed} created, ${result.skipped} skipped`)
    }
    return { code: 0 }
  },
}

export const skillForgeCommands: readonly Command[] = [skillForgeGroup, skillForgeScan]
