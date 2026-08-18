/**
 * Guard: every step id AUTHORED IN THIS REPO satisfies `STEP_ID_RE`.
 *
 * ## The regression this exists to prevent
 *
 * The live spec-verify step was once named `spec.verifyCmd`. The signature
 * builder in `review.ts` turns a failing step's name into `verify:<name>`, so
 * that step reached `computeFailureSignature` as `verify:spec.verifyCmd` —
 * which fails `STEP_ID_RE` twice over (a `.` and capital letters).
 * `asStepId` therefore returned `null`, the timeout branch fell back to
 * `UNKNOWN_STEP_ID`, and EVERY timed-out task verify signed as
 * `verify:timeout/unknown`. The step name was silently dropped: all
 * task-verify timeouts collapsed into one anonymous bucket alongside
 * genuinely unknown-step timeouts, `failureReason` and `failureSignature`
 * disagreed, and no purpose-built recovery recipe could match.
 *
 * ## Why a test rather than a runtime assert
 *
 * `asStepId` returning `null` has two very different causes:
 *
 *  - prose arriving from a subprocess or a legacy DB row (e.g. `Re-queue time
 *    bound exceeded: 1 attempt(s) over 270m`) — degrading to `unknown` is the
 *    designed behaviour and must stay silent;
 *  - a step id a human typed into this repo — a programming error that is
 *    completely invisible at authoring time, because nothing rejects it until
 *    a failure of exactly the right kind happens in production.
 *
 * Only the second is a defect, and only the second is statically knowable.
 * So this test parses the source tree and checks the grammar over every
 * statically-declared step id. The next rename that violates it fails here,
 * at authoring time, instead of six weeks later in a signature bucket nobody
 * is reading.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { STEP_ID_RE, asStepId, computeFailureSignature } from '../failure-signature'
import { SPEC_VERIFY_CMD_STEP } from '../git/verify'

// `src/core/lib/__tests__/` -> `src/`
const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Directories excluded from the scan:
 *  - `__tests__` and `*.test.ts` — test fixtures deliberately author invalid
 *    ids to prove they degrade to `unknown`;
 *  - `init/templates` — consumer-facing template tree, not orchestrator code.
 */
const isScannable = (path: string): boolean =>
  !path.includes('__tests__') &&
  !path.includes(join('init', 'templates')) &&
  !path.endsWith('.test.ts') &&
  !path.endsWith('.spec.ts')

const collectSourceFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      out.push(...collectSourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (!isScannable(full)) continue
    out.push(full)
  }
  return out
}

/** A step id found in the source tree, with enough context to fix it. */
interface AuthoredStepId {
  /** The literal as written, already in the form that reaches the signature. */
  readonly stepId: string
  /** `<repo-relative path>:<line>` — printed verbatim on failure. */
  readonly where: string
  /** Which extractor found it, so a failure explains what the value feeds. */
  readonly via: 'computeFailureSignature' | 'VerifyStepSpec.name'
}

