/**
 * Static safety lint for agent-authored workflow bodies (ADR-0068).
 *
 * This lint runs BEFORE the `validateWorkflow` dry-run — the dry-run executes
 * the author's `fn` (only primitive work is stubbed), so this is the one
 * screen that inspects agent JS without running any of it. It enforces the
 * self-authored workflow contract:
 *
 *   - imports restricted to the single `'mars/workflow'` surface, named
 *     bindings only, drawn from the allowed primitive set;
 *   - no dynamic `import()`, `require`, `eval`, `new Function`, `process`,
 *     or `globalThis` anywhere in the body;
 *   - exactly one `export default` — either `defineWorkflow({...})` or a
 *     plain `{ id, fn }` object literal (the two shapes `loadWorkflowByName`
 *     accepts);
 *   - no top-level statements besides the imports and that default export
 *     ("no top-level side effects" — all work lives inside `ctx.step` bodies
 *     composing the five primitives).
 *
 * The lint is a best-effort textual screen, not a sandbox: the trust boundary
 * remains write-time operator approval (`mars workflow approve`). A body that
 * passes the lint still lands as a non-dispatchable agent draft.
 */

export interface WorkflowLintResult {
  ok: boolean
  errors: string[]
}

/** The single import surface an authored workflow may use. */
export const ALLOWED_WORKFLOW_IMPORT = 'mars/workflow'

/** Named bindings an authored workflow may import from `mars/workflow`. */
export const ALLOWED_IMPORT_BINDINGS: ReadonlySet<string> = new Set([
  'defineWorkflow',
  'setupWorktree',
  'runAgent',
  'verify',
  'merge',
  'awaitHuman',
])

/** Identifiers that are always rejected, wherever they appear. */
const BANNED_IDENTIFIERS: readonly string[] = [
  'require',
  'eval',
  'Function',
  'process',
  'globalThis',
]

interface StringLiteral {
  /** Index of the opening quote character. */
  start: number
  /** Index just past the closing quote character. */
  end: number
  value: string
}

interface BlankedSource {
  /**
   * The source with comment bodies, string contents, template contents, and
   * regex-literal bodies replaced by spaces (newlines preserved so line
   * numbers survive). Quote/delimiter characters are kept in place.
   */
  blanked: string
  /** Every single/double-quoted string literal, in source order. */
  strings: StringLiteral[]
}

const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'case',
  'do',
  'else',
  'void',
  'delete',
  'yield',
  'await',
  'throw',
])

/** True when a `/` at this point starts a regex literal (heuristic). */
const regexCanFollow = (blankedSoFar: string): boolean => {
  const trimmed = blankedSoFar.replace(/[\s]+$/, '')
  if (trimmed.length === 0) return true
  const last = trimmed[trimmed.length - 1]!
  if ('(,=:[!&|?{};+*%<>~^-'.includes(last)) return true
  const wordMatch = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed)
  if (wordMatch && KEYWORDS_BEFORE_REGEX.has(wordMatch[1]!)) return true
  return false
}

/**
 * Scan the source, blanking out everything that is not code (comments,
 * string/template contents, regex bodies) while recording string literals.
 * Template interpolations (`${ … }`) are treated as code — a banned
 * identifier inside one is still visible to the checks.
 */
