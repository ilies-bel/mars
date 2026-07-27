import type { IntegrationEvidence } from '../lib/collect-integration-evidence'

export interface EvidenceEntry {
  memberId: string
  branch: string
  evidence: IntegrationEvidence
}

export type CompensationKind = 'arc' | 'task'

/**
 * Build a rich compensation-task prompt for a force-purged arc or single task.
 *
 * When integrated commits are present, the prompt includes:
 *   - Per-member sections with SHAs, subjects, and touched files.
 *   - A `Suggested rollback commands` block with `git revert -m 1 <sha>` entries
 *     in reverse chronological order (newest first, which is the safe revert order).
 *   - A `Verification` block.
 *
 * When no integrated commits are found, the SHA/revert blocks are omitted but
 * the prompt still names the purged entity so the operator has context.
 */
export const buildCompensationPrompt = (opts: {
  kind: CompensationKind
  originId: string
  originTitle: string
  integrationBranch: string
  entries: EvidenceEntry[]
}): string => {
  const { kind, originId, originTitle, integrationBranch, entries } = opts
  const label = kind === 'arc' ? 'arc' : 'task'
  const Label = kind === 'arc' ? 'Arc' : 'Task'

  const allCommits = entries.flatMap((e) => e.evidence.commits)
  const hasCommits = allCommits.length > 0

  const lines: string[] = []

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`Compensate for force-purged ${label} ${originId}.`)
  lines.push('')
  lines.push(
    `The ${label} below was force-purged while some of its work had already been integrated`,
    `into the integration branch (${integrationBranch}). Review and handle any orphaned code.`,
  )
  lines.push('')
  lines.push(`**Abandoned ${Label}:** ${originId}`)
  lines.push(`**Intent:** ${originTitle}`)
  lines.push('')

  // ── Per-member sections ──────────────────────────────────────────────────────
  lines.push('## Integrated members')
  lines.push('')

  for (const entry of entries) {
    lines.push(`### ${entry.memberId} (branch: ${entry.branch})`)
    lines.push('')

    const { commits, touchedFiles } = entry.evidence

    if (commits.length === 0) {
      lines.push(
        'No specific commits identified (branch may have been merged earlier or',
        'SHA tracking is unavailable). Run `git log ' +
          integrationBranch +
          ' --oneline` to',
        'locate commits from this member manually.',
      )
    } else {
      lines.push(`Commits that landed on \`${integrationBranch}\`:`)
      for (const c of commits) {
        lines.push(`- \`${c.shortSha}\` ${c.subject}`)
        if (c.files.length > 0) {
          lines.push(`  Files: ${c.files.join(', ')}`)
        }
      }
      lines.push('')
      lines.push(`Touched files (union): ${touchedFiles.join(', ')}`)
    }
    lines.push('')
  }

  // ── Rollback commands ────────────────────────────────────────────────────────
  lines.push('## Suggested rollback commands')
  lines.push('')

  if (hasCommits) {
    lines.push(
      '# Revert in reverse chronological order (newest first) so each revert',
      '# applies cleanly on top of the previous one.',
    )
    // allCommits is already newest-first (git log order from collectIntegrationEvidence).
    for (const c of allCommits) {
      lines.push(`git revert -m 1 ${c.sha}`)
    }
  } else {
    lines.push(
      '# No commits were automatically identified. To revert manually:',
      `# 1. git log ${integrationBranch} --oneline   (find commits from this ${label})`,
      '# 2. git revert -m 1 <sha>                  (revert each one, newest first)',
    )
  }
  lines.push('')

  // ── Verification block ───────────────────────────────────────────────────────
  lines.push('## Verification')
  lines.push('')

  if (hasCommits) {
    const oldest = allCommits[allCommits.length - 1]
    const newest = allCommits[0]
    if (oldest.sha === newest.sha) {
      lines.push(`git log ${integrationBranch} --oneline ${oldest.sha}^..${newest.sha}`)
    } else {
      lines.push(`git log ${integrationBranch} --oneline ${oldest.sha}^..${newest.sha}`)
    }
  } else {
    lines.push(`git log ${integrationBranch} --oneline`)
  }
  lines.push('git status')
  lines.push('# Run your project test suite to confirm the branch is in a known state.')
  lines.push('')
  lines.push(
    '**Expected outcome:**',
    '- The integration branch is in a known, consistent state.',
    '- Either the orphaned changes are explicitly reverted, OR a written decision',
    '  exists to keep them (comment, ADR, or task note).',
    '- No dead code or broken imports remain from the abandoned ' + label + '.',
  )

  return lines.join('\n')
}
