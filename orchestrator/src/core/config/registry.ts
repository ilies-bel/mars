/**
 * The registry of every Mars **Port** — a swappable module boundary bound to
 * an async TypeScript interface whose arguments and results are plain
 * serializable data (ADR-0097 "Every seam is a cordis service Port with
 * serializable contracts"). Each entry names a Port, the env var that
 * selects its active implementation, and the catalog of implementation
 * kinds currently registered for it.
 *
 * This module is the **shared contract** between four consumer slices:
 *
 *   1. **"Generated configuration reference doc"** — renders
 *      {@link loadPortRegistry}/{@link formatPortRegistry} output into the
 *      project's config reference doc, so every Port and its selectable
 *      implementations are documented from one source instead of drifting
 *      prose.
 *   2. **"Remote Verifier adapter over HTTP"** — registers the `remote-http`
 *      implementation kind under the `verifier` Port entry.
 *   3. **"CodeIndex port: interface plus none and codegraph
 *      implementations"** — registers the `codeIndex` Port entry with its
 *      `none` and `codegraph` implementation kinds.
 *   4. **"VCS port: interface plus local git implementation"** — registers
 *      the `vcs` Port entry with its `local-git` implementation kind.
 *
 * Each consumer slice owns its Port's actual TypeScript interface (the
 * method-level contract, e.g. `CodeIndexPort.query(...)`) and the
 * implementation modules themselves — this registry only carries the
 * catalog metadata needed to select and document an implementation. Callers
 * resolve which implementation kind is active via {@link resolvePortKind};
 * they never import a concrete implementation directly (ADR-0097).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every Port currently registered. Hard cut per project policy: add a
 * literal here (and a matching {@link PORT_REGISTRY} entry) the same change
 * a Port lands — never leave a Port undeclared "for now".
 */
export const PORT_NAMES = ['verifier', 'codeIndex', 'vcs'] as const
export type PortName = (typeof PORT_NAMES)[number]

/** One selectable implementation of a Port. */
export interface PortImplementationEntry {
  /** Stable identifier selected via the owning Port's `envVar`, e.g. `'local-git'`. */
  kind: string
  /** One-line human description rendered into the config reference doc. */
  description: string
  /**
   * True when this implementation is an out-of-process adapter (e.g. an
   * HTTP call to a remote service) rather than an in-process wrapper around
   * existing code. Purely descriptive — the wire protocol itself stays
   * confined to the implementation module (ADR-0097).
   */
  remote?: boolean
  /**
   * Additional env vars this implementation reads beyond the owning Port's
   * `envVar` (e.g. a remote adapter's target URL or auth token). Listed here
   * only so the config reference doc can enumerate them; this registry does
   * not read or validate their values.
   */
  envVars?: readonly string[]
}

/** A Port and the catalog of implementation kinds registered for it. */
export interface PortRegistryEntry {
  port: PortName
  /** One-line description of what this Port abstracts. */
  description: string
  /** Env var whose value selects the active implementation kind. */
  envVar: string
  /** Implementation kind used when `envVar` is unset. Must appear in `implementations`. */
  defaultKind: string
  implementations: readonly PortImplementationEntry[]
}

// ---------------------------------------------------------------------------
// Zod schemas (validation + serialization)
// ---------------------------------------------------------------------------

/**
 * Schema for {@link PortImplementationEntry}. Reused by adapter
 * implementations (e.g. the remote-http Verifier) that need to validate a
 * serialized implementation descriptor at a process boundary.
 */
export const portImplementationSchema = z.object({
  kind: z.string().min(1),
  description: z.string().min(1),
  remote: z.boolean().optional(),
  envVars: z.array(z.string().min(1)).optional(),
})

