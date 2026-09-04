/**
 * Shared CLI argument parsing — pure, side-effect-free helpers (ADR-0023 §5).
 *
 * `parseArgs` turns raw argv into a {@link ParsedArgs} (the same shape the old
 * inline parser produced). Per-flag helpers (`parsePriority`, `parseMergeMode`,
 * `parseTaskSpec`, …) validate a single flag and return either a typed value
 * or a structured error, so every Command validates flags identically and the
 * registry-iterating "every leaf rejects unknown flags" test has a single
 * source of truth for the allowed flag surface.
 *
 * Nothing here touches `console` or `process.exit`; callers turn a returned
 * error into a `deps.err(...)` + `CommandResult{code}`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ParsedArgs {
  repo?: string
  flags: Record<string, string>
  multiFlags: Record<string, string[]>
  positional: string[]
  /**
   * Tokens that appeared after a bare `--` separator. These are never parsed
   * as flags — they are the raw argv for a sub-process or gate command.
   *
   * Example: `mars verify add typecheck --cmd npx -- tsc --noEmit`
   * → `rest = ['tsc', '--noEmit']`
   */
  rest: string[]
}

/** Value-bearing flags: `--flag value` or `--flag=value`. */
export const FLAGS_WITH_VALUES: ReadonlySet<string> = new Set([
  '--repo',
  '--functional',
  '--func',
  '--technical',
  '--tech',
  '--functional-file',
  '--technical-file',
  '--since',
  '--limit',
  '--out',
  '--author',
  '--by',
  '--note',
  '--root-cause',
  '--avoid',
  '--blocked-by',
  '--source',
  '--payload',
  '--status',
  '--from',
  '--kind',
  '--port',
  '--host',
  '--vite-port',
  '--priority',
  '--tag',
  '--files',
  '--verify',
  '--done',
  '--merge',
  '--wrapper',
  '--session',
  '--model',
  '--effort',
  '--permission-mode',
  '--max-messages',
  '--name',
  '--path',
  '--intent',
  '--prompt-file',
  // Pipeline selection axis: which user-owned workflow file runs the task
  // (.mars/workflows/<name>-workflow.js). `--live` is its boolean sugar.
  '--workflow',
  // mars workflow validate --file <path>: validate an arbitrary file instead of
  // the kind-derived .mars/workflows/<name>-workflow.js path.
  '--file',
  // Spend-meter thresholds (lib/spend-meter.ts).
  '--window',
  '--window-tokens',
  '--arc-tokens',
  // mars init provider selection — choose the default agent CLI for all Worker
  // runs: codex (default), claude, or gemini. Persisted to .mars/daemon.json
  // as `defaultProvider` and applied on the next daemon start.
  '--provider',
  '--verify-gates-json',
  '--feedback',
  // mars memory — domain-scoped memory packet management
  '--domain',
  '--text',
  '--salience',
  '--min-salience',
  // mars chat-feedback list — filter by rating ('up' or 'down')
  '--rating',
  '--origin-arc',
  '--origin',
  // mars verify-gate / mars verify — verify gate registry management
  '--scope',
  '--cmd',
  '--tier',
  '--manifest',
  // mars verify add — repeated gate args (--args tsc --args --noEmit)
  '--args',
  '--surface-form',
  // mars kpi compare — window boundaries (ISO timestamp or task id)
  '--before',
  '--after',
  // mars credentials set — human-readable description of the credential
  '--description',
  // mars task add --supersede <task-id>: declare this task as a manual
  // operator-authored continuation of a failed arc whose recovery exhausted
  // automatic options (slice 2 of PRD 94e2a82a-recovery-operator).
  '--supersede',
  // mars task add --qa <auto|manual>: select the review mode for the task's
  // review step. 'auto' (default) runs typecheck/tests/lint; 'manual' parks
  // the task for a human to exercise the running app before merge.
  '--qa',
  // mars daemon spend-control set — operator spend-control levers.
  '--coder-ceiling',
  '--pause-at',
  '--resume-at',
  '--suppress-recovery',
  '--ramp-back-step',
  '--surface-form',
  // mars action-queue resolve --reason <text>: human-readable note for the resolution.
  '--reason',
  // mars verify-gate add / mars verify add --evidence <text>: DEC-11 traceability.
  // Required for human/operator gates to record the observation that justified
  // adding this gate.
  '--evidence',
  // mars verify-gate add/set --timeout <minutes>: per-gate wall-clock timeout.
  '--timeout',
  // mars eval --fixture <name>: run a single named fixture instead of the
  // whole suite under src/eval/fixtures/.
  '--fixture',
  // mars proposal add --title "<text>": explicit proposal title, stored
  // verbatim instead of derived from the goal's first line / heading.
  '--title',
  // mars block <task> <new-blocker> --replace <old-blocker>: atomically swap
  // a blocker edge without the task passing through `queued`.
  '--replace',
  // mars classifier add -- pattern matching flags and optional guidance.
  '--match',
  '--match-full',
  '--guidance',
])

