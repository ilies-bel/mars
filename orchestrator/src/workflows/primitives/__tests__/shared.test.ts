import { describe, expect, it } from 'vitest'
import {
  DEVIATION_RULES,
} from '../shared'

// ---------------------------------------------------------------------------
// DEVIATION_RULES — pre-existing-failure baseline (Rule 6)
// ---------------------------------------------------------------------------

describe('DEVIATION_RULES — pre-existing-failure baseline', () => {
  it('baselines via `git checkout <merge-base>` and never tells the agent to stash', () => {
    // `refs/stash` is shared by every linked worktree in this repo and is
    // addressed by position, so instructing coders to stash/pop is exactly how
    // one task's uncommitted work ends up in another task's tree (data-loss
    // incident 2026-07-28). The brief must offer the checkout-based baseline.
    expect(DEVIATION_RULES).toContain('git checkout $(git merge-base HEAD origin/main)')
    expect(DEVIATION_RULES).not.toMatch(/git stash (push|pop|--include-untracked)/)
    expect(DEVIATION_RULES).toContain('Never use `git stash`')
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

  it('offers a diff-membership shortcut before the destructive checkout dance', () => {
    // If the failing file was never touched by the branch, it is pre-existing
    // by construction — the agent should be told to check this FIRST and skip
    // the commit/checkout/restore dance entirely when it holds, rather than
    // reaching straight for `git checkout <merge-base> -- <file>` (which is
    // destructive to uncommitted work in that path, see the stash test above).
    expect(DEVIATION_RULES).toContain('git diff --name-only $(git merge-base HEAD origin/main) HEAD')
    expect(DEVIATION_RULES).toContain('pre-existing by construction')
  })
})

// ---------------------------------------------------------------------------
// DEVIATION_RULES — incremental commits + low-context handoff (Rules 7 & 8)
// ---------------------------------------------------------------------------

describe('DEVIATION_RULES — incremental commits + low-context handoff', () => {
  it('requires committing incrementally in small units, starting early', () => {
    // Coders that accumulate a large uncommitted working set lose it all when
    // the process is killed on context exhaustion (exit 138) — this brief
    // must tell them to commit one coherent unit at a time and commit early.
    expect(DEVIATION_RULES).toContain('Commit incrementally')
    expect(DEVIATION_RULES.toLowerCase()).toContain('commit early')
    expect(DEVIATION_RULES.toLowerCase()).toContain('uncommitted')
  })

  it('instructs the agent to stop at a clean commit and hand off the remainder when budget runs low', () => {
    // Rather than pushing until killed mid-edit, a coder that sees remaining
    // scope exceed remaining budget should stop cleanly and enqueue the rest.
    expect(DEVIATION_RULES).toContain('mars task add --blocked-by $TASK_ID')
    expect(DEVIATION_RULES.toLowerCase()).toContain('remaining scope')
    expect(DEVIATION_RULES.toLowerCase()).toContain('remaining context budget')
  })
})
