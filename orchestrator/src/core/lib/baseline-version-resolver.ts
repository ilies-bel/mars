/**
 * Deterministic version resolution for the baseline repair actor
 * ({@link module:./baseline-repair}).
 *
 * ## Why this exists
 *
 * `baseline-repair.ts`'s repair-agent prompt can identify a defect class
 * ("a version pin that was never published") and locate the manifest that
 * carries it, but picking the REPLACEMENT version number is a different kind
 * of decision — one with a mechanical, human-obvious answer: resolve to the
 * nearest existing published version that satisfies the intent, preferring a
 * version that sibling packages in the same repo already pin. Handing that
 * decision to a free-form agent means the version number that lands on the
 * integration branch is whatever the agent happened to guess — unverifiable
 * and untestable.
 *
 * This module is the deterministic algorithm instead. It is pure (no git, no
 * filesystem, no network) so its output can be asserted directly in a test:
 * given a requested range, the ranges sibling manifests already pin, and the
 * versions actually published, it returns exactly one answer or explicitly
 * refuses to guess.
 *
 * `baseline-repair.ts` is the only caller: it parses the offending
 * package/range out of the probe's failure output with
 * {@link parseUnsatisfiablePin}, gathers sibling pins and published versions
 * via its injected deps, calls {@link resolveManifestVersion}, and — only on
 * a `'resolved'` outcome — rewrites the manifest with
 * {@link replaceDependencyRange}. An `'unresolved'` outcome always escalates;
 * the repair-agent is never invoked to guess a version number for this
 * defect class.
 */

// ---------------------------------------------------------------------------
// Detecting the defect
// ---------------------------------------------------------------------------

export interface UnsatisfiablePin {
  /** The dependency name, including scope (`@types/react-dom`). */
  packageName: string
  /** The manifest range as written in package.json (`^18.3.18`). */
  range: string
}

/** Strip a trailing period/comma/semicolon a prose error message tacked on. */
const stripTrailingPunctuation = (s: string): string => s.replace(/[.,;:]+$/, '')

/**
 * Parse an npm/pnpm "No matching version found for X@Y" failure, or the
 * yarn-classic "Couldn't find any versions for "X" that matches "Y"" failure,
 * out of a frozen-install's combined stdout/stderr.
 *
 * Returns `null` when the output does not name an unsatisfiable version pin
 * at all — this is how `baseline-repair.ts` tells "this install failure is a
 * manifest version-pin defect" from every other install failure class (a
 * genuinely drifted lockfile, a network error, a missing registry entry for
 * an unrelated reason), which continue through the existing free-form
 * repair-agent path unchanged.
 */
export const parseUnsatisfiablePin = (output: string): UnsatisfiablePin | null => {
  // npm and pnpm share the exact phrase "No matching version found for X@Y"
  // (npm: `notarget`/`ETARGET`; pnpm: `ERR_PNPM_NO_MATCHING_VERSION`). The
  // package-name group handles a scoped name (`@types/react-dom`) by
  // requiring a single `/` before the version-separating `@`.
  const npmOrPnpm = /No matching version found for (@[^\s/]+\/[^\s@]+|[^\s@]+)@(\S+)/.exec(output)
  if (npmOrPnpm && npmOrPnpm[1] && npmOrPnpm[2]) {
    return {
      packageName: npmOrPnpm[1],
      range: stripTrailingPunctuation(npmOrPnpm[2]),
    }
  }

  const yarn = /Couldn't find any versions for "([^"]+)" that matches "([^"]+)"/.exec(output)
  if (yarn && yarn[1] && yarn[2]) {
    return { packageName: yarn[1], range: yarn[2] }
  }

  return null
}

// ---------------------------------------------------------------------------
// Minimal semver — just enough for manifest pins (exact, `^`, `~`)
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

/** Parse a bare version string (`1.2.3`, optionally `v`-prefixed). */
export const parseVersion = (raw: string): ParsedVersion | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  if (!m || !m[1] || !m[2] || !m[3]) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export const compareVersions = (a: ParsedVersion, b: ParsedVersion): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch

export const versionToString = (v: ParsedVersion): string => `${v.major}.${v.minor}.${v.patch}`

export type RangeOperator = '^' | '~' | ''

export interface ParsedRange {
  operator: RangeOperator
  base: ParsedVersion
}

/** Parse a manifest range (`^1.2.3`, `~1.2.3`, `1.2.3`). Returns `null` for anything else. */
export const parseRange = (raw: string): ParsedRange | null => {
  const trimmed = raw.trim()
  const operator: RangeOperator = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : ''
  const base = parseVersion(operator ? trimmed.slice(1) : trimmed)
  if (!base) return null
  return { operator, base }
}