/**
 * Boolean flags accepted by one or more leaves. Combined with
 * {@link FLAGS_WITH_VALUES} this is the full set of flags any leaf may legally
 * see; the registry-iterating test rejects anything outside the union.
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--force',
  '--abort',
  '--dry-run',
  '--verbose',
  '--dev',
  '--foreground',
  '--detach',
  '--stop',
  '--json',
  '--lean',
  '--with-transcript-only',
  '--force-orphans',
  '--yes',
  '-y',
  '--no-edit',
  // mars update non-interactive accept-all mode (mutually exclusive with --yes).
  '--accept-all',
  // mars init single-entry wizard routing (ADR-0058). `--wizard` forces the
  // wizard even on a non-TTY; `--wizard-off` skips it on a TTY. Boolean
  // WizardPrompts (e.g. project registration) also live here.
  '--wizard',
  '--wizard-off',
  '--register-project',
  // `mars init --start`: print daemon URL non-interactively (useful with --yes).
  '--start',
  '--skip-doctor',
  // `mars task add --live`: sugar for `--workflow live`. DISABLED — the live
  // pipeline is withheld while HITL is being refined; the flag still parses so
  // it can be rejected with a clear error rather than falling through to
  // "unknown flag" or being joined into the literal prompt text.
  '--live',
  '--deferrable',
  '--coordinated',
  '--help',
  '-h',
  '--version',
  '-v',
  // mars verify-gate add — gate required/optional toggle
  '--required',
  '--optional',
  // mars list --all: bypass the default 10-row limit and return every matching task.
  '--all',
  // mars task check --uncheck: clear a done-criterion instead of setting it.
  '--uncheck',
  // mars worktree reclaim --no-dry-run: rejected today (deletion mode is not
  // implemented), but declared so the leaf reads it off `args.flags` like every
  // other boolean rather than fishing it out of the positionals.
  '--no-dry-run',
  // mars release-notes list — cursor-based feed filtering
  '--unseen',
  '--mark-viewed',
  // mars proposal slice — bypass the open-questions gate knowingly
  '--accept-defaults',
  // mars task add --implement: override the research-prompt guard and land the
  // task on the default implement pipeline even when the prompt matches a
  // research marker and no --verify/--done spec is present.
  '--implement',
  // mars eval --baseline: record the current scores as the baseline instead
  // of diffing against the last recorded one.
  '--baseline',
  // mars kpi acknowledge --list: show all acknowledged baselines.
  '--list',
  // mars kpi acknowledge --clear: remove an acknowledged baseline.
  '--clear',
  // mars kpi snapshot --exclude-planner-slicer: omit Planner/Slicer (Path 3)
  // origin-level trace events from the cost_per_arc distribution.
  '--exclude-planner-slicer',
  // mars unblock <id> <blocker-id> --keep-blocked: remove specific blocker
  // edges without re-evaluating whether the task should flip to `queued`.
  // Use before immediately re-adding a replacement blocker to avoid the race
  // where the task is dispatched between the unblock and the new block.
  '--keep-blocked',
])

// Short aliases are normalised to their long form before flag lookup.
const SHORT_FLAG_ALIASES: Readonly<Record<string, string>> = {
  '-y': '--yes',
}

const REPEATABLE_FLAGS: ReadonlySet<string> = new Set([
  '--blocked-by',
  '--files',
  '--done',
  '--tag',
  '--args',
  '--surface-form',
])

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const multiFlags: Record<string, string[]> = {}
  const rest: string[] = []
  let repo: string | undefined
  let seenDoubleDash = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue

    // Everything after a bare `--` goes into `rest` unmodified.
    if (seenDoubleDash) {
      rest.push(a)
      continue
    }
    if (a === '--') {
      seenDoubleDash = true
      continue
    }

    const eq = a.indexOf('=')
    const rawKey = eq === -1 ? a : a.slice(0, eq)
    const key = SHORT_FLAG_ALIASES[rawKey] ?? rawKey
    const inlineValue = eq === -1 ? undefined : a.slice(eq + 1)

    if (key === '--repo') {
      repo = inlineValue ?? argv[++i]
      continue
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = inlineValue ?? 'true'
      continue
    }
    if (FLAGS_WITH_VALUES.has(key)) {
      const value = inlineValue ?? argv[++i]
      if (value === undefined) throw new Error(`flag ${key} requires a value`)
      if (REPEATABLE_FLAGS.has(key)) {
        const list = multiFlags[key] ?? []
        list.push(value)
        // Greedy: when the first value was NOT inlined (i.e. space-separated
        // `--files a b c`), keep consuming tokens that are not flags.
        // Stop at the first token starting with `-` (covers `--flag` and
        // the lone `-` stdin sentinel). The inline `--flag=val` form binds
        // exactly one value, so greedy only applies to the space form.
        if (inlineValue === undefined) {
          while (i + 1 < argv.length) {
            const next = argv[i + 1]
            if (next === undefined || next.startsWith('-')) break
            list.push(next)
            i++
          }
        }
        multiFlags[key] = list
      } else {
        flags[key] = value
      }
      continue
    }
    positional.push(a)
  }
  return { repo, flags, multiFlags, positional, rest }
}

/** True when a boolean flag was supplied. Flag keys retain their `--` prefix. */
export const hasFlag = (args: ParsedArgs, flag: string): boolean => args.flags[flag] !== undefined