const locate = (file: string, node: ts.Node, source: ts.SourceFile): string => {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${file.slice(SRC_ROOT.length)}:${line + 1}`
}

/**
 * Extract the step ids a file declares statically.
 *
 * Two authored positions reach `computeFailureSignature`'s step argument:
 *
 *  1. the first argument of a literal `computeFailureSignature('…', …)` call —
 *     the step id verbatim;
 *  2. the `name` of a `VerifyStepSpec`-shaped object literal — `review.ts`
 *     prefixes the FAILING step's name with `verify:` to build the step id, so
 *     `verify:<name>` is what must satisfy the grammar. An object literal is
 *     treated as a verify step when it carries a string-literal `name` plus a
 *     `tier` or `required` property (the VerifyStepSpec discriminators).
 *
 * A `name` given as an identifier (e.g. `SPEC_VERIFY_CMD_STEP`) is not
 * resolved here — those constants are asserted directly in the last test.
 */
const extractStepIds = (file: string): AuthoredStepId[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const found: AuthoredStepId[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'computeFailureSignature'
    ) {
      const first = node.arguments[0]
      if (first !== undefined && ts.isStringLiteral(first)) {
        found.push({
          stepId: first.text,
          where: locate(file, first, source),
          via: 'computeFailureSignature',
        })
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment)
      const keyOf = (p: ts.PropertyAssignment): string =>
        ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : ''
      const looksLikeVerifyStep = props.some(
        (p) => keyOf(p) === 'tier' || keyOf(p) === 'required',
      )
      const nameProp = props.find((p) => keyOf(p) === 'name')
      if (
        looksLikeVerifyStep &&
        nameProp !== undefined &&
        ts.isStringLiteral(nameProp.initializer)
      ) {
        found.push({
          // review.ts builds `verify:${failingStepName}` — check that form.
          stepId: `verify:${nameProp.initializer.text}`,
          where: locate(file, nameProp, source),
          via: 'VerifyStepSpec.name',
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return found
}

describe('authored step ids satisfy STEP_ID_RE', () => {
  const authored = collectSourceFiles(SRC_ROOT).flatMap(extractStepIds)

  it('finds step ids to check (guards against a scan that silently matches nothing)', () => {
    // A regex/AST change that stops matching would make every assertion below
    // vacuously true. Anchor on a floor well under the real count.
    expect(authored.length).toBeGreaterThan(10)
    expect(authored.some((a) => a.via === 'computeFailureSignature')).toBe(true)
  })

  it('every statically-declared step id is a valid step id', () => {
    const violations = authored
      .filter((a) => !STEP_ID_RE.test(a.stepId))
      .map((a) => `${a.where} (${a.via}): ${a.stepId}`)

    // A violating id silently becomes `unknown` in every signature it reaches.
    // Rename it to lower-case-hyphenated form (`spec.verifyCmd` ->
    // `spec-verify-cmd`) rather than relaxing STEP_ID_RE.
    expect(violations).toEqual([])
  })

  it('every statically-declared step id survives asStepId unchanged', () => {
    // STEP_ID_RE is the grammar; asStepId is the gate that actually runs.
    // Assert the gate agrees, so a future asStepId change cannot pass the
    // grammar check above and still drop the step at runtime.
    const dropped = authored
      .filter((a) => asStepId(a.stepId) !== a.stepId)
      .map((a) => `${a.where} (${a.via}): ${a.stepId}`)

    expect(dropped).toEqual([])
  })
})

describe('exported step-name constants are valid step ids', () => {
  it('SPEC_VERIFY_CMD_STEP produces a valid step id once review.ts prefixes it', () => {
    expect(SPEC_VERIFY_CMD_STEP).toBe('spec-verify-cmd')
    expect(asStepId(`verify:${SPEC_VERIFY_CMD_STEP}`)).toBe('verify:spec-verify-cmd')
  })

  it('a timed-out spec-verify step names the step instead of collapsing to unknown', () => {
    // The exact marker runVerifyStep writes when the per-step wall-clock
    // timeout fires. This is the observed production failure, end to end.
    const timeout = 'verify child timed out after 900000ms (exit null)\nsome partial output'
    expect(computeFailureSignature(`verify:${SPEC_VERIFY_CMD_STEP}`, timeout)).toBe(
      'verify:timeout/spec-verify-cmd',
    )
  })

  it('an abort-signal kill of the spec-verify step also keeps the step name', () => {
    // Secondary path: runVerifyStep prefixes an outer-abort kill with
    // `step killed by abort signal`. It has no dedicated override branch, so
    // it falls through to `<step>/<errorClass>` — which is only useful while
    // the step id satisfies the grammar. Under the old `spec.verifyCmd` name
    // this signed as `unknown/<errorClass>`, dropping the step exactly like
    // the timeout branch did.
    const aborted = 'step killed by abort signal\n'
    const sig = computeFailureSignature(`verify:${SPEC_VERIFY_CMD_STEP}`, aborted)
    expect(sig.startsWith('verify:spec-verify-cmd/')).toBe(true)
    expect(sig.startsWith('unknown/')).toBe(false)
  })
})
