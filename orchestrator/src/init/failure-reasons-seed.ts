/**
 * `mars init` step that writes one consumer-owned YAML override per
 * built-in failure-reason code into `.mars/failure-reasons/`.
 *
 * Semantics:
 *  - No-overwrite. If the target file already exists, leave it untouched —
 *    the consumer owns the file once it lands. Re-running `mars init` after
 *    a binary upgrade that introduced a new built-in code therefore writes
 *    only the missing files.
 *  - The file's `code` is authoritative; the filename is derived from it
 *    via `codeToFilename` (slashes → `--`).
 *  - The file body is a YAML serialisation of the catalog entry, prefixed
 *    by a leading comment explaining ownership.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dump as dumpYaml } from 'js-yaml'
import { BUILT_IN_FAILURE_REASONS } from '../core/failure-reasons/built-in'
import {
  codeToFilename,
  failureReasonsDir,
  type FailureReason,
} from '../core/lib/failure-reasons'

/** Result of seeding the override directory. `written` lists the relative
 * filenames (e.g. `verify:typecheck.yaml`) that were created on this run;
 * `skipped` lists pre-existing files that were left untouched. */
export interface FailureReasonsSeedResult {
  /** Absolute path of the override directory. */
  dir: string
  /** Filenames written on this run (consumer-owned thereafter). */
  written: string[]
  /** Filenames that already existed — preserved as-is. */
  skipped: string[]
}

const LEADING_COMMENT = [
  '# Failure-reason catalog entry: edit freely, this file is consumer-owned.',
  '# Mars\'s built-in defaults live in the binary; this file overrides them.',
].join('\n')

const renderEntry = (entry: FailureReason): string => {
  const body = dumpYaml(
    {
      code: entry.code,
      userMessage: entry.userMessage,
      recipe: entry.recipe,
      availableActions: entry.availableActions.map((a) => ({
        id: a.id,
        label: a.label,
        cliHint: a.cliHint,
      })),
    },
    { lineWidth: 120, noRefs: true },
  )
  return `${LEADING_COMMENT}\n${body}`
}

/**
 * Write seed YAML files for every built-in entry into
 * `<stateDir>/failure-reasons/`. Idempotent: existing files are preserved,
 * new files are written. Returns the breakdown for the caller to log.
 */
export const writeFailureReasonsSeed = (
  stateDir: string,
): FailureReasonsSeedResult => {
  const dir = failureReasonsDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const skipped: string[] = []
  for (const entry of BUILT_IN_FAILURE_REASONS) {
    const filename = codeToFilename(entry.code)
    const abs = resolve(dir, filename)
    if (existsSync(abs)) {
      skipped.push(filename)
      continue
    }
    writeFileSync(abs, renderEntry(entry), 'utf8')
    written.push(filename)
  }
  return { dir, written, skipped }
}