/**
 * Resolve a `@path` reference to its file contents, else return the literal.
 * Used by plan/body args that accept inline text or `@file`.
 */
export const readMaybeFile = (raw: string): string => {
  if (raw.startsWith('@')) {
    return readFileSync(raw.slice(1), 'utf8')
  }
  return raw
}

/**
 * Resolve plan text from inline keys (e.g. `--functional`/`--func`) or a
 * file-key fallback (`--functional-file`). Inline values honour `@path`.
 */
export const resolvePlanText = (
  flags: Record<string, string>,
  inlineKeys: readonly string[],
  fileKey: string,
): string | undefined => {
  for (const key of inlineKeys) {
    const v = flags[key]
    if (v !== undefined) return readMaybeFile(v)
  }
  const filePath = flags[fileKey]
  if (filePath !== undefined) return readFileSync(filePath, 'utf8')
  return undefined
}

/**
 * Resolve the prompt body from exactly one of four input channels:
 *
 *   - positional `@<file>`    — reads file verbatim, trims one trailing newline
 *   - `--prompt-file <path>`  — same, explicit-flag form
 *   - positional `-`          — reads stdin (via `readStdin`), trims one trailing newline
 *   - positional literal      — returned as-is (the existing inline path)
 *
 * Supplying more than one channel is a hard error. Returns
 * `{ ok: true, value: '' }` when no channel is provided so the caller can
 * emit the "prompt required" usage message. Returns `{ ok: false, message }`
 * on any hard error (missing file, multiple sources).
 *
 * `readStdin` is injectable so tests can supply a pure function instead of
 * reading fd 0 (`readFileSync(0, 'utf8')`).
 *
 * Any leftover `positional` token starting with `--` is, by construction, a
 * flag `parseArgs` did not recognise (every declared flag is already pulled
 * into `flags`/`multiFlags` before `positional` is built). Folding it into
 * the joined literal would silently discard the caller's intent — e.g.
 * `mars proposal add @file.md --bogus x` would store the literal string
 * `"@file.md --bogus x"` as the goal instead of expanding the file and
 * rejecting the unknown flag. Reject it as a hard error instead.
 *
 * For the same reason a leading `@<path>` / `-` token followed by further
 * positionals is rejected rather than folded: the operator wrote the
 * documented file/stdin form and expects expansion, so quietly demoting it
 * to a joined literal discards the prepared body with exit code 0. Only the
 * *leading* token is checked — an `@mention` in the middle of inline prose is
 * ordinary text, not a file reference.
 */