const blankNonCode = (source: string): BlankedSource => {
  const out = source.split('')
  const strings: StringLiteral[] = []

  type Mode = 'code' | 'template'
  // Stack of enclosing template contexts; `braceDepth` tracks the open braces
  // of the current interpolation so we know when the template resumes.
  const templateStack: number[] = []
  let braceDepth = 0
  let mode: Mode = 'code'

  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' '
  }

  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (mode === 'template') {
      if (ch === '\\') {
        blank(i)
        if (i + 1 < source.length) blank(i + 1)
        i += 2
        continue
      }
      if (ch === '`') {
        mode = 'code'
        braceDepth = templateStack.pop() ?? 0
        i += 1
        continue
      }
      if (ch === '$' && source[i + 1] === '{') {
        templateStack.push(braceDepth)
        braceDepth = 0
        mode = 'code'
        i += 2
        continue
      }
      blank(i)
      i += 1
      continue
    }

    // mode === 'code'
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        blank(i)
        i += 1
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      blank(i)
      blank(i + 1)
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        blank(i)
        i += 1
      }
      if (i < source.length) {
        blank(i)
        blank(i + 1)
        i += 2
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      let value = ''
      i += 1
      while (i < source.length && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          value += source.slice(i, i + 2)
          blank(i)
          if (i + 1 < source.length) blank(i + 1)
          i += 2
          continue
        }
        value += source[i]!
        blank(i)
        i += 1
      }
      if (i < source.length && source[i] === quote) i += 1
      strings.push({ start, end: i, value })
      continue
    }
    if (ch === '`') {
      mode = 'template'
      i += 1
      continue
    }
    if (ch === '/' && regexCanFollow(out.slice(0, i).join(''))) {
      // Regex literal: blank the body, honouring escapes and char classes.
      i += 1
      let inClass = false
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          blank(i)
          if (i + 1 < source.length) blank(i + 1)
          i += 2
          continue
        }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) {
          i += 1
          break
        }
        blank(i)
        i += 1
      }
      continue
    }
    if (templateStack.length > 0) {
      if (ch === '{') braceDepth += 1
      if (ch === '}') {
        if (braceDepth === 0) {
          // End of interpolation — resume the enclosing template.
          mode = 'template'
          i += 1
          continue
        }
        braceDepth -= 1
      }
    }
    i += 1
  }

  return { blanked: out.join(''), strings }
}

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split('\n').length

/** Walk a balanced pair starting at `open`; returns index past the closer. */
const skipBalanced = (
  blanked: string,
  open: number,
  openCh: string,
  closeCh: string,
): number | null => {
  let depth = 0
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === openCh) depth += 1
    else if (blanked[i] === closeCh) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return null
}

/**
 * Lint an agent-authored workflow body. Purely textual — nothing in `source`
 * is evaluated. Returns every violation found (not just the first).
 */
