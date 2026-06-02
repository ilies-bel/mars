import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  type StackDetection,
  type SupervisorKind,
  type SupervisorSpec,
} from './detect-stack'

/**
 * Declarative `mars init -f <config>` support.
 *
 * Instead of walking the repo and heuristically detecting tech stacks, the
 * operator hands `mars init` a TOML file that names each tech-bearing folder
 * and the technology it hosts. This is the escape hatch for layouts the
 * auto-detector cannot express — most notably monorepos where a packaging
 * manifest at the root nests over per-package manifests, which the walker
 * rejects as nested-tech stacking.
 *
 * Config shape (TOML):
 *
 *   [[stack]]
 *   path = "gateway"      # repo-relative dir; "." or "" means the repo root
 *   tech = "node-backend" # one of TECH_CATALOGUE keys below
 *
 *   [[stack]]
 *   path = "dashboard"
 *   tech = "react"
 *
 * Each entry maps to exactly one SupervisorSpec via TECH_CATALOGUE, which
 * mirrors the supervisor names / kinds / external slugs the heuristic
 * detector in detect-stack.ts would have produced for the same tech.
 */

interface CatalogueEntry {
  supervisor: string
  kind: SupervisorKind
  externalSlugs: string[]
  /** Coarse bucket so the StackDetection summary fields stay populated. */
  bucket: 'languages' | 'frameworks' | 'infra' | 'mobile' | 'specialized'
  /** Extra tech tags attached to the supervisor's `techs` list. */
  techs: string[]
}

/**
 * Canonical tech → supervisor mapping. Keys are the accepted `tech` values in
 * a config file. Kept deliberately in lock-step with detect-stack.ts: any
 * tech the auto-detector can emit a supervisor for should be expressible here
 * by the same name, so a hand-written config produces the same supervisor a
 * successful auto-detect would have.
 */