export const resolvePromptSource = (
  positional: readonly string[],
  flags: Record<string, string>,
  readStdin: () => string = () => readFileSync(0, 'utf8'),
): FlagResult<string> => {
  const unknownFlag = positional.find((p) => p.startsWith('--'))
  if (unknownFlag !== undefined) {
    return { ok: false, message: `[mars] error: unknown flag: ${unknownFlag}` }
  }

  const lead = positional[0]
  if (positional.length > 1 && lead !== undefined && (lead.startsWith('@') || lead === '-')) {
    return {
      ok: false,
      message: `[mars] error: '${lead}' reads the body from ${lead === '-' ? 'stdin' : 'a file'}, so it must be the only positional argument (got ${positional.length}); quote the whole value if you meant it as inline text`,
    }
  }

  const promptFile = flags['--prompt-file']
  const singlePos = positional.length === 1 ? positional[0] : undefined
  const isFileRef = singlePos !== undefined && singlePos.startsWith('@')
  const isStdin = singlePos === '-'
  const isLiteral = positional.length > 0 && !isFileRef && !isStdin

  const sourceCount =
    (promptFile !== undefined ? 1 : 0) +
    (isFileRef ? 1 : 0) +
    (isStdin ? 1 : 0) +
    (isLiteral ? 1 : 0)

  if (sourceCount > 1) {
    return {
      ok: false,
      message:
        '[mars] error: multiple prompt sources supplied; use exactly one of: "<prompt>", @<file>, --prompt-file <path>, or - (stdin)',
    }
  }

  if (promptFile !== undefined) {
    try {
      const content = readFileSync(promptFile, 'utf8')
      return { ok: true, value: content.endsWith('\n') ? content.slice(0, -1) : content }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: `[mars] error: cannot read --prompt-file '${promptFile}': ${msg}` }
    }
  }

  if (isFileRef) {
    const filePath = singlePos!.slice(1)
    try {
      const content = readFileSync(filePath, 'utf8')
      return { ok: true, value: content.endsWith('\n') ? content.slice(0, -1) : content }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: `[mars] error: cannot read prompt file '${filePath}': ${msg}` }
    }
  }

  if (isStdin) {
    try {
      const content = readStdin()
      return { ok: true, value: content.endsWith('\n') ? content.slice(0, -1) : content }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: `[mars] error: cannot read stdin: ${msg}` }
    }
  }

  // Literal or empty
  const joined = positional.join(' ')
  if (joined.includes('\n')) {
    return {
      ok: false,
      message:
        '[mars] error: inline prompt contains a newline; multi-line prompts must be passed via @<file>, --prompt-file <path>, or - (stdin) — not an inline "<prompt>" argument',
    }
  }
  return { ok: true, value: joined }
}

// ── Per-flag validators ─────────────────────────────────────────────────────
//
// Each returns a discriminated result: `{ ok: true, value }` or
// `{ ok: false, message }`. The caller emits the message via `deps.err` and
// returns a `CommandResult{code}` — no helper ever exits or prints.

export type FlagResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

/** `--priority` / positional priority: integer in 0..3. */
export const parsePriority = (raw: string): FlagResult<number> => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    return { ok: false, message: `priority must be an integer in 0..3; got '${raw}'` }
  }
  return { ok: true, value: n }
}

/** `--merge`: one of auto|gated (the only valid merge modes). */
const parseMergeMode = (
  raw: string,
): FlagResult<'auto' | 'gated'> => {
  if (raw !== 'auto' && raw !== 'gated') {
    return { ok: false, message: `merge must be one of auto, gated; got '${raw}'` }
  }
  return { ok: true, value: raw }
}

export interface TaskSpec {
  files: readonly string[]
  verifyCmd: string | null
  doneCriteria: readonly string[]
  mergeMode: 'auto' | 'gated'
}

/**
 * Returns true when `value` contains an odd number of `"` characters OR an odd
 * number of `'` characters — a signal that the shell mangled a quoted argument.
 * Applied only to command-shaped flags (`--verify`); prose fields
 * like `--done` legitimately contain apostrophes (e.g. "don't") and are excluded.
 */
export const hasUnbalancedQuotes = (value: string): boolean =>
  (value.split('"').length - 1) % 2 !== 0 || (value.split("'").length - 1) % 2 !== 0

/**
 * Build a structured-task spec from the `--files`/`--verify`/`--done`/`--merge`
 * flags. Returns `{ ok: true, value: undefined }` when none are present (the
 * row keeps the legacy free-prose shape). Validates `--merge` when present.
 */
