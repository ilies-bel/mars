/**
 * `skill-forge scan` CLI command.
 *
 * Reads completed arc deep-reflection reports, runs the cross-arc lesson
 * detector, synthesizes a draft SKILL.md per surviving lesson, and files one
 * draft proposal (source='skill-forge') per lesson.  Re-running is idempotent:
 * a lesson whose title already has a skill-forge proposal is skipped.
 */

import type { Command } from '../command'

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

    const { loadRecentDeepReflectRows } = await import('../../core/lib/deep-reflect-query')
    const { detectCrossArcLessons } = await import('../../core/lib/skill-forge-detector')
    const { synthesizeSkillMarkdown } = await import('../../core/lib/skill-forge-synthesizer')
    const { createProposal, listProposals, initProposals } = await import('../../core/proposals')

    await initProposals()

    const rows = await loadRecentDeepReflectRows({ limit })
    if (rows.length === 0) {
      deps.out('no deep-reflect rows found — run `mars arc reflect <id>` first')
      return { code: 0 }
    }

    const lessons = detectCrossArcLessons(rows)
    if (lessons.length === 0) {
      deps.out(
        `scanned ${rows.length} row(s) across arc reports — no cross-arc lessons detected (need 3+ distinct arcs per lesson)`,
      )
      return { code: 0 }
    }

    // Fetch existing skill-forge proposals for dedup (by title).
    const existing = await listProposals({ source: 'skill-forge' })
    const existingTitles = new Set(existing.map((p) => p.title))

    let created = 0
    let skipped = 0
    for (const lesson of lessons) {
      const { name, markdown } = synthesizeSkillMarkdown(lesson)
      const title = `Skill: ${name}`

      if (existingTitles.has(title)) {
        deps.out(`skip (already exists): ${title}`)
        skipped++
        continue
      }

      const ids = lesson.motivatingArcOriginIds.join(',')
      const notes = `motivating_arcs: ${ids}\n\n${markdown}`

      await createProposal(title, {
        source: 'skill-forge',
        solution: markdown,
        notes,
      })
      deps.out(`created proposal: ${title}`)
      created++
    }

    deps.out(`\nDone: ${created} created, ${skipped} skipped`)
    return { code: 0 }
  },
}

export const skillForgeCommands: readonly Command[] = [skillForgeGroup, skillForgeScan]
