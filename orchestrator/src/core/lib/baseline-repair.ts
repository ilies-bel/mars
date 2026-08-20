/**
 * Baseline repair — the ONE privileged actor allowed to commit to the
 * integration branch.
 *
 * ## Why this exists
 *
 * `tools/coder/setup-worktree.ts` already calls `repairInstallInPlace(...)` on a
 * `WorktreeInstallError`. Two things make it useless when the defect is
 * inherited from the integration branch:
 *
 *   1. It reconciles the *lockfile*, not the *manifest*. An `ETARGET / No
 *      matching version found` for a version that was never published is a
 *      manifest defect; no amount of lockfile regeneration fixes it.
 *   2. The branch-safety guard in `setup-worktree.ts` correctly refuses the
 *      only useful fix — it throws `branch-guard: lockfile repair would commit
 *      to '<head>' but expected '<branch>'` whenever the repair commit would
 *      land anywhere other than the task's own branch. That guard is right and
 *      stays exactly as strict. But it means a defect inherited from the
 *      integration branch can never be fixed by the task that trips over it:
 *      the repair is re-attempted in every worktree, N times, and thrown away
 *      N times.
 *
 * The gap is structural, not a bug: there was no actor allowed to fix the
 * integration branch. This module is that actor, and the constraints below are
 * the feature — not the repair itself.
 *
 * ## Shape
 *
 * `probe → resolve-or-repair-agent → verify → commit`. No worktree is carved
 * and no branch is created: the repair runs in the integration-branch
 * checkout itself, which is precisely the privilege ordinary tasks do not
 * have.
 *
 * The `ETARGET / No matching version found` case named above is NOT handed
 * to the repair-agent: `parseUnsatisfiablePin` (in `baseline-version-resolver.ts`)
 * recognizes it from the probe output and `resolveManifestVersion` computes
 * the replacement version deterministically — preferring a sibling manifest's
 * already-published pin, falling back to the nearest published version, and
 * escalating rather than ever guessing. The repair-agent path below still
 * handles every other manifest/lockfile defect class.
 *
 * ## The constraints (bounded in code, not in the prompt)
 *
 *   - **File allowlist** — dependency manifests and lockfiles only
 *     ({@link BASELINE_REPAIR_ALLOWLIST}). A repair that touched anything else
 *     is reverted and escalated, never committed. `.env` and `.mars/` are not
 *     on the list, so they are structurally unreachable.
 *   - **Diff-size cap** — beyond {@link defaultMaxDiffLines} changed lines the
 *     repair is reverted and escalated to a human.
 *   - **Verify before commit** — the commit happens only after a clean frozen
 *     install actually passes at that tree. The agent's say-so is never
 *     sufficient.
 *   - **One attempt, then a human** — mirroring ADR-0040's leaf-node rule, a
 *     baseline repair is itself non-recoverable. A second attempt against the
 *     same install signature is refused; dispatch stays paused and exactly one
 *     actionable action-queue item names the repo, the signature and the
 *     failing manifest.
 *   - **Never `git push`** — this module shells out to git for status, diff,
 *     checkout, clean, add, commit and rev-parse. Nothing else.
 *
 * Everything here is dependency-injected so the whole actor is exercised
 * without a repo, a daemon or a database — see `__tests__/baseline-repair.test.ts`.
 */

import { basename } from 'node:path'

import { classifyError } from './failure-signature'
import {
  findDependencyRange,
  parseUnsatisfiablePin,
  replaceDependencyRange,
  resolveManifestVersion,
} from './baseline-version-resolver'

// ---------------------------------------------------------------------------
// The allowlist and the cap — the two hard bounds on the privilege
// ---------------------------------------------------------------------------

/**
 * Every file a baseline repair is allowed to touch, matched on BASENAME so a
 * manifest in a workspace package (`packages/workflow/package.json`) is covered
 * without enumerating paths. Dependency manifests and lockfiles only, across
 * the package managers `worktree-install.ts` already supports (npm, pnpm,
 * yarn, bun).
 *
 * A repair that touches anything outside this list is reverted, not merged.
 * The allowlist IS the feature: widening it is widening the privilege.
 */