export const parseTaskSpec = (
  args: Pick<ParsedArgs, 'flags' | 'multiFlags'>,
): FlagResult<TaskSpec | undefined> => {
  const filesList = args.multiFlags['--files'] ?? []
  const doneList = args.multiFlags['--done'] ?? []
  const verifyRaw = args.flags['--verify']
  const mergeRaw = args.flags['--merge']
  const anySpec =
    filesList.length > 0 ||
    doneList.length > 0 ||
    verifyRaw !== undefined ||
    mergeRaw !== undefined
  if (!anySpec) return { ok: true, value: undefined }

  if (verifyRaw !== undefined && hasUnbalancedQuotes(verifyRaw)) {
    return {
      ok: false,
      message: `--verify value has an unbalanced quote (${verifyRaw}); this usually means the shell mangled the argument — re-quote the whole value in single quotes: --verify 'cmd && cmd'`,
    }
  }

  let mergeMode: 'auto' | 'gated' = 'auto'
  if (mergeRaw !== undefined) {
    const parsed = parseMergeMode(mergeRaw)
    if (!parsed.ok) return parsed
    mergeMode = parsed.value
  }
  return {
    ok: true,
    value: {
      files: filesList,
      verifyCmd: verifyRaw ?? null,
      doneCriteria: doneList,
      mergeMode,
    },
  }
}

/**
 * Returns true when `verifyCmd` contains `repoRoot` as a literal substring.
 *
 * A verifyCmd like `(cd /abs/path/to/repo/orchestrator && npm test)` uses an
 * absolute path that resolves to the integration branch (`main`'s tree), not
 * the task worktree under verify. Such commands can silently produce
 * false-green verifies (tests pass on main but not the task branch) or can
 * never pass (the fix lives in the worktree, not in main).
 *
 * Use relative paths instead: `cd orchestrator && npm test`.
 */
export const containsAbsoluteRepoPath = (verifyCmd: string, repoRoot: string): boolean =>
  repoRoot.length > 0 && verifyCmd.includes(repoRoot)

/**
 * Returns true when `verifyCmd` invokes an entire test suite rather than a
 * scoped subset: bare `npm test` / `npm run test` (a script-name suffix like
 * `test:unit` stays scoped, and args forwarded after `--` usually scope a
 * runner down to specific files), or a bare `vitest run` with no test-file
 * argument (flags alone, e.g. `--reporter=json`, still run everything).
 *
 * This project's full suite is known-red (dozens of pre-existing failures)
 * and reliably exceeds the verify step's wall-clock budget, so a full-suite
 * verify spec can never pass regardless of the task's own changes — see
 * `CLAUDE.md` for the incident this guards against
 * (`verify:timeout/spec-verify-cmd`, twice, 900s each).
 *
 * Inspects each `&&`/`;`/`||`/`|`-separated segment of `verifyCmd`
 * independently so a `cd orchestrator && npm test` pipeline is still caught.
 */