export const TECH_CATALOGUE: Record<string, CatalogueEntry> = {
  react: {
    supervisor: 'react-supervisor',
    kind: 'frontend',
    externalSlugs: ['react-specialist', 'frontend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'react'],
  },
  nextjs: {
    supervisor: 'react-supervisor',
    kind: 'frontend',
    externalSlugs: ['nextjs-developer', 'react-specialist', 'frontend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'nextjs', 'react'],
  },
  vue: {
    supervisor: 'vue-supervisor',
    kind: 'frontend',
    externalSlugs: ['vue-specialist', 'frontend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'vue'],
  },
  nuxt: {
    supervisor: 'vue-supervisor',
    kind: 'frontend',
    externalSlugs: ['nuxt-developer', 'vue-specialist', 'frontend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'nuxt', 'vue'],
  },
  svelte: {
    supervisor: 'svelte-supervisor',
    kind: 'frontend',
    externalSlugs: ['svelte-developer', 'frontend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'svelte'],
  },
  angular: {
    supervisor: 'angular-supervisor',
    kind: 'frontend',
    externalSlugs: ['angular-architect', 'angular-developer', 'frontend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'angular'],
  },
  'node-backend': {
    supervisor: 'node-backend-supervisor',
    kind: 'backend',
    externalSlugs: ['nodejs-developer', 'backend-developer'],
    bucket: 'frameworks',
    techs: ['javascript', 'node', 'node-backend'],
  },
  'python-backend': {
    supervisor: 'python-backend-supervisor',
    kind: 'backend',
    externalSlugs: [
      'python-developer',
      'fastapi-developer',
      'django-developer',
      'backend-developer',
    ],
    bucket: 'frameworks',
    techs: ['python', 'python-backend'],
  },
  go: {
    supervisor: 'go-supervisor',
    kind: 'backend',
    externalSlugs: ['golang-pro', 'go-developer', 'backend-developer'],
    bucket: 'languages',
    techs: ['go'],
  },
  rust: {
    supervisor: 'rust-supervisor',
    kind: 'backend',
    externalSlugs: ['rust-engineer', 'rust-developer', 'backend-developer'],
    bucket: 'languages',
    techs: ['rust'],
  },
  'jvm-backend': {
    supervisor: 'jvm-backend-supervisor',
    kind: 'backend',
    externalSlugs: ['java-developer', 'kotlin-developer', 'backend-developer'],
    bucket: 'frameworks',
    techs: ['jvm', 'gradle'],
  },
  flutter: {
    supervisor: 'flutter-supervisor',
    kind: 'mobile',
    externalSlugs: ['flutter-expert', 'mobile-developer'],
    bucket: 'mobile',
    techs: ['flutter'],
  },
  ios: {
    supervisor: 'ios-supervisor',
    kind: 'mobile',
    externalSlugs: ['ios-developer', 'mobile-developer'],
    bucket: 'mobile',
    techs: ['ios'],
  },
  android: {
    supervisor: 'android-supervisor',
    kind: 'mobile',
    externalSlugs: ['android-developer', 'mobile-developer'],
    bucket: 'mobile',
    techs: ['android'],
  },
  infra: {
    supervisor: 'infra-supervisor',
    kind: 'infra',
    externalSlugs: ['devops-engineer', 'platform-engineer', 'sre-engineer'],
    bucket: 'infra',
    techs: ['docker'],
  },
  web3: {
    supervisor: 'blockchain-supervisor',
    kind: 'specialized',
    externalSlugs: ['blockchain-developer', 'web3-developer'],
    bucket: 'specialized',
    techs: ['web3'],
  },
  ml: {
    supervisor: 'ml-supervisor',
    kind: 'specialized',
    externalSlugs: ['machine-learning-engineer', 'ai-engineer', 'data-engineer'],
    bucket: 'specialized',
    techs: ['python', 'ml'],
  },
}

const PERSONAS: Record<string, string> = {
  'python-backend-supervisor': 'Tessa',
  'node-backend-supervisor': 'Nina',
  'jvm-backend-supervisor': 'Jade',
  'go-supervisor': 'Grace',
  'rust-supervisor': 'Ruby',
  'react-supervisor': 'Luna',
  'vue-supervisor': 'Violet',
  'svelte-supervisor': 'Sage',
  'angular-supervisor': 'Aria',
  'infra-supervisor': 'Olive',
  'flutter-supervisor': 'Maya',
  'ios-supervisor': 'Isla',
  'android-supervisor': 'Ava',
  'blockchain-supervisor': 'Nova',
  'ml-supervisor': 'Iris',
  'baseline-supervisor': 'Echo',
}

export class InitConfigError extends Error {
  configPath: string

  constructor(configPath: string, detail: string) {
    super(`invalid init config at "${configPath}": ${detail}`)
    this.name = 'InitConfigError'
    this.configPath = configPath
  }
}

interface RawStackEntry {
  path?: unknown
  tech?: unknown
}

const KNOWN_TECHS = Object.keys(TECH_CATALOGUE).sort().join(', ')

const normalizeScope = (rawPath: string): string => {
  const trimmed = rawPath.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '.') return '.'
  return trimmed
}

/**
 * Parse and validate a TOML init config into a StackDetection, ready to feed
 * the render/write steps in place of `detectStack`. Throws InitConfigError on
 * any structural or value problem.
 */
export const loadInitConfig = (
  configPath: string,
  repoRoot: string,
): StackDetection => {
  const abs = resolve(repoRoot, configPath)

  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    throw new InitConfigError(abs, `cannot read file: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch (err) {
    throw new InitConfigError(abs, `TOML parse error: ${(err as Error).message}`)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new InitConfigError(abs, 'top level must be a table')
  }

  const stackRaw = (parsed as Record<string, unknown>).stack
  if (!Array.isArray(stackRaw) || stackRaw.length === 0) {
    throw new InitConfigError(
      abs,
      'expected at least one [[stack]] entry with `path` and `tech`',
    )
  }

  const languages = new Set<string>()
  const frameworks = new Set<string>()
  const infra = new Set<string>()
  const mobile = new Set<string>()
  const specialized = new Set<string>()
  const supervisors: SupervisorSpec[] = []
  const seenSupervisor = new Map<string, SupervisorSpec>()
  const seenScopeTech = new Set<string>()
  const manifests: StackDetection['manifests'] = []

  const bucketSet = (
    bucket: CatalogueEntry['bucket'],
  ): Set<string> => {
    switch (bucket) {
      case 'languages':
        return languages
      case 'frameworks':
        return frameworks
      case 'infra':
        return infra
      case 'mobile':
        return mobile
      case 'specialized':
        return specialized
    }
  }

  stackRaw.forEach((entryRaw, i) => {
    if (typeof entryRaw !== 'object' || entryRaw === null) {
      throw new InitConfigError(abs, `[[stack]] #${i + 1} must be a table`)
    }
    const entry = entryRaw as RawStackEntry
    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new InitConfigError(
        abs,
        `[[stack]] #${i + 1} requires a non-empty string \`path\``,
      )
    }
    if (typeof entry.tech !== 'string' || entry.tech.trim() === '') {
      throw new InitConfigError(
        abs,
        `[[stack]] #${i + 1} requires a non-empty string \`tech\``,
      )
    }

    const tech = entry.tech.trim()
    const cat = TECH_CATALOGUE[tech]
    if (!cat) {
      throw new InitConfigError(
        abs,
        `[[stack]] #${i + 1} has unknown tech "${tech}"; known: ${KNOWN_TECHS}`,
      )
    }

    const scope = normalizeScope(entry.path)
    const scopeTechKey = `${scope} ${tech}`
    if (seenScopeTech.has(scopeTechKey)) {
      throw new InitConfigError(
        abs,
        `duplicate [[stack]] entry for path "${scope}" + tech "${tech}"`,
      )
    }
    seenScopeTech.add(scopeTechKey)

    const prefix = scope === '.' ? '' : `${scope}/`
    bucketSet(cat.bucket).add(tech)
    for (const t of cat.techs) {
      // Mirror the detector's broad language tagging in the summary buckets.
      if (t === 'javascript' || t === 'typescript' || t === 'python' || t === 'go' || t === 'rust') {
        languages.add(t)
      }
    }

    const detectedFrom = `${prefix}mars.init:${tech}`
    const existing = seenSupervisor.get(cat.supervisor)
    if (existing) {
      // Same supervisor reused for another folder — merge detectedFrom and
      // techs rather than emitting a duplicate.
      if (!existing.detectedFrom.includes(detectedFrom)) {
        existing.detectedFrom.push(detectedFrom)
      }
      for (const t of cat.techs) {
        if (!existing.techs.includes(t)) existing.techs.push(t)
      }
      existing.techs.sort()
    } else {
      const spec: SupervisorSpec = {
        name: cat.supervisor,
        persona: PERSONAS[cat.supervisor] ?? 'Echo',
        kind: cat.kind,
        // Infra supervisors are conventionally repo-wide ('.'), matching the
        // heuristic detector; everything else is scoped to its declared path.
        scope: cat.kind === 'infra' ? '.' : scope,
        detectedFrom: [detectedFrom],
        externalSlugs: [...cat.externalSlugs],
        techs: [...cat.techs].sort(),
      }
      seenSupervisor.set(cat.supervisor, spec)
      supervisors.push(spec)
    }

    manifests.push({
      dir: scope,
      techs: [...cat.techs].sort(),
      supervisors: [cat.supervisor],
    })
  })

  return {
    languages: Array.from(languages).sort(),
    frameworks: Array.from(frameworks).sort(),
    infra: Array.from(infra).sort(),
    mobile: Array.from(mobile).sort(),
    specialized: Array.from(specialized).sort(),
    supervisors,
    manifests,
    warnings: [],
  }
}

/** Used only by the verbose detection-report path for nice relative dirs. */
export const relScope = (repoRoot: string, dir: string): string =>
  relative(repoRoot, resolve(repoRoot, dir)) || '.'
