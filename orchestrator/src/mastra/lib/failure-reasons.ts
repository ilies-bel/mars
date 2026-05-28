/**
 * Failure-reason catalog: typed, operator-facing failure codes plus the
 * terminal actions the inbox UI offers for each.
 *
 * The catalog is loaded once per daemon process. Resolution rules:
 *
 *  1. Built-in defaults (`failure-reasons/built-in.ts`) seed the catalog.
 *  2. `.mars/failure-reasons/*.yaml` files override per-code. A file whose
 *     `code` matches a built-in replaces the built-in entry entirely
 *     (no deep-merge — the consumer owns the record); a file with a new
 *     `code` adds to the catalog.
 *  3. Malformed YAML / schema-rejected files are logged once and skipped;
 *     other files in the directory continue to load.
 *  4. No hot-reload: edits land on the next `mars daemon reload`/restart.
 *
 * Filename convention: `<code>.yaml`, with `/` in the code replaced by `--`
 * so codes like `verify:main-dirty` and `merge:vcs-supervisor-aborted` map
 * to filesystem-safe names.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { z } from 'zod'
import {
  BUILT_IN_FAILURE_REASONS,
  UNKNOWN_FAILURE_CODE,
} from '../failure-reasons/built-in'

/** A button the inbox UI surfaces for a failed task. */
export interface FailureAction {
  /** Short verb the UI binds to a button: `restart`, `purge`, `dismiss`, … */
  id: string
  /** Operator-facing label, e.g. "Restart from scratch". */
  label: string
  /** CLI invocation hint, e.g. `mars restart <id>`. Null when the action is
   * UI-only (e.g. `dismiss`). */
  cliHint: string | null
}

/** A catalog entry — one resolved failure mode. */
export interface FailureReason {
  /** Stable identifier, e.g. `verify:main-dirty`. */
  code: string
  /** One-line operator-facing message. */
  userMessage: string
  /** Optional recipe ref; wired in slice E/F. Always `null` today. */
  recipe: string | null
  /** Terminal actions (order matters — UI uses it). */
  availableActions: readonly FailureAction[]
}

/**
 * Zod schemas for parsed YAML. `code` is required and non-empty; `recipe`
 * accepts `null` or a string; `availableActions` must be a non-empty array.
 * `unknown`-kinded missing fields fail loud so a malformed override is
 * obvious in the daemon log.
 */
export const failureActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  cliHint: z.string().nullable(),
})

export const failureReasonSchema = z.object({
  code: z.string().min(1),
  userMessage: z.string().min(1),
  recipe: z.string().nullable(),
  availableActions: z.array(failureActionSchema).min(1),
})

/** Resolved catalog. Always contains an `unknown` fallback entry. */
export interface FailureReasonCatalog {
  /** Resolve a code to its catalog entry, falling back to `unknown`. */
  get: (code: string | null | undefined) => FailureReason
  /** Every entry as a flat list (built-in + overrides merged). Stable order:
   * built-in order first, then any override-only codes in insertion order. */
  list: () => readonly FailureReason[]
}

/**
 * Encode/decode a code to its on-disk filename. Codes use `:` and may contain
 * `/`; only `/` is unsafe on common filesystems, so we replace it with `--`.
 * Built-in codes today contain only `:` separators, but the encoding handles
 * future codes that include path-like sub-keys.
 */
export const codeToFilename = (code: string): string =>
  `${code.replace(/\//g, '--')}.yaml`

export const filenameToCode = (filename: string): string => {
  const base = filename.replace(/\.ya?ml$/i, '')
  return base.replace(/--/g, '/')
}

/**
 * Build a catalog instance over the supplied entries. Internal — callers go
 * through {@link loadFailureReasonCatalog}.
 */
const buildCatalog = (
  entries: readonly FailureReason[],
): FailureReasonCatalog => {
  const byCode = new Map<string, FailureReason>()
  for (const entry of entries) {
    byCode.set(entry.code, entry)
  }
  const fallback =
    byCode.get(UNKNOWN_FAILURE_CODE) ??
    BUILT_IN_FAILURE_REASONS.find((e) => e.code === UNKNOWN_FAILURE_CODE)
  if (!fallback) {
    // Defensive: the built-in seed always carries `unknown`. If a consumer
    // somehow strips it via an override, we still need a deterministic
    // fallback so `get()` cannot return `undefined`.
    throw new Error(
      'failure-reason catalog has no `unknown` fallback entry; built-in seed is malformed',
    )
  }
  return {
    get: (code) => {
      if (!code) return fallback
      return byCode.get(code) ?? fallback
    },
    list: () => Array.from(byCode.values()),
  }
}

const FAILURE_REASONS_DIRNAME = 'failure-reasons'

/**
 * Resolve the consumer-owned override directory under a `.mars/` state dir.
 * Exported for tests and for `mars init` to write seed files into.
 */
export const failureReasonsDir = (stateDir: string): string =>
  resolve(stateDir, FAILURE_REASONS_DIRNAME)

/**
 * Load the catalog. Built-ins are merged first; per-file overrides take
 * precedence wholesale (no deep-merge). Malformed files are logged via
 * `onWarn` (defaults to `console.warn`) and skipped.
 */
export const loadFailureReasonCatalog = async (
  stateDir: string,
  opts: { onWarn?: (msg: string) => void } = {},
): Promise<FailureReasonCatalog> => {
  const onWarn = opts.onWarn ?? ((msg) => console.warn(msg))
  const dir = failureReasonsDir(stateDir)
  // Built-ins keyed by code so per-file overrides can replace cleanly.
  const merged = new Map<string, FailureReason>()
  for (const entry of BUILT_IN_FAILURE_REASONS) {
    merged.set(entry.code, entry)
  }

  if (existsSync(dir)) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()
    } catch (err) {
      onWarn(
        `[failure-reasons] failed to read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      )
      files = []
    }
    for (const file of files) {
      const abs = resolve(dir, file)
      let raw: string
      try {
        raw = readFileSync(abs, 'utf8')
      } catch (err) {
        onWarn(
          `[failure-reasons] failed to read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }
      let parsed: unknown
      try {
        parsed = parseYaml(raw)
      } catch (err) {
        onWarn(
          `[failure-reasons] ${file}: YAML parse failed (${err instanceof Error ? err.message : String(err)}); skipping`,
        )
        continue
      }
      const result = failureReasonSchema.safeParse(parsed)
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')
        onWarn(
          `[failure-reasons] ${file}: schema rejected (${issues}); skipping`,
        )
        continue
      }
      // Wholesale replacement: per-code, the file wins.
      merged.set(result.data.code, result.data as FailureReason)
    }
  }

  return buildCatalog(Array.from(merged.values()))
}