export const isFullSuiteVerifyCmd = (verifyCmd: string): boolean => {
  for (const raw of verifyCmd.split(/&&|\|\||;|\|/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    if (tokens[0] === 'npm') {
      const isBareTest = tokens[1] === 'test'
      const isBareRunTest = tokens[1] === 'run' && tokens[2] === 'test'
      if (isBareTest && tokens.slice(2).length === 0) return true
      if (isBareRunTest && tokens.slice(3).length === 0) return true
    }

    const runnerIdx = tokens.indexOf('vitest')
    if (runnerIdx !== -1 && tokens[runnerIdx + 1] === 'run') {
      const rest = tokens.slice(runnerIdx + 2)
      const hasFileArg = rest.some((t) => !t.startsWith('-'))
      if (!hasFileArg) return true
    }
  }
  return false
}

/**
 * Scan `text` for any `@<token>` word where `<token>` resolves to an existing
 * file on the filesystem. Returns the first offending `@<token>` string, or
 * `null` when none are found.
 *
 * **Title arguments** are short, human-readable labels; a bare `@<path>` token
 * inside one is almost always a body-file reference that the caller mis-placed
 * into the title argument instead of the body. Detecting it here lets the CLI
 * reject the invocation with an actionable message before the mis-routed path
 * is stored verbatim in the DB.
 *
 * Non-path `@` forms do NOT trigger the guard — `existsSync` returns false for
 * tokens like `@media`, `@user`, or `user@example.com`, so they are accepted
 * unchanged.
 *
 * The `exists` parameter is injectable so unit tests can run without touching
 * the filesystem; callers that need the real check omit it (defaults to
 * `existsSync`).
 */
export const findAtPathToken = (
  text: string,
  exists: (p: string) => boolean = existsSync,
): string | null => {
  const tokens = text.match(/@\S+/g)
  if (!tokens) return null
  for (const token of tokens) {
    if (exists(token.slice(1))) return token
  }
  return null
}

/**
 * Detect structurally no-op `--verify` commands — ones that can never report
 * a failure regardless of what the underlying tool finds.
 *
 * Returns a user-facing error string when a no-op pattern is detected, or
 * `null` when the command looks structurally sound. An empty string is also
 * `null` — an absent verify gate is a valid choice, not a problem.
 *
 * Checks five patterns in order:
 *   1. Whitespace-only input — not an absent gate, just invalid.
 *   2. `--no-exit-code` in the last `&&`/`;`-separated segment (`||` is
 *      excluded so 'knip --no-exit-code && tsc --noEmit' is not flagged).
 *   3. Terminal `|| true` or `; true` — unconditional exit 0.
 *   4. Terminal `; exit 0` or `|| exit 0` — forced success override.
 *   5. Last `|`-pipe stage of the last compound segment is `grep`, `tail`, or
 *      `head` — these mask the upstream exit code.
 */
export const isNoOpVerifyCmd = (verifyCmd: string): string | null => {
  // Pattern 1: whitespace-only input is not an absent gate — it is invalid.
  if (/^\s+$/.test(verifyCmd)) {
    return (
      `[mars] --verify is whitespace-only and would never run a real command — ` +
      `specify a meaningful verification command or omit --verify entirely.`
    )
  }

  const trimmed = verifyCmd.trim()

  // Pattern 2: --no-exit-code in the last &&/;-separated segment.
  // Splitting on || is intentionally excluded: 'knip --no-exit-code && tsc --noEmit'
  // has 'tsc --noEmit' as the gating tail, so the gate is not a no-op.
  const andSemiSegments = trimmed.split(/&&|;/).map((s) => s.trim()).filter(Boolean)
  if (andSemiSegments.length > 0) {
    const lastSeg = andSemiSegments[andSemiSegments.length - 1]!
    if (lastSeg.split(/\s+/).includes('--no-exit-code')) {
      return (
        `[mars] --verify contains '--no-exit-code' in its terminal command segment, ` +
        `which suppresses the non-zero exit code and makes the gate always exit 0 — ` +
        `this gate asserts nothing. ` +
        `Remove '--no-exit-code' or add a gating command after it ` +
        `(e.g. '&& npx tsc --noEmit').`
      )
    }
  }

  // Pattern 3: terminal || true / ; true — unconditional exit 0.
  if (/(?:\|\|\s*true|;\s*true)\s*$/.test(trimmed)) {
    return (
      `[mars] --verify ends in '|| true' or '; true' which unconditionally exits 0 ` +
      `regardless of the preceding command's result — this gate asserts nothing. ` +
      `Remove the trailing '|| true' / '; true' to let the real exit code propagate.`
    )
  }

  // Pattern 4: terminal ; exit 0 / || exit 0 — forced success override.
  if (/(?:;\s*exit\s+0|\|\|\s*exit\s+0)\s*$/.test(trimmed)) {
    return (
      `[mars] --verify ends in '; exit 0' or '|| exit 0' which overrides the ` +
      `preceding command's exit code and always exits 0 — this gate asserts nothing. ` +
      `Remove the trailing exit-0 override.`
    )
  }

  // Pattern 5: last pipe stage in the last compound segment is grep/tail/head.
  // These mask the upstream exit code (grep exits 0 when the pattern matches,
  // regardless of whether the main command found errors).
  const compoundSegments = trimmed.split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean)
  if (compoundSegments.length > 0) {
    const lastCompound = compoundSegments[compoundSegments.length - 1]!
    const pipeStages = lastCompound.split('|').map((s) => s.trim()).filter(Boolean)
    if (pipeStages.length > 1) {
      const firstToken = pipeStages[pipeStages.length - 1]!.split(/\s+/)[0] ?? ''
      if (['grep', 'tail', 'head'].includes(firstToken)) {
        return (
          `[mars] --verify pipes into '${firstToken}' as its final stage, which masks ` +
          `the upstream exit code — '${firstToken}' exits 0 when the pattern matches ` +
          `regardless of what the main command found. ` +
          `Remove '| ${firstToken} …' or capture output to a file and check the main ` +
          `command's exit code directly.`
        )
      }
    }
  }

  return null
}