export const rangeToString = (operator: RangeOperator, version: ParsedVersion): string =>
  `${operator}${versionToString(version)}`

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export type VersionResolution =
  | {
      status: 'resolved'
      /** The replacement range to write into the manifest, e.g. `^18.3.5`. */
      range: string
      /** Why this range was chosen — surfaced in the commit/escalation detail. */
      source: 'sibling-pin' | 'nearest-published'
    }
  | { status: 'unresolved' }

/**
 * Resolve an unsatisfiable manifest pin to a concrete replacement range.
 *
 * Two-tier, in priority order — both grounded in {@link publishedVersions},
 * never a guess:
 *
 *   1. **Sibling pin.** If any OTHER manifest in the repo already pins this
 *      package to a version that is actually published, use that range
 *      verbatim. This is the common case: a version bump landed in one
 *      manifest but not the N others, and the N others are correct.
 *   2. **Nearest published.** Otherwise, pick the published version with the
 *      smallest weighted (major, minor, patch) distance to the requested
 *      version, preferring the LOWER version on a tie (older is the safer
 *      default when two versions are equidistant).
 *
 * Returns `{ status: 'unresolved' }` — never a guess — when neither tier
 * produces an answer: no sibling pin resolves to a published version, AND
 * either no published versions are known or the requested range itself does
 * not parse as a version-shaped string.
 */
export const resolveManifestVersion = (args: {
  requestedRange: string
  siblingRanges: readonly string[]
  publishedVersions: readonly string[]
}): VersionResolution => {
  const published = args.publishedVersions
    .map((raw) => ({ raw, parsed: parseVersion(raw) }))
    .filter((v): v is { raw: string; parsed: ParsedVersion } => v.parsed !== null)

  // Tier 1 — sibling pin, in first-seen order so the result is deterministic
  // regardless of Set/Map iteration quirks upstream.
  const seenSiblingRanges = [...new Set(args.siblingRanges)]
  for (const siblingRaw of seenSiblingRanges) {
    const sibling = parseRange(siblingRaw)
    if (!sibling) continue
    const isPublished = published.some((p) => compareVersions(p.parsed, sibling.base) === 0)
    if (isPublished) {
      return { status: 'resolved', range: rangeToString(sibling.operator, sibling.base), source: 'sibling-pin' }
    }
  }

  // Tier 2 — nearest published version to the requested target.
  const requested = parseRange(args.requestedRange)
  if (!requested || published.length === 0) return { status: 'unresolved' }

  let best: { parsed: ParsedVersion; distance: number } | null = null
  for (const candidate of published) {
    const distance =
      Math.abs(candidate.parsed.major - requested.base.major) * 1_000_000 +
      Math.abs(candidate.parsed.minor - requested.base.minor) * 1_000 +
      Math.abs(candidate.parsed.patch - requested.base.patch)
    const better =
      best === null ||
      distance < best.distance ||
      (distance === best.distance && compareVersions(candidate.parsed, best.parsed) < 0)
    if (better) best = { parsed: candidate.parsed, distance }
  }
  if (best === null) return { status: 'unresolved' }
  return { status: 'resolved', range: rangeToString(requested.operator, best.parsed), source: 'nearest-published' }
}

// ---------------------------------------------------------------------------
// Applying the resolution to a manifest
// ---------------------------------------------------------------------------

const MANIFEST_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/**
 * The range a `package.json` pins for `packageName`, checked across every
 * standard dependency field in order. `undefined` when the manifest does not
 * mention the package (or does not parse as JSON) at all.
 */
export const findDependencyRange = (manifestJson: string, packageName: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  for (const field of MANIFEST_DEPENDENCY_FIELDS) {
    const map = (parsed as Record<string, unknown>)[field]
    if (typeof map !== 'object' || map === null) continue
    const value = (map as Record<string, unknown>)[packageName]
    if (typeof value === 'string') return value
  }
  return undefined
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrite `packageName`'s pinned range from `oldRange` to `newRange` in a
 * manifest's raw text, touching only that one value — not a
 * parse-and-`JSON.stringify` round trip, which would reformat the whole file
 * (key order, indentation) and blow the diff-size cap on an unrelated line
 * count. Throws if the exact `"packageName": "oldRange"` pair is not found,
 * so a caller never silently no-ops a resolution it believed it applied.
 */
export const replaceDependencyRange = (
  manifestJson: string,
  packageName: string,
  oldRange: string,
  newRange: string,
): string => {
  const pattern = new RegExp(`("${escapeRegExp(packageName)}"\\s*:\\s*")${escapeRegExp(oldRange)}(")`)
  const next = manifestJson.replace(pattern, `$1${newRange}$2`)
  if (next === manifestJson) {
    throw new Error(`could not find "${packageName}": "${oldRange}" in manifest to replace`)
  }
  return next
}