/** Schema for {@link PortRegistryEntry}. */
export const portRegistryEntrySchema = z.object({
  port: z.enum(PORT_NAMES),
  description: z.string().min(1),
  envVar: z.string().min(1),
  defaultKind: z.string().min(1),
  implementations: z.array(portImplementationSchema).min(1),
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: readonly PortRegistryEntry[] = [
  {
    port: 'verifier',
    description: "Runs a task's verify command and reports pass/fail.",
    envVar: 'MARS_VERIFIER_KIND',
    defaultKind: 'local',
    implementations: [
      {
        kind: 'local',
        description: 'Runs the verify command in-process in the task worktree.',
      },
      {
        kind: 'remote-http',
        description: 'Delegates verification to a remote HTTP service (e.g. CI).',
        remote: true,
        envVars: ['MARS_VERIFIER_REMOTE_URL', 'MARS_VERIFIER_REMOTE_TOKEN', 'MARS_VERIFIER_REMOTE_TIMEOUT_MS'],
      },
    ],
  },
  {
    port: 'codeIndex',
    description: 'Answers code-intelligence queries (symbol lookup, callers/callees) for a repo.',
    envVar: 'MARS_CODE_INDEX_KIND',
    defaultKind: 'none',
    implementations: [
      {
        kind: 'none',
        description: 'No code index available; queries return an explicit unsupported result.',
      },
      {
        kind: 'codegraph',
        description: 'Delegates to the codegraph CLI/MCP server.',
      },
    ],
  },
  {
    port: 'vcs',
    description: 'Version-control operations (diff, commit, branch, worktree) for a task.',
    envVar: 'MARS_VCS_KIND',
    defaultKind: 'local-git',
    implementations: [
      {
        kind: 'local-git',
        description: 'Shells out to the local git binary.',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the full Port registry. Returns a shallow copy so callers cannot
 * mutate the internal catalog.
 */
export function loadPortRegistry(): PortRegistryEntry[] {
  return [...REGISTRY]
}

/**
 * Returns the registry entry for `port`. Throws if the Port is undeclared —
 * every {@link PortName} must have a matching entry, so a miss here means
 * the registry and the `PortName` union have drifted apart.
 */
export function getPortRegistryEntry(port: PortName): PortRegistryEntry {
  const entry = REGISTRY.find((e) => e.port === port)
  if (!entry) throw new Error(`No Port registry entry for "${port}"`)
  return entry
}

/**
 * Resolves the active implementation kind for `port` from `env` (typically
 * `process.env`): the Port's `envVar` value when set and valid, else its
 * `defaultKind`.
 *
 * Throws when `envVar` is set to a kind not registered under this Port —
 * silently falling back to the default would mask a misconfiguration (e.g.
 * a typo'd `MARS_VCS_KIND=locla-git`) instead of surfacing it.
 */
export function resolvePortKind(port: PortName, env: Record<string, string | undefined>): string {
  const entry = getPortRegistryEntry(port)
  const requested = env[entry.envVar]
  if (requested === undefined || requested === '') return entry.defaultKind
  const known = entry.implementations.some((impl) => impl.kind === requested)
  if (!known) {
    const valid = entry.implementations.map((impl) => impl.kind).join(', ')
    throw new Error(`${entry.envVar}="${requested}" is not a registered implementation of Port "${port}" (valid: ${valid})`)
  }
  return requested
}

/**
 * Renders the Port registry as Markdown for inclusion in the generated
 * configuration reference doc: one section per Port, listing its
 * description, selector env var, default, and every registered
 * implementation with its own description and any extra env vars it reads.
 *
 * Accepts the full registry (from {@link loadPortRegistry}) or any subset.
 */
export function formatPortRegistry(entries: PortRegistryEntry[]): string {
  if (entries.length === 0) return '_(no Ports in registry)_\n'
  const sections = entries.map((e) => {
    const implLines = e.implementations.map((impl) => {
      const remote = impl.remote ? ' _(remote)_' : ''
      const extraEnv = impl.envVars?.length ? ` — reads: ${impl.envVars.map((v) => `\`${v}\``).join(', ')}` : ''
      const isDefault = impl.kind === e.defaultKind ? ' (default)' : ''
      return `  - \`${impl.kind}\`${isDefault}${remote}: ${impl.description}${extraEnv}`
    })
    return [`### ${e.port}`, '', e.description, '', `Selector env var: \`${e.envVar}\``, '', 'Implementations:', ...implLines].join('\n')
  })
  return sections.join('\n\n') + '\n'
}