/** `--blocked-by`: the repeatable blocker-id list (possibly empty). */
export const parseBlockedBy = (
  args: Pick<ParsedArgs, 'multiFlags'>,
): readonly string[] => args.multiFlags['--blocked-by'] ?? []

/** `--tag`: the repeatable tag list, or undefined when none were passed. */
export const parseTags = (
  args: Pick<ParsedArgs, 'multiFlags'>,
): string[] | undefined => {
  const tags = args.multiFlags['--tag']
  return tags && tags.length > 0 ? tags : undefined
}

// ---------------------------------------------------------------------------
// npm script existence validation
// ---------------------------------------------------------------------------

/**
 * Script body patterns that make a gate unconditionally pass regardless of
 * what it finds, rendering it useless as a quality gate.
 */
const UNCONDITIONAL_PASS_RE = /--no-exit-code|\|\|\s*true|;\s*exit\s+0|;\s*true(?:\s|$)/

/**
 * Pure core: check each `npm run <script>` / `npm test` segment in
 * `verifyCmd` against `pkgScripts` — a map from relative directory path
 * (e.g. `'.'`, `'orchestrator'`) to its `package.json` scripts object.
 *
 * The function tracks any leading `cd <dir>` segment and resolves the
 * subsequent `npm run` call against that directory. Returns a user-facing
 * error string on the first problem found, or `null` when everything is valid.
 *
 * Exported so callers can inject any `pkgScripts` map for testing without
 * touching the filesystem.
 */
export const checkNpmScriptExists = (
  verifyCmd: string,
  pkgScripts: ReadonlyMap<string, Readonly<Record<string, string>>>,
): string | null => {
  let cwd = '.'

  for (const raw of verifyCmd.split(/&&|\|\||;/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    // `cd <dir>` — update cwd for subsequent segments in the same chain.
    if (tokens[0] === 'cd' && tokens[1]) {
      cwd = tokens[1]
      continue
    }

    // Identify the npm script being invoked.
    let scriptName: string | null = null
    if (tokens[0] === 'npm') {
      if (tokens[1] === 'run' && tokens[2]) {
        scriptName = tokens[2]
      } else if (tokens[1] === 'test' && tokens.length === 2) {
        scriptName = 'test'
      }
    }
    if (scriptName === null) continue

    const scripts = pkgScripts.get(cwd)
    if (scripts === undefined) {
      // No package.json loaded for this dir — can't validate, skip silently.
      continue
    }

    if (scriptName in scripts) {
      // Script exists. Check whether its body unconditionally passes.
      const body = scripts[scriptName]
      if (typeof body === 'string' && UNCONDITIONAL_PASS_RE.test(body)) {
        const snippet = body.length > 80 ? body.slice(0, 80) + '…' : body
        return (
          `[mars] --verify resolves to script '${scriptName}' whose body contains an ` +
          `unconditionally-passing pattern (it always exits 0 regardless of findings): ` +
          `${snippet} — this gate asserts nothing. ` +
          `Remove the no-op flag or use a different verification command.`
        )
      }
      continue
    }

    // Script not found in the expected directory. Search other loaded dirs.
    const foundElsewhere = [...pkgScripts.entries()].find(
      ([dir, s]) => dir !== cwd && scriptName! in s,
    )

    const cwdDesc = cwd === '.' ? 'the repo root' : `${cwd}/`
    if (foundElsewhere) {
      const [foundDir] = foundElsewhere
      const foundDesc = foundDir === '.' ? 'the repo root' : `${foundDir}/`
      return (
        `[mars] --verify names script '${scriptName}' which does not exist in ` +
        `${cwdDesc} package.json — it was found in ${foundDesc} package.json. ` +
        `Fix the cd prefix: use 'cd ${foundDir} && npm run ${scriptName}' instead.`
      )
    }

    return (
      `[mars] --verify names script '${scriptName}' which does not exist in ` +
      `${cwdDesc} package.json and was not found in any other package.json in the repo.`
    )
  }

  return null
}

/**
 * Load all `package.json` scripts maps from the repo root and top-level
 * subdirectories (excluding `node_modules` and hidden dirs).
 *
 * Returns a Map from relative dir path (e.g. `'.'`, `'orchestrator'`) to its
 * scripts object. Directories without a `package.json` are omitted so
 * {@link checkNpmScriptExists} can skip validation for them rather than
 * reporting false positives.
 */
const loadAllPkgScripts = (repoRoot: string): Map<string, Record<string, string>> => {
  const result = new Map<string, Record<string, string>>()

  const tryLoad = (dir: string): void => {
    const pkgPath = dir === '.' ? join(repoRoot, 'package.json') : join(repoRoot, dir, 'package.json')
    try {
      if (!existsSync(pkgPath)) return
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8') as string) as Record<string, unknown>
      if (pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null) {
        result.set(dir, pkg.scripts as Record<string, string>)
      }
    } catch {
      // Malformed package.json — skip silently.
    }
  }

  tryLoad('.')

  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      tryLoad(entry.name)
    }
  } catch {
    // Cannot read repo root — skip subdirectory scan.
  }

  return result
}