export const BASELINE_REPAIR_ALLOWLIST: ReadonlySet<string> = new Set([
  // npm
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  // pnpm
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  // yarn
  'yarn.lock',
  // bun
  'bun.lock',
  'bun.lockb',
])

/**
 * Default ceiling on total changed lines (added + removed across every touched
 * file). A manifest pin correction is a handful of lines; a regenerated
 * lockfile is hundreds. Anything past this is not the class of repair this
 * actor is scoped to, so it escalates instead of committing.
 *
 * Overridable with `MARS_BASELINE_REPAIR_MAX_DIFF_LINES` for a repo whose
 * lockfiles are genuinely larger.
 */
export const defaultMaxDiffLines = (): number => {
  const raw = Number(process.env.MARS_BASELINE_REPAIR_MAX_DIFF_LINES)
  return Number.isInteger(raw) && raw > 0 ? raw : 5_000
}

// ---------------------------------------------------------------------------
// Outcome vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a repair was refused. Every one of these leaves the integration branch
 * byte-identical to how the repair found it, leaves dispatch paused, and
 * raises exactly one action-queue item.
 */
export type BaselineRepairRefusal =
  /** The repair touched a file outside {@link BASELINE_REPAIR_ALLOWLIST}. */
  | 'disallowed-file'
  /** The repair changed more lines than the cap allows. */
  | 'diff-too-large'
  /** The agent exited without changing anything. */
  | 'empty-diff'
  /** A clean frozen install still fails at the repaired tree. */
  | 'install-still-failing'
  /** The agent process itself failed. */
  | 'agent-failed'
  /** The checkout was not on the integration branch, or was already dirty. */
  | 'unsafe-checkout'
  /** A repair was already attempted for this install signature (ADR-0040 leaf rule). */
  | 'attempt-exhausted'
  /** `git add`/`git commit` failed after everything else passed. */
  | 'commit-failed'
  /**
   * A version-pin defect was detected (see {@link parseUnsatisfiablePin}) but
   * no tracked manifest pins the exact offending range, so there is nothing
   * to deterministically locate and rewrite.
   */
  | 'unlocatable-manifest-pin'
  /**
   * A version-pin defect was detected but {@link resolveManifestVersion}
   * could not resolve it: no sibling manifest pins a published version, and
   * no published version is close enough to the requested one to resolve to
   * automatically. Never guessed — see the module doc.
   */
  | 'unresolvable-version'
  /** The deterministically-resolved version could not be written to disk. */
  | 'apply-failed'

export type BaselineRepairOutcome =
  /** The install probe passes — there is nothing to repair. */
  | { status: 'clean' }
  /** A verified repair was committed to the integration branch. */
  | { status: 'repaired'; commit: string; files: readonly string[] }
  /** The repair was refused; dispatch stays paused and a human owns it now. */
  | { status: 'escalated'; refusal: BaselineRepairRefusal; detail: string; actionQueueItemId: string }

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface BaselineRepairDeps {
  /** The integration-branch checkout the repair runs in. Never a worktree. */
  repoRoot: string
  /** The branch the repair is allowed to commit to (`main` unless overridden). */
  integrationBranch: string
  /**
   * A frozen dependency install at {@link repoRoot}. Non-zero exit means the
   * baseline is broken. Called twice: once to probe, once to verify.
   */
  probeInstall: () => Promise<ExecResult>
  /**
   * Run the Fixer IN PLACE at {@link repoRoot} — no worktree, no branch. This
   * is the privilege; it is granted here and nowhere else.
   */
  runAgentInPlace: (prompt: string) => Promise<{ exitCode: number }>
  /** Shell out to git inside {@link repoRoot}. Never given `push`. */
  git: (argv: readonly string[]) => Promise<ExecResult>
  /**
   * Read a file at a {@link repoRoot}-relative path from the working tree.
   * Used only by the deterministic version-pin resolution path — the
   * free-form repair-agent path edits the working tree itself and never
   * goes through this.
   */
  readFile: (relPath: string) => Promise<string>
  /** Write a file at a {@link repoRoot}-relative path in the working tree. */
  writeFile: (relPath: string, content: string) => Promise<void>
  /**
   * Every version published for `packageName` (e.g. the output of
   * `npm view <pkg> versions --json`). An empty array means "no data", not
   * "nothing is published" — {@link resolveManifestVersion} treats it as
   * unresolved rather than guessing.
   */
  listPublishedVersions: (packageName: string) => Promise<readonly string[]>
  /** Raise exactly one action-queue item. Returns its id. */
  raise: (item: {
    signature: string
    title: string
    body: string
    payload: Record<string, unknown>
  }) => Promise<string>
  /**
   * Clear the `baseline` dispatch pause. Called ONLY after a verified commit —
   * every refusal path leaves the pause exactly as it found it.
   */
  clearBaselinePause: () => void
  log?: (msg: string) => void
  /** Overrides {@link defaultMaxDiffLines}; injected by tests. */
  maxDiffLines?: number
}

