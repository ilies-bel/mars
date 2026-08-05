import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { delimiter, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { VerifyGateInputSchema, type VerifyGateInput } from '../core/verify-gates'

export interface DetectedVerifyGate extends Required<VerifyGateInput> {
  evidence: string
}

/**
 * Turn a proposed gate set into the complete registry input shape used by
 * onboarding. JSON edits pass through the same validation as all other gate
 * input, and discovery metadata such as `evidence` is intentionally omitted.
 */
export const normalizeDetectedVerifyGates = (
  gates: readonly VerifyGateInput[],
): Required<VerifyGateInput>[] =>
  gates.map((gate) => {
    const parsed = VerifyGateInputSchema.parse(gate)
    return {
      scope: parsed.scope ?? '.',
      name: parsed.name,
      cmd: parsed.cmd,
      args: parsed.args ?? [],
      required: parsed.required ?? true,
      tier: parsed.tier ?? 'task',
      source: parsed.source ?? 'detected',
    }
  })

const NODE_SCRIPTS = ['typecheck', 'lint', 'test', 'test:integration'] as const

const commandIsRunnable = (command: string): boolean => {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    for (const suffix of suffixes) {
      try {
        if ((statSync(resolve(directory, `${command}${suffix}`)).mode & 0o111) !== 0) return true
      } catch {
        // Try the next directory on PATH.
      }
    }
  }
  return false
}

/**
 * Inspect declared repository tooling and propose runnable verify gates.
 * Discovery only reads repository files; it never writes to the gate registry.
 */
