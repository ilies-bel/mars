/**
 * Mars id value object.
 *
 * A Mars id frames an entity with a 4-letter kind tag followed by an
 * 8-hex identity segment: `<tag>-<hex>`, e.g. `task-04830c8e` or
 * `prop-04830c8e`. The full tagged string is the canonical identity.
 *
 * Two user-facing input shapes are accepted by `parseMarsId`:
 *   1. Full tagged form  — `<tag>-<hex>` (e.g. `task-04830c8e`)
 *   2. Hex prefix        — `<hex-prefix>` (1–8 hex chars, prefix-only lookup)
 *
 * Shape 1 carries the kind and parses to a `MarsId` (always-complete).
 * Shape 2 omits the kind and parses to a `MarsIdPrefix` (lookup token only).
 * The two types are distinct: a `MarsIdPrefix` cannot be rendered as a
 * final user-facing id.
 *
 * See `kinds.ts` for the full kind-tag registry and the `genId` helper.
 */

import { KIND_TAGS, type KindTag } from './kinds.js'

// Re-export so consumers can import everything from this barrel.
export { KIND_TAGS, type KindTag } from './kinds.js'
export { genId } from './kinds.js'

/** Build a reverse map: 4-letter tag string → KindTag key. */
const TAG_TO_KIND: Record<string, KindTag> = Object.fromEntries(
  (Object.entries(KIND_TAGS) as [KindTag, string][]).map(([k, v]) => [v, k]),
)

const HEX_RE = /^[0-9a-f]+$/
const FULL_HEX_LEN = 8

function isFullHex(value: string): boolean {
  return value.length === FULL_HEX_LEN && HEX_RE.test(value)
}

/**
 * A complete Mars id: a kind and the 8-hex identity.
 * Always-complete: every instance can be rendered to its user-facing form.
 */
export class MarsId {
  private constructor(
    readonly kind: KindTag,
    readonly hex: string,
  ) {}

  static create(kind: KindTag, hex: string): MarsId {
    if (!(kind in KIND_TAGS)) {
      throw new Error(`MarsId: unknown kind '${kind}'`)
    }
    if (!isFullHex(hex)) {
      throw new Error(`MarsId: invalid hex '${hex}' (need ${FULL_HEX_LEN} hex chars)`)
    }
    return new MarsId(kind, hex)
  }

  /** User-facing rendered form: `<tag>-<hex>`, e.g. `prop-04830c8e`. */
  toString(): string {
    return `${KIND_TAGS[this.kind]}-${this.hex}`
  }

  /** Equality is on the bare hex alone — kind is framing. */
  equals(other: MarsId): boolean {
    return this.hex === other.hex
  }
}

/**
 * A partial lookup shape for a Mars id: a hex prefix of 1–8 chars, with
 * no kind attached. Cannot be rendered as a final id; intended only for
 * prefix-based lookup (e.g. `mars proposal show 0483`).
 */
export class MarsIdPrefix {
  private constructor(readonly hex: string) {}

  static create(hex: string): MarsIdPrefix {
    if (hex.length === 0) {
      throw new Error('MarsIdPrefix: empty hex')
    }
    if (hex.length > FULL_HEX_LEN) {
      throw new Error(`MarsIdPrefix: hex too long '${hex}' (max ${FULL_HEX_LEN})`)
    }
    if (!HEX_RE.test(hex)) {
      throw new Error(`MarsIdPrefix: non-hex chars in '${hex}'`)
    }
    return new MarsIdPrefix(hex)
  }

  /**
   * True iff the target's bare hex starts with this prefix. Accepts a
   * full `MarsId` (matches against `.hex`) or a raw hex string.
   */
  matches(target: MarsId | string): boolean {
    const hex = typeof target === 'string' ? target : target.hex
    return hex.startsWith(this.hex)
  }

  /**
   * Returns a diagnostic, non-id-shaped string. Deliberately not the
   * `<tag>-` form so a prefix cannot be mistaken for a final id
   * via implicit string coercion.
   */
  toString(): string {
    return `[MarsIdPrefix ${this.hex}]`
  }
}

export type MarsIdParseErrorCode = 'EMPTY' | 'MALFORMED' | 'UNKNOWN_KIND' | 'INVALID_HEX'

export class MarsIdParseError extends Error {
  constructor(
    readonly code: MarsIdParseErrorCode,
    readonly input: string,
    message: string,
  ) {
    super(message)
    this.name = 'MarsIdParseError'
  }
}

export type ParsedMarsId =
  | { ok: true; kind: 'id'; value: MarsId }
  | { ok: true; kind: 'prefix'; value: MarsIdPrefix }
  | { ok: false; error: MarsIdParseError }

/**
 * Parse a user-facing Mars id input into either a complete `MarsId` or a
 * `MarsIdPrefix`. Returns a typed error on any malformed input — never a
 * partial value.
 *
 * Accepted shapes:
 *   - `<tag>-<hex>`   e.g. `task-04830c8e`    → MarsId
 *   - `<hex-prefix>`  e.g. `04830c8e` / `0483` → MarsIdPrefix (lookup token)
 *
 * All legacy shapes (mars-<kind>-<hex>, reflect-<hex>, <hex>-<slug>, etc.)
 * are rejected with a typed error — no legacy branches remain.
 */
export function parseMarsId(input: string): ParsedMarsId {
  if (input.length === 0) {
    return {
      ok: false,
      error: new MarsIdParseError('EMPTY', input, 'empty input'),
    }
  }

  const dash = input.indexOf('-')

  if (dash > 0) {
    // Input contains a dash: treat as `<tag>-<hex>`.
    const tag = input.slice(0, dash)
    const hex = input.slice(dash + 1)

    const kind = TAG_TO_KIND[tag]
    if (kind === undefined) {
      return {
        ok: false,
        error: new MarsIdParseError(
          'UNKNOWN_KIND',
          input,
          `unknown kind tag '${tag}' in '${input}' (expected one of: ${Object.values(KIND_TAGS).join(', ')})`,
        ),
      }
    }

    if (!isFullHex(hex)) {
      return {
        ok: false,
        error: new MarsIdParseError(
          'INVALID_HEX',
          input,
          `invalid hex segment '${hex}' in '${input}'`,
        ),
      }
    }

    return { ok: true, kind: 'id', value: MarsId.create(kind, hex) }
  }

  // No dash → must be all-hex chars (prefix lookup).
  if (!HEX_RE.test(input)) {
    return {
      ok: false,
      error: new MarsIdParseError(
        'MALFORMED',
        input,
        `not a recognized Mars id shape: '${input}'`,
      ),
    }
  }
  if (input.length > FULL_HEX_LEN) {
    return {
      ok: false,
      error: new MarsIdParseError(
        'INVALID_HEX',
        input,
        `hex too long: '${input}' (max ${FULL_HEX_LEN})`,
      ),
    }
  }

  return { ok: true, kind: 'prefix', value: MarsIdPrefix.create(input) }
}
