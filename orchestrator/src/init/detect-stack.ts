import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { walkManifests, type DepthCapWarning } from './walk-manifests'

export type SupervisorKind = 'frontend' | 'backend' | 'infra' | 'mobile' | 'specialized'

export interface SupervisorSpec {
  name: string
  persona: string
  kind: SupervisorKind
  scope: string
  detectedFrom: string[]
  externalSlugs: string[]
  /** Sorted, deduplicated, flat list of technologies covering this supervisor's subtree. */
  techs: string[]
}

export interface ManifestFinding {
  dir: string
  techs: string[]
  supervisors: string[]
}

export interface StackDetection {
  languages: string[]
  frameworks: string[]
  infra: string[]
  mobile: string[]
  specialized: string[]
  supervisors: SupervisorSpec[]
  manifests: ManifestFinding[]
  warnings: DepthCapWarning[]
}

const PERSONAS: Record<string, string> = {
  'python-backend-supervisor': 'Tessa',
  'node-backend-supervisor': 'Nina',
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

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const collectDeps = (pkg: Record<string, unknown> | null): Set<string> => {
  const out = new Set<string>()
  if (!pkg) return out
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const block = pkg[key]
    if (block && typeof block === 'object') {
      for (const dep of Object.keys(block as Record<string, unknown>)) {
        out.add(dep)
      }
    }
  }
  return out
}

const hasAny = (deps: Set<string>, names: readonly string[]): boolean =>
  names.some((n) => deps.has(n))

const matchesPython = (text: string, names: readonly string[]): boolean => {
  const lc = text.toLowerCase()
  return names.some((n) => lc.includes(n.toLowerCase()))
}

const scopeFromPrefix = (prefix: string): string =>
  prefix === '' ? '.' : prefix

const buildSpec = (
  name: string,
  kind: SupervisorKind,
  scope: string,
  detectedFrom: string[],
  externalSlugs: string[],
): SupervisorSpec => ({
  name,
  persona: PERSONAS[name] ?? 'Echo',
  kind,
  scope,
  detectedFrom,
  externalSlugs,
  techs: [],
})

interface DirAccumulator {
  languages: Set<string>
  frameworks: Set<string>
  infra: Set<string>
  mobile: Set<string>
  specialized: Set<string>
  supervisors: SupervisorSpec[]
  techs: Set<string>
}

const newAcc = (): DirAccumulator => ({
  languages: new Set(),
  frameworks: new Set(),
  infra: new Set(),
  mobile: new Set(),
  specialized: new Set(),
  supervisors: [],
  techs: new Set(),
})