export const detectVerifyGates = (repoRoot: string): DetectedVerifyGate[] => {
  const packageJson = resolve(repoRoot, 'package.json')
  const packageManager = existsSync(resolve(repoRoot, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(resolve(repoRoot, 'yarn.lock'))
      ? 'yarn'
      : existsSync(resolve(repoRoot, 'bun.lockb')) || existsSync(resolve(repoRoot, 'bun.lock'))
        ? 'bun'
        : 'npm'
  const proposals: DetectedVerifyGate[] = []

  let rootPackage: { scripts?: unknown; workspaces?: unknown } | null = null
  if (existsSync(packageJson)) {
    try {
      rootPackage = JSON.parse(readFileSync(packageJson, 'utf8')) as {
        scripts?: unknown
        workspaces?: unknown
      }
    } catch {
      rootPackage = null
    }
  }

  const packages = rootPackage ? [{ dir: repoRoot, scope: '.', manifest: rootPackage }] : []
  const patterns: string[] = []
  if (Array.isArray(rootPackage?.workspaces)) {
    patterns.push(...rootPackage.workspaces.filter((value): value is string => typeof value === 'string'))
  } else if (
    rootPackage?.workspaces &&
    typeof rootPackage.workspaces === 'object' &&
    Array.isArray((rootPackage.workspaces as { packages?: unknown }).packages)
  ) {
    patterns.push(
      ...(rootPackage.workspaces as { packages: unknown[] }).packages.filter(
        (value): value is string => typeof value === 'string',
      ),
    )
  }
  const pnpmWorkspace = resolve(repoRoot, 'pnpm-workspace.yaml')
  if (existsSync(pnpmWorkspace)) {
    try {
      const parsed = loadYaml(readFileSync(pnpmWorkspace, 'utf8'))
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { packages?: unknown }).packages)) {
        patterns.push(
          ...(parsed as { packages: unknown[] }).packages.filter(
            (value): value is string => typeof value === 'string',
          ),
        )
      }
    } catch {
      // An invalid workspace file cannot declare package scopes safely.
    }
  }

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (!normalizedPattern) continue
    const segments = normalizedPattern.split('/')
    const fixedSegments: string[] = []
    for (const segment of segments) {
      if (/[?*[]/.test(segment)) break
      fixedSegments.push(segment)
    }
    const base = resolve(repoRoot, ...fixedSegments)
    if (!base.startsWith(`${resolve(repoRoot)}${sep}`) && base !== resolve(repoRoot)) continue
    const matcher = new RegExp(
      `^${normalizedPattern
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replaceAll('**', '___DOUBLE_STAR___')
        .replaceAll('*', '[^/]*')
        .replaceAll('___DOUBLE_STAR___', '.*')
        .replaceAll('?', '[^/]')}$`,
    )
    const directories = [base]
    while (directories.length > 0) {
      const directory = directories.pop()!
      let entries: Dirent<string>[]
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        continue
      }
      const scope = relative(repoRoot, directory).split(sep).join('/') || '.'
      if (scope !== '.' && matcher.test(scope) && existsSync(resolve(directory, 'package.json'))) {
        try {
          packages.push({
            dir: directory,
            scope,
            manifest: JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {
              scripts?: unknown
            },
          })
        } catch {
          // A malformed workspace package cannot provide runnable scripts.
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
          directories.push(resolve(directory, entry.name))
        }
      }
    }
  }

  const byScopeAndName = new Map<string, DetectedVerifyGate>()
  for (const pkg of packages) {
    if (typeof pkg.manifest.scripts !== 'object' || pkg.manifest.scripts === null) continue
    const scripts = pkg.manifest.scripts as Record<string, unknown>
    for (const name of NODE_SCRIPTS) {
      if (typeof scripts[name] !== 'string' || scripts[name].trim() === '') continue
      byScopeAndName.set(`${pkg.scope}\x00${name}`, {
        scope: pkg.scope,
        name,
        cmd: packageManager,
        args: ['run', name],
        required: true,
        tier: name === 'test:integration' ? 'integration' : 'task',
        source: 'detected',
        evidence: `package.json script "${name}"`,
      })
    }
  }

  const pyproject = resolve(repoRoot, 'pyproject.toml')
  if (existsSync(pyproject)) {
    try {
      const contents = readFileSync(pyproject, 'utf8')
      const configured = /^\[tool\.pytest(?:\.|\])/m.test(contents)
      if (configured || commandIsRunnable('pytest')) {
        byScopeAndName.set('.\x00test', {
          scope: '.',
          name: 'test',
          cmd: configured ? 'python' : 'pytest',
          args: configured ? ['-m', 'pytest'] : [],
          required: true,
          tier: 'task',
          source: 'detected',
          evidence: configured ? 'pyproject.toml pytest configuration' : 'pytest executable',
        })
      }
    } catch {
      // A malformed descriptor does not establish a runnable test configuration.
    }
  }

  const cargoToml = resolve(repoRoot, 'Cargo.toml')
  if (existsSync(cargoToml)) {
    try {
      const configured = /^\[\[test\]\]/m.test(readFileSync(cargoToml, 'utf8'))
      if (configured || commandIsRunnable('cargo')) {
        byScopeAndName.set('.\x00test', {
          scope: '.',
          name: 'test',
          cmd: 'cargo',
          args: ['test'],
          required: true,
          tier: 'task',
          source: 'detected',
          evidence: configured ? 'Cargo.toml test target' : 'cargo executable',
        })
      }
    } catch {
      // A malformed manifest does not establish a runnable test target.
    }
  }

  if (existsSync(resolve(repoRoot, 'go.mod'))) {
    try {
      const configured = readdirSync(repoRoot).some((entry) => entry.endsWith('_test.go'))
      if (configured || commandIsRunnable('go')) {
        byScopeAndName.set('.\x00test', {
          scope: '.',
          name: 'test',
          cmd: 'go',
          args: ['test', './...'],
          required: true,
          tier: 'task',
          source: 'detected',
          evidence: configured ? 'go.mod with Go test files' : 'go executable',
        })
      }
    } catch {
      // An unreadable module directory cannot establish a runnable test target.
    }
  }

  const hasGradleBuild =
    existsSync(resolve(repoRoot, 'build.gradle')) || existsSync(resolve(repoRoot, 'build.gradle.kts'))
  const gradleWrapper = resolve(repoRoot, 'gradlew')
  if (hasGradleBuild) {
    try {
      let configured = false
      for (const buildFile of ['build.gradle', 'build.gradle.kts']) {
        const buildPath = resolve(repoRoot, buildFile)
        if (
          existsSync(buildPath) &&
          /(?:tasks\.test|(?:^|\n)\s*test\s*\{)/.test(readFileSync(buildPath, 'utf8'))
        ) {
          configured = true
        }
      }
      const wrapperRunnable = existsSync(gradleWrapper) && (statSync(gradleWrapper).mode & 0o111) !== 0
      if (wrapperRunnable || configured || commandIsRunnable('gradle')) {
        byScopeAndName.set('.\x00test', {
          scope: '.',
          name: 'test',
          cmd: wrapperRunnable ? './gradlew' : 'gradle',
          args: ['test'],
          required: true,
          tier: 'task',
          source: 'detected',
          evidence: wrapperRunnable
            ? 'Gradle wrapper'
            : configured
              ? 'Gradle test task'
              : 'gradle executable',
        })
      }
    } catch {
      // An unreadable wrapper is not a runnable Gradle tool.
    }
  }

  return [...byScopeAndName.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
  )
}
