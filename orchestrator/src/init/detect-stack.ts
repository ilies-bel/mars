import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export type SupervisorKind = 'frontend' | 'backend' | 'infra' | 'mobile' | 'specialized'

export interface SupervisorSpec {
  name: string
  persona: string
  kind: SupervisorKind
  detectedFrom: string[]
  externalSlugs: string[]
}

export interface StackDetection {
  languages: string[]
  frameworks: string[]
  infra: string[]
  mobile: string[]
  specialized: string[]
  supervisors: SupervisorSpec[]
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

const buildSpec = (
  name: string,
  kind: SupervisorKind,
  detectedFrom: string[],
  externalSlugs: string[],
): SupervisorSpec => ({
  name,
  persona: PERSONAS[name] ?? 'Echo',
  kind,
  detectedFrom,
  externalSlugs,
})

export const detectStack = (repoRoot: string): StackDetection => {
  const languages = new Set<string>()
  const frameworks = new Set<string>()
  const infra = new Set<string>()
  const mobile = new Set<string>()
  const specialized = new Set<string>()
  const supervisors: SupervisorSpec[] = []
  const seen = new Set<string>()

  const addSupervisor = (spec: SupervisorSpec): void => {
    if (seen.has(spec.name)) return
    seen.add(spec.name)
    supervisors.push(spec)
  }

  const pkgPath = resolve(repoRoot, 'package.json')
  const pkg = readJson(pkgPath)
  const npmDeps = collectDeps(pkg)

  if (pkg) {
    languages.add('javascript')
    if (
      existsSync(resolve(repoRoot, 'tsconfig.json')) ||
      hasAny(npmDeps, ['typescript'])
    ) {
      languages.add('typescript')
    }

    if (hasAny(npmDeps, ['next'])) {
      frameworks.add('nextjs')
      addSupervisor(
        buildSpec(
          'react-supervisor',
          'frontend',
          ['package.json:next'],
          ['nextjs-developer', 'react-specialist', 'frontend-developer'],
        ),
      )
    } else if (hasAny(npmDeps, ['react', 'react-dom'])) {
      frameworks.add('react')
      addSupervisor(
        buildSpec(
          'react-supervisor',
          'frontend',
          ['package.json:react'],
          ['react-specialist', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['nuxt'])) {
      frameworks.add('nuxt')
      addSupervisor(
        buildSpec(
          'vue-supervisor',
          'frontend',
          ['package.json:nuxt'],
          ['nuxt-developer', 'vue-specialist', 'frontend-developer'],
        ),
      )
    } else if (hasAny(npmDeps, ['vue'])) {
      frameworks.add('vue')
      addSupervisor(
        buildSpec(
          'vue-supervisor',
          'frontend',
          ['package.json:vue'],
          ['vue-specialist', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['svelte', '@sveltejs/kit'])) {
      frameworks.add('svelte')
      addSupervisor(
        buildSpec(
          'svelte-supervisor',
          'frontend',
          ['package.json:svelte'],
          ['svelte-developer', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['@angular/core'])) {
      frameworks.add('angular')
      addSupervisor(
        buildSpec(
          'angular-supervisor',
          'frontend',
          ['package.json:@angular/core'],
          ['angular-architect', 'angular-developer', 'frontend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['express', 'fastify', '@nestjs/core', 'koa', 'hono'])) {
      frameworks.add('node-backend')
      addSupervisor(
        buildSpec(
          'node-backend-supervisor',
          'backend',
          ['package.json:node-backend-framework'],
          ['nodejs-developer', 'backend-developer'],
        ),
      )
    }

    if (hasAny(npmDeps, ['ethers', 'web3', 'viem', 'wagmi'])) {
      specialized.add('web3')
      addSupervisor(
        buildSpec(
          'blockchain-supervisor',
          'specialized',
          ['package.json:web3'],
          ['blockchain-developer', 'web3-developer'],
        ),
      )
    }
  }

  const requirements = readText(resolve(repoRoot, 'requirements.txt'))
  const pyproject = readText(resolve(repoRoot, 'pyproject.toml'))
  const setupPy = readText(resolve(repoRoot, 'setup.py'))
  const pythonText = [requirements, pyproject, setupPy].filter(Boolean).join('\n')

  if (pythonText) {
    languages.add('python')
    if (matchesPython(pythonText, ['fastapi', 'django', 'flask', 'starlette'])) {
      frameworks.add('python-backend')
      addSupervisor(
        buildSpec(
          'python-backend-supervisor',
          'backend',
          ['requirements/pyproject:python-backend-framework'],
          ['python-developer', 'fastapi-developer', 'django-developer', 'backend-developer'],
        ),
      )
    }
    if (matchesPython(pythonText, ['torch', 'tensorflow', 'transformers', 'scikit-learn'])) {
      specialized.add('ml')
      addSupervisor(
        buildSpec(
          'ml-supervisor',
          'specialized',
          ['python:ml-frameworks'],
          ['machine-learning-engineer', 'ai-engineer', 'data-engineer'],
        ),
      )
    }
  }

  if (existsSync(resolve(repoRoot, 'go.mod'))) {
    languages.add('go')
    addSupervisor(
      buildSpec(
        'go-supervisor',
        'backend',
        ['go.mod'],
        ['golang-pro', 'go-developer', 'backend-developer'],
      ),
    )
  }

  if (existsSync(resolve(repoRoot, 'Cargo.toml'))) {
    languages.add('rust')
    addSupervisor(
      buildSpec(
        'rust-supervisor',
        'backend',
        ['Cargo.toml'],
        ['rust-engineer', 'rust-developer', 'backend-developer'],
      ),
    )
  }

  let infraDetected = false
  if (existsSync(resolve(repoRoot, 'Dockerfile'))) {
    infra.add('docker')
    infraDetected = true
  }
  if (existsSync(resolve(repoRoot, 'docker-compose.yml')) || existsSync(resolve(repoRoot, 'compose.yaml'))) {
    infra.add('docker-compose')
    infraDetected = true
  }
  if (existsSync(resolve(repoRoot, '.github/workflows'))) {
    infra.add('github-actions')
    infraDetected = true
  }
  if (existsSync(resolve(repoRoot, 'terraform'))) {
    infra.add('terraform')
    infraDetected = true
  } else {
    try {
      const entries = readdirSync(repoRoot)
      if (entries.some((e) => e.endsWith('.tf'))) {
        infra.add('terraform')
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
        Array.from(infra).map((i) => `infra:${i}`),
        ['devops-engineer', 'platform-engineer', 'sre-engineer'],
      ),
    )
  }

  if (existsSync(resolve(repoRoot, 'pubspec.yaml'))) {
    mobile.add('flutter')
    addSupervisor(
      buildSpec(
        'flutter-supervisor',
        'mobile',
        ['pubspec.yaml'],
        ['flutter-expert', 'mobile-developer'],
      ),
    )
  }
  if (existsSync(resolve(repoRoot, 'Podfile'))) {
    mobile.add('ios')
    addSupervisor(
      buildSpec(
        'ios-supervisor',
        'mobile',
        ['Podfile'],
        ['ios-developer', 'mobile-developer'],
      ),
    )
  }
  try {
    const entries = readdirSync(repoRoot)
    if (entries.some((e) => e.endsWith('.xcodeproj'))) {
      mobile.add('ios')
      addSupervisor(
        buildSpec(
          'ios-supervisor',
          'mobile',
          ['.xcodeproj'],
          ['ios-developer', 'mobile-developer'],
        ),
      )
    }
  } catch {
    // ignore
  }
  const buildGradle = readText(resolve(repoRoot, 'build.gradle')) ?? readText(resolve(repoRoot, 'build.gradle.kts'))
  if (buildGradle && /android/i.test(buildGradle)) {
    mobile.add('android')
    addSupervisor(
      buildSpec(
        'android-supervisor',
        'mobile',
        ['build.gradle:android'],
        ['android-developer', 'mobile-developer'],
      ),
    )
  }

  return {
    languages: Array.from(languages).sort(),
    frameworks: Array.from(frameworks).sort(),
    infra: Array.from(infra).sort(),
    mobile: Array.from(mobile).sort(),
    specialized: Array.from(specialized).sort(),
    supervisors,
  }
}