const detectInDirectory = (dir: string, prefix: string): DirAccumulator => {
  const acc = newAcc()
  const seen = new Set<string>()
  const scope = scopeFromPrefix(prefix)
  const addSupervisor = (spec: SupervisorSpec): void => {
    if (seen.has(spec.name)) return
    seen.add(spec.name)
    acc.supervisors.push(spec)
  }

  const pkg = readJson(resolve(dir, 'package.json'))
  const npmDeps = collectDeps(pkg)

  if (pkg) {
    acc.languages.add('javascript')
    acc.techs.add('javascript')
    acc.techs.add('node')
    if (
      existsSync(resolve(dir, 'tsconfig.json')) ||
      hasAny(npmDeps, ['typescript'])
    ) {
      acc.languages.add('typescript')
      acc.techs.add('typescript')
    }
    if (hasAny(npmDeps, ['@mastra/core', 'mastra'])) acc.techs.add('mastra')
    if (hasAny(npmDeps, ['vite'])) acc.techs.add('vite')
    if (hasAny(npmDeps, ['tailwindcss'])) acc.techs.add('tailwind')
    const bunPlatform = pkg['bun'] !== undefined ||
      hasAny(npmDeps, ['bun-types', '@types/bun'])
    if (bunPlatform || existsSync(resolve(dir, 'bun.lockb')) || existsSync(resolve(dir, 'bun.lock'))) {
      acc.techs.add('bun')
    }

    if (hasAny(npmDeps, ['next'])) {
      acc.frameworks.add('nextjs')
      acc.techs.add('nextjs')
      addSupervisor(
        buildSpec(
          'react-supervisor',
          'frontend',
          scope,
          [`${prefix}package.json:next`],
          ['nextjs-developer', 'react-specialist', 'frontend-developer'],
        ),
      )
    } else if (hasAny(npmDeps, ['react', 'react-dom'])) {
      acc.frameworks.add('react')
      acc.techs.add('react')
      addSupervisor(
        buildSpec(
          'react-supervisor',
          'frontend',
          scope,
          [`${prefix}package.json:react`],
          ['react-specialist', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['nuxt'])) {
      acc.frameworks.add('nuxt')
      acc.techs.add('nuxt')
      addSupervisor(
        buildSpec(
          'vue-supervisor',
          'frontend',
          scope,
          [`${prefix}package.json:nuxt`],
          ['nuxt-developer', 'vue-specialist', 'frontend-developer'],
        ),
      )
    } else if (hasAny(npmDeps, ['vue'])) {
      acc.frameworks.add('vue')
      acc.techs.add('vue')
      addSupervisor(
        buildSpec(
          'vue-supervisor',
          'frontend',
          scope,
          [`${prefix}package.json:vue`],
          ['vue-specialist', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['svelte', '@sveltejs/kit'])) {
      acc.frameworks.add('svelte')
      acc.techs.add('svelte')
      addSupervisor(
        buildSpec(
          'svelte-supervisor',
          'frontend',
          scope,
          [`${prefix}package.json:svelte`],
          ['svelte-developer', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['@angular/core'])) {
      acc.frameworks.add('angular')
      acc.techs.add('angular')
      addSupervisor(
        buildSpec(
          'angular-supervisor',
          'frontend',
          scope,
          [`${prefix}package.json:@angular/core`],
          ['angular-architect', 'angular-developer', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['express', 'fastify', '@nestjs/core', 'koa', 'hono'])) {
      acc.frameworks.add('node-backend')
      acc.techs.add('node-backend')
      addSupervisor(
        buildSpec(
          'node-backend-supervisor',
          'backend',
          scope,
          [`${prefix}package.json:node-backend-framework`],
          ['nodejs-developer', 'backend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['ethers', 'web3', 'viem', 'wagmi'])) {
      acc.specialized.add('web3')
      acc.techs.add('web3')
      addSupervisor(
        buildSpec(
          'blockchain-supervisor',
          'specialized',
          scope,
          [`${prefix}package.json:web3`],
          ['blockchain-developer', 'web3-developer'],
        ),
      )
    }
  }

  const requirements = readText(resolve(dir, 'requirements.txt'))
  const pyproject = readText(resolve(dir, 'pyproject.toml'))
  const setupPy = readText(resolve(dir, 'setup.py'))
  const pythonText = [requirements, pyproject, setupPy].filter(Boolean).join('\n')

  if (pythonText) {
    acc.languages.add('python')
    acc.techs.add('python')
    if (matchesPython(pythonText, ['fastapi', 'django', 'flask', 'starlette'])) {
      acc.frameworks.add('python-backend')
      acc.techs.add('python-backend')
      addSupervisor(
        buildSpec(
          'python-backend-supervisor',
          'backend',
          scope,
          [`${prefix}requirements/pyproject:python-backend-framework`],
          ['python-developer', 'fastapi-developer', 'django-developer', 'backend-developer'],
        ),
      )
    }
    if (matchesPython(pythonText, ['torch', 'tensorflow', 'transformers', 'scikit-learn'])) {
      acc.specialized.add('ml')
      acc.techs.add('ml')
      addSupervisor(
        buildSpec(
          'ml-supervisor',
          'specialized',
          scope,
          [`${prefix}python:ml-frameworks`],
          ['machine-learning-engineer', 'ai-engineer', 'data-engineer'],
        ),
      )
    }
  }

  if (existsSync(resolve(dir, 'go.mod'))) {
    acc.languages.add('go')
    acc.techs.add('go')
    addSupervisor(
      buildSpec(
        'go-supervisor',
        'backend',
        scope,
        [`${prefix}go.mod`],
        ['golang-pro', 'go-developer', 'backend-developer'],
      ),
    )
  }

  if (existsSync(resolve(dir, 'Cargo.toml'))) {
    acc.languages.add('rust')
    acc.techs.add('rust')
    addSupervisor(
      buildSpec(
        'rust-supervisor',
        'backend',
        scope,
        [`${prefix}Cargo.toml`],
        ['rust-engineer', 'rust-developer', 'backend-developer'],
      ),
    )
  }

  let infraDetected = false
  if (existsSync(resolve(dir, 'Dockerfile'))) {
    acc.infra.add('docker')
    acc.techs.add('docker')
    infraDetected = true
  }
  if (existsSync(resolve(dir, 'docker-compose.yml')) || existsSync(resolve(dir, 'compose.yaml'))) {
    acc.infra.add('docker-compose')
    acc.techs.add('docker-compose')
    infraDetected = true
  }
  if (existsSync(resolve(dir, '.github/workflows'))) {
    acc.infra.add('github-actions')
    acc.techs.add('github-actions')
    infraDetected = true
  }
  if (existsSync(resolve(dir, 'terraform'))) {
    acc.infra.add('terraform')
    acc.techs.add('terraform')
    infraDetected = true
  } else {
    try {
      const entries = readdirSync(dir)
      if (entries.some((e) => e.endsWith('.tf'))) {
        acc.infra.add('terraform')
        acc.techs.add('terraform')
        infraDetected = true
      }
    } catch {
      // ignore
    }
  }

  if (infraDetected) {
    addSupervisor(
      buildSpec(
        'infra-supervisor',
        'infra',
        '.',
        Array.from(acc.infra).map((i) => `${prefix}infra:${i}`),
        ['devops-engineer', 'platform-engineer', 'sre-engineer'],
      ),
    )
  }

  if (existsSync(resolve(dir, 'pubspec.yaml'))) {
    acc.mobile.add('flutter')
    acc.techs.add('flutter')
    addSupervisor(
      buildSpec(
        'flutter-supervisor',
        'mobile',
        scope,
        [`${prefix}pubspec.yaml`],
        ['flutter-expert', 'mobile-developer'],
      ),
    )
  }
  if (existsSync(resolve(dir, 'Podfile'))) {
    acc.mobile.add('ios')
    acc.techs.add('ios')
    addSupervisor(
      buildSpec(
        'ios-supervisor',
        'mobile',
        scope,
        [`${prefix}Podfile`],
        ['ios-developer', 'mobile-developer'],
      ),
    )
  }
  try {
    const entries = readdirSync(dir)
    if (entries.some((e) => e.endsWith('.xcodeproj'))) {
      acc.mobile.add('ios')
      acc.techs.add('ios')
      addSupervisor(
        buildSpec(
          'ios-supervisor',
          'mobile',
          scope,
          [`${prefix}.xcodeproj`],
          ['ios-developer', 'mobile-developer'],
        ),
      )
    }
  } catch {
    // ignore
  }
  const buildGradle =
    readText(resolve(dir, 'build.gradle')) ?? readText(resolve(dir, 'build.gradle.kts'))
  if (buildGradle && /android/i.test(buildGradle)) {
    acc.mobile.add('android')
    acc.techs.add('android')
    addSupervisor(
      buildSpec(
        'android-supervisor',
        'mobile',
        scope,
        [`${prefix}build.gradle:android`],
        ['android-developer', 'mobile-developer'],
      ),
    )
  }

  // Finalize the per-supervisor tech list once the directory's accumulator is
  // fully populated. The Set already deduplicates; sort yields a flat,
  // alphabetical list. Each spec gets its own copy so a later consumer can't
  // mutate a shared array.
  const techList = Array.from(acc.techs).sort()
  for (const spec of acc.supervisors) {
    spec.techs = [...techList]
  }

  return acc
}

export interface DetectStackOptions {
  verbose?: boolean
  onManifest?: (finding: ManifestFinding) => void
}

export const detectStack = (
  repoRoot: string,
  options: DetectStackOptions = {},
): StackDetection => {
  const root = resolve(repoRoot)
  const { manifests: discovered, warnings } = walkManifests(root)

  const languages = new Set<string>()
  const frameworks = new Set<string>()
  const infra = new Set<string>()
  const mobile = new Set<string>()
  const specialized = new Set<string>()
  const supervisors: SupervisorSpec[] = []
  const seen = new Set<string>()
  const findings: ManifestFinding[] = []

  // Always run root-level infra/CI detection (workflows/Dockerfile may sit at the
  // top of a monorepo even when no manifest is present at the root).
  const rootDirs: { dir: string; prefix: string }[] = []

  if (discovered.length === 0) {
    rootDirs.push({ dir: root, prefix: '' })
  } else {
    // If the root itself doesn't have a manifest, still scan it for infra signals.
    const rootHasManifest = discovered.some((m) => m.dir === root)
    if (!rootHasManifest) {
      rootDirs.push({ dir: root, prefix: '' })
    }
    for (const m of discovered) {
      const rel = relative(root, m.dir)
      const prefix = rel === '' ? '' : `${rel}/`
      rootDirs.push({ dir: m.dir, prefix })
    }
  }

  for (const { dir, prefix } of rootDirs) {
    const acc = detectInDirectory(dir, prefix)
    for (const v of acc.languages) languages.add(v)
    for (const v of acc.frameworks) frameworks.add(v)
    for (const v of acc.infra) infra.add(v)
    for (const v of acc.mobile) mobile.add(v)
    for (const v of acc.specialized) specialized.add(v)
    for (const spec of acc.supervisors) {
      if (seen.has(spec.name)) {
        const existing = supervisors.find((s) => s.name === spec.name)
        if (existing) {
          for (const d of spec.detectedFrom) {
            if (!existing.detectedFrom.includes(d)) existing.detectedFrom.push(d)
          }
        }
        continue
      }
      seen.add(spec.name)
      supervisors.push(spec)
    }
    if (acc.techs.size > 0 && discovered.some((m) => m.dir === dir)) {
      const manifestSupervisors = Array.from(
        new Set(acc.supervisors.map((s) => s.name)),
      ).sort()
      const finding: ManifestFinding = {
        dir: relative(root, dir) || '.',
        techs: Array.from(acc.techs).sort(),
        supervisors: manifestSupervisors,
      }
      findings.push(finding)
      if (options.onManifest) options.onManifest(finding)
    }
  }

  return {
    languages: Array.from(languages).sort(),
    frameworks: Array.from(frameworks).sort(),
    infra: Array.from(infra).sort(),
    mobile: Array.from(mobile).sort(),
    specialized: Array.from(specialized).sort(),
    supervisors,
    manifests: findings,
    warnings,
  }
}
