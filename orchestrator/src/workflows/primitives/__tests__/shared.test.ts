import { describe, expect, it } from 'vitest'
import {
  DEVIATION_RULES,
} from '../shared'

// ---------------------------------------------------------------------------
// DEVIATION_RULES — pre-existing-failure baseline (Rule 6)
// ---------------------------------------------------------------------------

describe('DEVIATION_RULES — pre-existing-failure baseline', () => {
  it('baselines via `git checkout <ref> -- <file>`, never `git stash`', () => {
    // `refs/stash` is shared by every linked worktree in this repo, so a
    // `pop` can hand the agent another task's work (data-loss incident
    // 2026-07-28). The brief must offer the path-restore pattern instead —
    // and must only mention stash to ban it.
    expect(DEVIATION_RULES).toContain('git checkout $(git merge-base HEAD origin/main) --')
    expect(DEVIATION_RULES).not.toContain('git stash --include-untracked')
    expect(DEVIATION_RULES).not.toContain('git stash pop')
    expect(DEVIATION_RULES).toMatch(/`git stash` \(banned in this repo/)
  })

  it('references the merge base so the agent knows what to compare against', () => {
    // Accept either hyphenated or spaced form.
    const hasHyphenated = DEVIATION_RULES.includes('merge-base')
    const hasSpaced = DEVIATION_RULES.toLowerCase().includes('merge base')
    expect(hasHyphenated || hasSpaced).toBe(true)
  })

  it('requires the literal phrase "pre-existing UNVERIFIED" as the fallback', () => {
    expect(DEVIATION_RULES).toContain('pre-existing UNVERIFIED')
  })

  it('instructs the agent to run the failing test file against the baseline', () => {
    // The rule must reference running a test against the baseline, not just restoring files.
    const hasVitest = DEVIATION_RULES.includes('npx vitest run')
    const hasMergeBase = DEVIATION_RULES.includes('merge-base') || DEVIATION_RULES.toLowerCase().includes('merge base')
    expect(hasVitest).toBe(true)
    expect(hasMergeBase).toBe(true)
  })

  it('requires quoting BOTH the branch-tip and baseline result summaries', () => {
    // The rule must mention both sides so neither can be omitted.
    const hasBranchTip = DEVIATION_RULES.includes('branch-tip') || DEVIATION_RULES.includes('branch tip')
    const hasBaseline = DEVIATION_RULES.toLowerCase().includes('baseline')
    expect(hasBranchTip).toBe(true)
    expect(hasBaseline).toBe(true)
  })
})
