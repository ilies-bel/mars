/**
 * Mars id value object.
 *
 * A Mars id frames an entity (`task` or `proposal`) so an agent can read the
 * kind directly from a pasted id. The bare hex is the canonical identity:
 * equality is on the hex alone, the kind/slug are presentation framing.
 *
 * Four user-facing input shapes are accepted by `parseMarsId`:
 *   1. Full rendered form         — `mars-task-<hex>` or `mars-proposal-<hex>-<slug>`
 *   2. Prefix without slug        — `mars-proposal-<hex>` (no trailing slug)
 *   3. Bare hex                   — `<hex>` (8 chars, kind unknown)
 *   4. Hex prefix (partial)       — `<hex-prefix>` (1–7 chars, partial lookup)
 *
 * Shapes 1 and 2 carry the kind and parse to a `MarsId` (always-complete).
 * Shapes 3 and 4 omit the kind and parse to a `MarsIdPrefix` (lookup shape).
 * The two types are distinct: a `MarsIdPrefix` cannot be rendered as a
 * final user-facing id, so downstream call sites cannot accidentally
 * concatenate a `mars-<kind>-` framing around a partial value.
 *
 * Nothing else in the codebase reads from this module yet — this slice
 * exists so subsequent slices stop building `mars-<kind>-` prefixes by
 * hand.
 */

const KINDS = ['task', 'proposal'] as const
export type MarsIdKind = (typeof KINDS)[number]

const HEX_RE = /^[0-9a-f]+$/
const FULL_HEX_LEN = 8
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isKind(value: string): value is MarsIdKind {
  return (KINDS as readonly string[]).includes(value)
}

function isFullHex(value: string): boolean {
  return value.length === FULL_HEX_LEN && HEX_RE.test(value)
}

/**
 * A complete Mars id: a kind, the 8-hex identity, and (for proposals) an
 * optional slug. Always-complete: every instance can be rendered to its
 * user-facing form.
 */
export class MarsId {
  private constructor(
    readonly kind: MarsIdKind,
    readonly hex: string,
    readonly slug?: string,
  ) {}

  static create(kind: MarsIdKind, hex: string, slug?: string): MarsId {
    if (!isKind(kind)) {
      throw new Error(`MarsId: unknown kind '${kind}'`)
    }
    if (!isFullHex(hex)) {
      throw new Error(`MarsId: invalid hex '${hex}' (need ${FULL_HEX_LEN} hex chars)`)
    }
    if (slug !== undefined && !SLUG_RE.test(slug)) {
      throw new Error(`MarsId: invalid slug '${slug}'`)
    }
    return new MarsId(kind, hex, slug)
  }

  /** User-facing rendered form. */
  toString(): string {
    const base = `mars-${this.kind}-${this.hex}`
    return this.slug ? `${base}-${this.slug}` : base
  }

  /** Equality is on the bare hex alone — kind and slug are framing. */
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
   * `mars-<kind>-` form so a prefix cannot be mistaken for a final id
   * via implicit string coercion.
   */
  toString(): string {
    return `[MarsIdPrefix ${this.hex}]`
  }
}

export type MarsIdParseErrorCode =
  | 'EMPTY'
  | 'MALFORMED'
  | 'UNKNOWN_KIND'
  | 'INVALID_HEX'
  | 'INVALID_SLUG'

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

const MARS_PREFIX = 'mars-'

/**
 * Parse a user-facing Mars id input into either a complete `MarsId` or a
 * `MarsIdPrefix`. Returns a typed error on any malformed input — never a
 * partial value.
 */
export function parseMarsId(input: string): ParsedMarsId {
  if (input.length === 0) {
    return {
      ok: false,
      error: new MarsIdParseError('EMPTY', input, 'empty input'),
    }
  }

  if (input.startsWith(MARS_PREFIX)) {
    return parseKindedForm(input)
  }

  // No `mars-` framing → must be either a full bare hex or a hex prefix.
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

function parseKindedForm(input: string): ParsedMarsId {
  const rest = input.slice(MARS_PREFIX.length)

  let matchedKind: MarsIdKind | null = null
  let afterKind = ''
  for (const k of KINDS) {
    const tag = `${k}-`
    if (rest.startsWith(tag)) {
      matchedKind = k
      afterKind = rest.slice(tag.length)
      break
    }
  }
  if (matchedKind === null) {
    return {
      ok: false,
      error: new MarsIdParseError(
        'UNKNOWN_KIND',
        input,
        `unknown kind in '${input}' (expected one of: ${KINDS.join(', ')})`,
      ),
    }
  }

  // `afterKind` is either `<hex>` or `<hex>-<slug>`.
  const dashIdx = afterKind.indexOf('-')
  const hex = dashIdx === -1 ? afterKind : afterKind.slice(0, dashIdx)
  const slug = dashIdx === -1 ? undefined : afterKind.slice(dashIdx + 1)

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
  if (slug !== undefined && !SLUG_RE.test(slug)) {
    return {
      ok: false,
      error: new MarsIdParseError(
        'INVALID_SLUG',
        input,
        `invalid slug '${slug}' in '${input}'`,
      ),
    }
  }

  return { ok: true, kind: 'id', value: MarsId.create(matchedKind, hex, slug) }
}