export const lintAgentWorkflowBody = (source: string): WorkflowLintResult => {
  const errors: string[] = []
  const { blanked, strings } = blankNonCode(source)

  // Spans of source consumed by legal constructs; anything left over at top
  // level is a violation of the "no top-level side effects" rule.
  const consumed: Array<[number, number]> = []

  // ── Imports ────────────────────────────────────────────────────────────
  const importRe = /\bimport\b/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(blanked)) !== null) {
    const at = m.index
    const after = blanked.slice(at + 6).replace(/^\s*/, '')
    const line = lineOf(source, at)
    if (after.startsWith('(')) {
      errors.push(`line ${line}: dynamic import() is not allowed`)
      continue
    }
    if (after.startsWith('.')) {
      errors.push(`line ${line}: import.meta is not allowed`)
      continue
    }
    // Static declaration: the specifier is the first string literal after it.
    const spec = strings.find((s) => s.start > at)
    if (spec === undefined) {
      errors.push(`line ${line}: malformed import declaration`)
      continue
    }
    if (spec.value !== ALLOWED_WORKFLOW_IMPORT) {
      errors.push(
        `line ${line}: import from '${spec.value}' is not allowed — the only legal import surface is '${ALLOWED_WORKFLOW_IMPORT}'`,
      )
    }
    // Bindings clause between `import` and `from`.
    const clauseBlanked = blanked.slice(at + 6, spec.start)
    const fromIdx = clauseBlanked.lastIndexOf('from')
    const clause = (fromIdx === -1 ? '' : clauseBlanked.slice(0, fromIdx)).trim()
    if (clause.length > 0) {
      if (clause.includes('*')) {
        errors.push(
          `line ${line}: namespace imports are not allowed — use named imports from '${ALLOWED_WORKFLOW_IMPORT}'`,
        )
      } else if (!clause.startsWith('{') || !clause.endsWith('}')) {
        errors.push(
          `line ${line}: use named imports only (import { … } from '${ALLOWED_WORKFLOW_IMPORT}')`,
        )
      } else {
        const names = clause
          .slice(1, -1)
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((part) => part.split(/\s+as\s+/)[0]!.trim())
        for (const name of names) {
          if (!ALLOWED_IMPORT_BINDINGS.has(name)) {
            errors.push(
              `line ${line}: '${name}' is not an allowed import — legal bindings are: ${[...ALLOWED_IMPORT_BINDINGS].join(', ')}`,
            )
          }
        }
      }
    }
    // Consume the declaration span (through the specifier and optional `;`).
    let end = spec.end
    while (end < blanked.length && /[\s;]/.test(blanked[end]!)) {
      end += 1
      if (blanked[end - 1] === ';' || blanked[end - 1] === '\n') break
    }
    consumed.push([at, end])
  }

  // ── Banned identifiers ─────────────────────────────────────────────────
  for (const banned of BANNED_IDENTIFIERS) {
    const re = new RegExp(`(?<![.$\\w])${banned}\\b`, 'g')
    let hit: RegExpExecArray | null
    while ((hit = re.exec(blanked)) !== null) {
      errors.push(
        `line ${lineOf(source, hit.index)}: '${banned}' is not allowed in a self-authored workflow`,
      )
    }
  }

  // ── Export default shape ───────────────────────────────────────────────
  const exportRe = /\bexport\b/g
  const exportDefaults: number[] = []
  while ((m = exportRe.exec(blanked)) !== null) {
    const at = m.index
    const after = blanked.slice(at + 6).replace(/^\s*/, '')
    if (!after.startsWith('default')) {
      errors.push(
        `line ${lineOf(source, at)}: only 'export default' is allowed — no named exports`,
      )
      continue
    }
    exportDefaults.push(at)
  }
  if (exportDefaults.length === 0) {
    errors.push(
      `the body must contain exactly one 'export default' — either defineWorkflow({...}) or a { id, fn } object`,
    )
  } else if (exportDefaults.length > 1) {
    errors.push(`only one 'export default' is allowed (found ${exportDefaults.length})`)
  } else {
    const at = exportDefaults[0]!
    const line = lineOf(source, at)
    const exprStart = at + blanked.slice(at).indexOf('default') + 'default'.length
    const rest = blanked.slice(exprStart)
    const restTrim = rest.replace(/^\s*/, '')
    const exprAt = exprStart + (rest.length - restTrim.length)
    let end: number | null = null
    if (/^defineWorkflow\s*\(/.test(restTrim)) {
      const open = exprAt + restTrim.indexOf('(')
      end = skipBalanced(blanked, open, '(', ')')
    } else if (restTrim.startsWith('{')) {
      end = skipBalanced(blanked, exprAt, '{', '}')
    } else {
      errors.push(
        `line ${line}: export default must be defineWorkflow({...}) or a { id, fn } object literal`,
      )
    }
    if (end !== null) {
      while (end < blanked.length && /[\s;]/.test(blanked[end]!)) {
        end += 1
        if (blanked[end - 1] === ';' || blanked[end - 1] === '\n') break
      }
      consumed.push([at, end])
    } else if (restTrim.startsWith('{') || /^defineWorkflow\s*\(/.test(restTrim)) {
      errors.push(`line ${line}: unbalanced export default expression`)
    }
  }

  // ── Top-level residue ──────────────────────────────────────────────────
  const residue = blanked.split('')
  for (const [start, end] of consumed) {
    for (let idx = start; idx < end && idx < residue.length; idx++) {
      if (residue[idx] !== '\n') residue[idx] = ' '
    }
  }
  const leftover = residue.join('')
  const stray = /\S+/g
  let strayHit: RegExpExecArray | null
  const strayLines = new Set<number>()
  while ((strayHit = stray.exec(leftover)) !== null) {
    strayLines.add(lineOf(source, strayHit.index))
  }
  for (const line of [...strayLines].sort((a, b) => a - b)) {
    errors.push(
      `line ${line}: top-level code outside imports and the default export is not allowed (no top-level side effects)`,
    )
  }

  return { ok: errors.length === 0, errors }
}