/**
 * I/O wrapper: loads all `package.json` scripts from the repo tree and
 * delegates to {@link checkNpmScriptExists}.
 *
 * Returns `null` when `repoRoot` is empty (cannot resolve paths) or when
 * no `npm run` invocations are found in `verifyCmd`. Returns a user-facing
 * error string when a script does not exist in its resolved directory or
 * when its body unconditionally passes.
 */
export const detectNonexistentNpmScript = (
  verifyCmd: string,
  repoRoot: string,
): string | null => {
  if (!repoRoot) return null
  return checkNpmScriptExists(verifyCmd, loadAllPkgScripts(repoRoot))
}

// ---------------------------------------------------------------------------
// vitest test-file existence validation
// ---------------------------------------------------------------------------

/**
 * Pure core: validates literal vitest test-file paths in `verifyCmd` against
 * the filesystem. Called at enqueue time so a non-existent path is surfaced
 * immediately rather than after the task's coder has run for tens of minutes.
 *
 * Returns a user-facing warning string when a literal (non-glob) path
 * argument to `vitest run` does not resolve to an existing file. Returns
 * `null` when every literal path exists (or is a glob/pattern).
 *
 * Paths that contain `*`, `?`, or `{` are treated as glob patterns and
 * skipped — glob expansion cannot be evaluated without a live shell.
 *
 * Injecting `exists` and `resolveDir` lets callers test without filesystem
 * access. In production, `resolveDir(relDir)` should return
 * `join(repoRoot, relDir)` (or `repoRoot` itself for `'.'`).
 */
export const checkVitestPathsExist = (
  verifyCmd: string,
  exists: (absPath: string) => boolean,
  resolveDir: (relDir: string) => string,
): string | null => {
  let cwd = '.'

  for (const raw of verifyCmd.split(/&&|\|\||;/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue

    // Track `cd <dir>` so subsequent segments resolve correctly.
    if (tokens[0] === 'cd' && tokens[1]) {
      cwd = tokens[1]
      continue
    }

    const vitestIdx = tokens.indexOf('vitest')
    if (vitestIdx === -1 || tokens[vitestIdx + 1] !== 'run') continue

    // Collect non-flag arguments after `vitest run` — these are the test
    // file paths (or patterns) passed to the runner.
    const rest = tokens.slice(vitestIdx + 2)
    const filePaths = rest.filter((t) => !t.startsWith('-'))

    for (const p of filePaths) {
      // Glob patterns cannot be validated statically — skip them.
      if (p.includes('*') || p.includes('?') || p.includes('{')) continue

      const absPath = join(resolveDir(cwd), p)
      if (!exists(absPath)) {
        const cwdDesc = cwd === '.' ? 'the repo root' : `${cwd}/`
        return (
          `[mars] --verify names test file '${p}' in ${cwdDesc} which does not exist. ` +
          `Check the path, or add it to --files if this task is about to create it. ` +
          `Proceeding with enqueue — the verify step will fail if the file is still missing then.`
        )
      }
    }
  }
  return null
}

/**
 * I/O wrapper: resolves vitest file paths against the repo root and delegates
 * to {@link checkVitestPathsExist}.
 *
 * Returns `null` when `repoRoot` is empty or when all literal paths exist.
 * Returns a user-facing warning string when a literal path does not exist.
 */
export const detectNonexistentVitestPath = (
  verifyCmd: string,
  repoRoot: string,
): string | null => {
  if (!repoRoot) return null
  return checkVitestPathsExist(
    verifyCmd,
    existsSync,
    (relDir) => (relDir === '.' ? repoRoot : join(repoRoot, relDir)),
  )
}