export interface BaselineRepairer {
  repair(): Promise<BaselineRepairOutcome>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** One path reported by `git status --porcelain=v1`, plus whether it is tracked. */
interface DirtyPath {
  path: string
  untracked: boolean
}

/**
 * Parse `git status --porcelain=v1 --untracked-files=all`. Rename entries
 * (`R  old -> new`) report the destination, which is the path that would be
 * committed.
 */
export const parseDirtyPaths = (raw: string): DirtyPath[] => {
  const out: DirtyPath[] = []
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const after = line.slice(3)
    const arrowIdx = after.indexOf(' -> ')
    const path = (arrowIdx === -1 ? after : after.slice(arrowIdx + 4)).replace(/^"|"$/g, '')
    out.push({ path, untracked: code === '??' })
  }
  return out
}

/**
 * Sum the changed lines reported by `git diff --numstat`. Binary files report
 * `-` for both counts; they contribute 0 lines but are still allowlist-checked
 * (a `bun.lockb` is legitimately binary).
 */
export const sumNumstatLines = (raw: string): number => {
  let total = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const [added, removed] = line.split('\t')
    total += Number.parseInt(added ?? '', 10) || 0
    total += Number.parseInt(removed ?? '', 10) || 0
  }
  return total
}

/**
 * The paths a repair touched that it was NOT allowed to touch. Empty means the
 * whole change is inside {@link BASELINE_REPAIR_ALLOWLIST}.
 */
export const disallowedPaths = (paths: readonly string[]): string[] =>
  paths.filter((p) => !BASELINE_REPAIR_ALLOWLIST.has(basename(p)))

/**
 * The stable identity of an install failure. Two probes that fail the same way
 * carry the same signature, which is what the one-attempt rule keys on and
 * what the escalation names so an operator can match it against the
 * `setup:install/*` failures that were piling up before the pause.
 */
export const installSignature = (probe: ExecResult): string =>
  `setup:install/${classifyError(`${probe.stderr}\n${probe.stdout}`)}`

