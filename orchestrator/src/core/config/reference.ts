/**
 * Builds the operator-facing config reference (`docs/reference/configuration.md`)
 * from the `ENV_KNOBS` registry (`./env-registry.ts`). Shared by:
 *
 *   - `scripts/gen-config-reference.mjs` (repo root) — writes the file, via
 *     `npm run docs:config` (see `../../../package.json`).
 *   - `__tests__/reference-drift.test.ts` — regenerates in memory and fails
 *     the suite if it disagrees with the committed file, mirroring the
 *     `template-sync-check` CI pattern for the bundled `.claude/` templates.
 *
 * Kept dependency-free (no filesystem access) so both callers can reuse the
 * exact same generation logic without duplicating it.
 */
import type { EnvKnob } from './env-registry'

/**
 * Thrown when a knob in the registry has no (or a blank) `description`.
 * A knob is operator-facing the moment it exists in `ENV_KNOBS`, so an
 * undocumented knob must fail generation loudly rather than render a blank
 * cell in the reference table.
 */
export class MissingKnobDescriptionError extends Error {
  constructor(public readonly knobName: string) {
    super(
      `ENV_KNOBS entry '${knobName}' has no description; add one in ` +
        `src/core/config/env-registry.ts before regenerating the config reference.`,
    )
    this.name = 'MissingKnobDescriptionError'
  }
}

/**
 * Best-effort human label for the value type a knob resolves to. Derived
 * from `knob.default` (not the raw env-parsing `schema`, which is always a
 * string-input `ZodTypeAny` — see `EnvKnob.schema`'s JSDoc) because the
 * default is already the *output* type every schema in the registry parses
 * to, and that is what an operator setting the knob in `daemon.json` or the
 * env actually cares about.
 */
const describeType = (value: unknown): string => {
  const jsType = typeof value
  switch (jsType) {
    case 'boolean':
    case 'number':
    case 'string':
      return jsType
    default:
      return jsType
  }
}

const formatDefault = (value: unknown): string =>
  typeof value === 'string' ? `\`${JSON.stringify(value)}\`` : `\`${String(value)}\``

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * Renders the full markdown reference for `knobs`. Throws
 * `MissingKnobDescriptionError` on the first knob missing a description
 * instead of silently rendering a blank cell.
 */
export const buildConfigReferenceMarkdown = (knobs: readonly EnvKnob[]): string => {
  for (const knob of knobs) {
    if (typeof knob.description !== 'string' || knob.description.trim().length === 0) {
      throw new MissingKnobDescriptionError(knob.name)
    }
  }

  const rows = knobs.map((knob) => {
    const type = describeType(knob.default)
    const def = formatDefault(knob.default)
    return `| \`${knob.name}\` | \`${knob.path}\` | ${type} | ${def} | ${escapeCell(knob.description)} |`
  })

  return `<!-- GENERATED FILE — do not edit by hand.
Run \`npm run docs:config\` (from orchestrator/) to regenerate from the
\`ENV_KNOBS\` registry in \`orchestrator/src/core/config/env-registry.ts\`. -->

# Configuration reference

Every \`MARS_*\` environment variable Mars reads, the \`daemon.json\` field it
overrides, its resolved type, its built-in default, and what it controls.
Generated from \`ENV_KNOBS\` — this table cannot drift from the knobs Mars
actually resolves because it is generated, not hand-maintained. A CI-style
test (\`orchestrator/src/core/config/__tests__/reference-drift.test.ts\`)
regenerates it and fails if this file disagrees.

| Env var | daemon.json path | Type | Default | Description |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`
}
