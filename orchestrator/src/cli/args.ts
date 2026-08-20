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

import { readFileSync } from 'node:fs'

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
  // mars verify-gate add/set --timeout <minutes>: per-gate wall-clock timeout.
  '--timeout',
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
 * `mars proposal add @file.md --title x` would store the literal string
 * `"@file.md --title x"` as the goal instead of expanding the file and
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