const repairPrompt = (args: {
  repoRoot: string
  integrationBranch: string
  signature: string
  probeOutput: string
}): string =>
  [
    '# Repair the integration branch dependency install',
    '',
    `You are running IN PLACE in the integration-branch checkout at ${args.repoRoot},`,
    `on branch \`${args.integrationBranch}\`. There is no worktree. Dispatch for the`,
    'whole queue is paused until this install works again, so every other task is',
    'blocked behind you.',
    '',
    '## The failure',
    '',
    `Signature: \`${args.signature}\``,
    '',
    '```',
    args.probeOutput.slice(0, 4_000),
    '```',
    '',
    '## What you may change',
    '',
    'Dependency manifests and lockfiles ONLY:',
    '',
    ...[...BASELINE_REPAIR_ALLOWLIST].sort().map((f) => `  - ${f}`),
    '',
    'A change to any other file is detected and reverted wholesale, and the repair',
    'is escalated to a human — so touching source, config, tests or documentation',
    'does not just fail to help, it throws away the manifest fix you made too.',
    '',
    '## What to do',
    '',
    '(An unsatisfiable version pin — "No matching version found for X@Y" — is',
    'already resolved deterministically before you run; you are only seeing',
    'this prompt because the failure is a different defect class.)',
    '',
    'Identify the class of defect and apply the smallest change that fixes it:',
    'a manifest and lockfile that disagree, a dependency that moved, a lockfile',
    'entry that no longer matches its manifest. Prefer correcting the manifest',
    'over regenerating the lockfile when the manifest is what is wrong.',
    '',
    '## What NOT to do',
    '',
    '- Do NOT run `git commit`, `git push`, `git checkout`, `git reset` or `git stash`.',
    '  The orchestrator verifies your change with a clean frozen install and commits',
    '  it itself. A commit from you is not what makes this land.',
    '- Do NOT touch `.env` or `.mars/`.',
    '- Do NOT broaden the fix into unrelated dependency upgrades.',
    '',
    'Leave your change uncommitted in the working tree and stop.',
  ].join('\n')

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

/**
 * Build the repairer. The returned object holds the one-attempt ledger: a
 * signature that has already had a repair attempted against it is refused
 * outright on every later call, so a repair can never loop the way a retry
 * budget would allow.
 */
