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
  '--note',
  '--root-cause',
  '--avoid',
  '--blocked-by',
  '--source',
  '--status',
  '--from',
  '--kind',
  '--port',
  '--host',
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
  '--feedback',
  // mars memory — domain-scoped memory packet management
  '--domain',
  '--text',
  '--salience',
  '--min-salience',
  // mars chat-feedback list — filter by rating ('up' or 'down')
  '--rating',
  '--origin-arc',
  // mars verify-gate / mars verify — verify gate registry management
  '--scope',
  '--cmd',
  '--tier',
  '--manifest',
  // mars verify add — repeated gate args (--args tsc --args --noEmit)
  '--args',
  '--surface-form',
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
])

/**
 * Boolean flags accepted by one or more leaves. Combined with
 * {@link FLAGS_WITH_VALUES} this is the full set of flags any leaf may legally
 * see; the registry-iterating test rejects anything outside the union.
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--force',
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
  // mars release-notes list — cursor-based feed filtering
  '--unseen',
  '--mark-viewed',
])

// Short aliases for value-bearing flags, normalised to their long form before
// the FLAGS_WITH_VALUES lookup.
export const SHORT_FLAG_ALIASES: Readonly<Record<string, string>> = {}

export const REPEATABLE_FLAGS: ReadonlySet<string> = new Set([
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
  let repo: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue

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
  return { repo, flags, multiFlags, positional }
}

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
 */
export const resolvePromptSource = (
  positional: readonly string[],
  flags: Record<string, string>,
  readStdin: () => string = () => readFileSync(0, 'utf8'),
): FlagResult<string> => {
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
export const parseMergeMode = (
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