export const createBaselineRepairer = (deps: BaselineRepairDeps): BaselineRepairer => {
  const log = deps.log ?? ((): void => {})
  const cap = deps.maxDiffLines ?? defaultMaxDiffLines()
  const attempted = new Set<string>()

  const escalate = async (
    refusal: BaselineRepairRefusal,
    detail: string,
    extra: Record<string, unknown> = {},
  ): Promise<BaselineRepairOutcome> => {
    log(`[baseline-repair] refused (${refusal}): ${detail}`)
    const actionQueueItemId = await deps.raise({
      // Signature is keyed on the refusal alone, NOT on the detail text, so a
      // daemon that re-checks the baseline every merge bumps one row's
      // seen_count instead of accumulating N near-identical rows.
      signature: `baseline-repair/${refusal}`,
      title: `Baseline repair refused (${refusal}) — dispatch stays paused`,
      body: [
        `The integration branch at \`${deps.repoRoot}\` (branch \`${deps.integrationBranch}\`)`,
        'fails a clean dependency install, and the automatic baseline repair did not',
        'produce a change that could be safely committed.',
        '',
        `Refusal: **${refusal}**`,
        '',
        detail,
        '',
        'Dispatch remains paused with reason `baseline`. The repair is a leaf node',
        '(ADR-0040): it will not retry on its own. Fix the manifest by hand, then',
        'run `mars operator set dispatch on`.',
      ].join('\n'),
      payload: { refusal, repoRoot: deps.repoRoot, integrationBranch: deps.integrationBranch, ...extra },
    })
    return { status: 'escalated', refusal, detail, actionQueueItemId }
  }

  /**
   * Put the checkout back exactly as the repair found it. Tracked paths are
   * restored from HEAD; untracked paths are removed individually — never a
   * blanket `git clean -fd`, which would eat an operator's unrelated scratch
   * files in the integration checkout.
   */
  const revert = async (paths: readonly DirtyPath[]): Promise<void> => {
    const tracked = paths.filter((p) => !p.untracked).map((p) => p.path)
    const untracked = paths.filter((p) => p.untracked).map((p) => p.path)
    if (tracked.length > 0) await deps.git(['checkout', '--', ...tracked])
    if (untracked.length > 0) await deps.git(['clean', '-f', '--', ...untracked])
  }

  const repair = async (): Promise<BaselineRepairOutcome> => {
    // ── probe ───────────────────────────────────────────────────────────────
    const probe = await deps.probeInstall()
    if (probe.exitCode === 0) return { status: 'clean' }

    const signature = installSignature(probe)
    const probeOutput = `${probe.stdout}\n${probe.stderr}`.trim()

    if (attempted.has(signature)) {
      return escalate(
        'attempt-exhausted',
        `A baseline repair was already attempted for \`${signature}\` and did not fix it. ` +
          'Exactly one attempt is allowed per signature.',
        { installSignature: signature },
      )
    }

    // The checkout must be on the integration branch and clean before an agent
    // is allowed near it. This is the mirror image of the branch-safety guard
    // in setup-worktree.ts: that guard refuses to commit to anything BUT the
    // task branch, this one refuses to run unless HEAD is the integration
    // branch. Neither is relaxed by the other.
    const head = await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const headBranch = head.exitCode === 0 ? head.stdout.trim() : null
    if (headBranch !== deps.integrationBranch) {
      return escalate(
        'unsafe-checkout',
        `Refusing to repair: HEAD is '${headBranch ?? '(detached)'}' but the integration ` +
          `branch is '${deps.integrationBranch}'.`,
        { installSignature: signature, headBranch },
      )
    }

    const before = await deps.git(['status', '--porcelain=v1', '--untracked-files=all'])
    if (before.exitCode !== 0 || parseDirtyPaths(before.stdout).length > 0) {
      return escalate(
        'unsafe-checkout',
        'Refusing to repair: the integration checkout is already dirty. A repair here ' +
          "would commit somebody else's uncommitted work.",
        { installSignature: signature },
      )
    }

    // ── verify + commit — shared by both repair paths below ────────────────
    const verifyAndCommit = async (dirty: readonly DirtyPath[]): Promise<BaselineRepairOutcome> => {
      if (dirty.length === 0) {
        return escalate(
          'empty-diff',
          'The repair changed nothing. The install failure is unchanged.',
          { installSignature: signature, probeOutput: probeOutput.slice(0, 2_000) },
        )
      }

      const offending = disallowedPaths(dirty.map((d) => d.path))
      if (offending.length > 0) {
        await revert(dirty)
        return escalate(
          'disallowed-file',
          `The repair touched ${offending.length} file(s) outside the dependency-manifest ` +
            `allowlist: ${offending.join(', ')}. The whole change was reverted.`,
          { installSignature: signature, disallowedFiles: offending },
        )
      }

      const numstat = await deps.git(['diff', '--numstat', 'HEAD'])
      const changedLines = numstat.exitCode === 0 ? sumNumstatLines(numstat.stdout) : 0
      if (changedLines > cap) {
        await revert(dirty)
        return escalate(
          'diff-too-large',
          `The repair changed ${changedLines} lines, over the ${cap}-line cap for a ` +
            'baseline repair. A human should look at a change this size.',
          { installSignature: signature, changedLines, maxDiffLines: cap },
        )
      }

      // Verify before commit — neither the agent's say-so nor the resolver's
      // arithmetic is ever sufficient on its own.
      const reprobe = await deps.probeInstall()
      if (reprobe.exitCode !== 0) {
        await revert(dirty)
        return escalate(
          'install-still-failing',
          'A clean frozen install still fails after the repair. The change was reverted ' +
            `so the branch is byte-identical to how the repair found it.\n\n` +
            '```\n' +
            `${reprobe.stderr}\n${reprobe.stdout}`.trim().slice(0, 2_000) +
            '\n```',
          { installSignature: signature, postRepairSignature: installSignature(reprobe) },
        )
      }

      // ── commit ─────────────────────────────────────────────────────────
      const files = dirty.map((d) => d.path)
      const add = await deps.git(['add', '--', ...files])
      const commit =
        add.exitCode === 0
          ? await deps.git(['commit', '-m', 'fix(deps): repair integration-branch dependency install'])
          : add
      if (commit.exitCode !== 0) {
        await revert(dirty)
        return escalate(
          'commit-failed',
          `git ${add.exitCode === 0 ? 'commit' : 'add'} failed: ${commit.stderr.trim()}`,
          { installSignature: signature },
        )
      }

      const sha = await deps.git(['rev-parse', 'HEAD'])
      const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : ''
      log(`[baseline-repair] committed ${commitSha} to ${deps.integrationBranch}; resuming dispatch`)
      deps.clearBaselinePause()
      return { status: 'repaired', commit: commitSha, files }
    }

    // ── deterministic version-pin resolution ──────────────────────────────
    //
    // Checked BEFORE the free-form repair-agent: when the probe output names
    // an unsatisfiable manifest pin, the replacement version comes ONLY from
    // resolveManifestVersion's algorithm, never from an agent's guess. See
    // the module doc on baseline-version-resolver.ts.
    const pin = parseUnsatisfiablePin(probeOutput)
    if (pin !== null) {
      attempted.add(signature)
      log(
        `[baseline-repair] detected unsatisfiable version pin ${pin.packageName}@${pin.range}; ` +
          'resolving deterministically',
      )

      const tracked = await deps.git(['ls-files'])
      const manifestPaths =
        tracked.exitCode === 0
          ? tracked.stdout
              .split('\n')
              .map((p) => p.trim())
              .filter((p) => p.length > 0 && basename(p) === 'package.json')
          : []

      const owners: string[] = []
      const siblingRanges: string[] = []
      for (const path of manifestPaths) {
        let content: string
        try {
          content = await deps.readFile(path)
        } catch {
          continue
        }
        const range = findDependencyRange(content, pin.packageName)
        if (range === undefined) continue
        if (range === pin.range) owners.push(path)
        else siblingRanges.push(range)
      }

      if (owners.length === 0) {
        return escalate(
          'unlocatable-manifest-pin',
          `Detected an unsatisfiable pin \`${pin.packageName}@${pin.range}\` but no tracked ` +
            'package.json pins that exact range. Refusing to guess which manifest to edit.',
          { installSignature: signature, packageName: pin.packageName, range: pin.range },
        )
      }

      const publishedVersions = await deps.listPublishedVersions(pin.packageName)
      const resolution = resolveManifestVersion({
        requestedRange: pin.range,
        siblingRanges,
        publishedVersions,
      })

      if (resolution.status === 'unresolved') {
        return escalate(
          'unresolvable-version',
          `\`${pin.packageName}@${pin.range}\` has no satisfiable resolution: no sibling ` +
            'manifest pins a published version, and no published version is close enough to ' +
            'resolve to automatically. A human must choose the version.',
          { installSignature: signature, packageName: pin.packageName, range: pin.range },
        )
      }

      log(
        `[baseline-repair] resolved ${pin.packageName}@${pin.range} -> ${resolution.range} ` +
          `(${resolution.source})`,
      )

      try {
        for (const path of owners) {
          const content = await deps.readFile(path)
          await deps.writeFile(path, replaceDependencyRange(content, pin.packageName, pin.range, resolution.range))
        }
      } catch (err) {
        return escalate(
          'apply-failed',
          `Failed to write the resolved version to ${owners.join(', ')}: ${(err as Error).message}`,
          { installSignature: signature, packageName: pin.packageName },
        )
      }

      const after = await deps.git(['status', '--porcelain=v1', '--untracked-files=all'])
      const dirty = after.exitCode === 0 ? parseDirtyPaths(after.stdout) : []
      return verifyAndCommit(dirty)
    }

    // ── repair-agent ────────────────────────────────────────────────────────
    attempted.add(signature)
    log(`[baseline-repair] attempting repair for ${signature} at ${deps.repoRoot}`)
    const agent = await deps.runAgentInPlace(
      repairPrompt({
        repoRoot: deps.repoRoot,
        integrationBranch: deps.integrationBranch,
        signature,
        probeOutput,
      }),
    )

    const after = await deps.git(['status', '--porcelain=v1', '--untracked-files=all'])
    const dirty = after.exitCode === 0 ? parseDirtyPaths(after.stdout) : []

    if (agent.exitCode !== 0) {
      await revert(dirty)
      return escalate(
        'agent-failed',
        `The repair agent exited ${agent.exitCode}. Nothing was committed.`,
        { installSignature: signature, agentExitCode: agent.exitCode },
      )
    }

    return verifyAndCommit(dirty)
  }

  return { repair }
}
