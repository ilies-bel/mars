import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export const MAX_DEPTH = 6

const HARDCODED_IGNORE = new Set<string>([
  '.git',
  'node_modules',
  '.mars',
  '.worktrees',
  'dist',
  'build',
  '.next',
  'target',
  'out',
])

export const MANIFEST_FILES: readonly string[] = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'build.gradle.kts',
  'pubspec.yaml',
  'Podfile',
] as const

export interface DiscoveredManifest {
  dir: string
  files: string[]
}

export interface DepthCapWarning {
  kind: 'depth-cap'
  paths: string[]
}

export interface WalkResult {
  manifests: DiscoveredManifest[]
  warnings: DepthCapWarning[]
}

export class NestedTechError extends Error {
  outerPath: string
  innerPath: string

  constructor(outerPath: string, innerPath: string) {
    super(
      `nested technology stacking is not supported: a manifest under "${outerPath}" already claims this subtree, but another manifest was found at "${innerPath}". Restructure so each tech-bearing folder is a sibling, not a child.`,
    )
    this.name = 'NestedTechError'
    this.outerPath = outerPath
    this.innerPath = innerPath
  }
}

export class WalkAccessError extends Error {
  path: string

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`failed to read "${path}": ${detail}`)
    this.name = 'WalkAccessError'
    this.path = path
  }
}

interface IgnoreRule {
  pattern: RegExp
  negate: boolean
  dirOnly: boolean
}

interface IgnoreLayer {
  base: string
  rules: IgnoreRule[]
}

const escapeRegex = (s: string): string =>
  s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

const compileGitignorePattern = (raw: string): IgnoreRule | null => {
  let line = raw.trim()
  if (!line || line.startsWith('#')) return null

  const negate = line.startsWith('!')
  if (negate) line = line.slice(1)

  const dirOnly = line.endsWith('/')
  if (dirOnly) line = line.slice(0, -1)

  const anchored = line.startsWith('/')
  if (anchored) line = line.slice(1)

  const segments = line.split('/')
  const compiledSegments = segments.map((seg) => {
    if (seg === '**') return '(?:.*)'
    let out = ''
    let i = 0
    while (i < seg.length) {
      const ch = seg[i]
      if (ch === '*') {
        out += '[^/]*'
      } else if (ch === '?') {
        out += '[^/]'
      } else {
        out += escapeRegex(ch ?? '')
      }
      i++
    }
    return out
  })

  const body = compiledSegments.join('/')
  const prefix = anchored ? '^' : '(?:^|.*/)'
  const suffix = '(?:/.*)?$'
  const pattern = new RegExp(prefix + body + suffix)

  return { pattern, negate, dirOnly }
}

const readIgnoreFile = (dir: string): IgnoreRule[] => {
  try {
    const txt = readFileSync(resolve(dir, '.gitignore'), 'utf8')
    return txt
      .split(/\r?\n/)
      .map(compileGitignorePattern)
      .filter((r): r is IgnoreRule => r !== null)
  } catch {
    return []
  }
}

const isIgnored = (
  layers: readonly IgnoreLayer[],
  absolutePath: string,
  isDir: boolean,
): boolean => {
  let ignored = false
  for (const layer of layers) {
    const rel = relative(layer.base, absolutePath).split(sep).join('/')
    if (rel === '' || rel.startsWith('..')) continue
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.pattern.test(rel)) {
        ignored = !rule.negate
      }
    }
  }
  return ignored
}

const collectGitSkips = (repoRoot: string): Set<string> => {
  const skips = new Set<string>()

  try {
    const txt = readFileSync(resolve(repoRoot, '.gitmodules'), 'utf8')
    for (const m of txt.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
      const rel = m[1]?.trim()
      if (rel) skips.add(resolve(repoRoot, rel))
    }
  } catch {
    // no .gitmodules — ignore
  }

  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length).trim()
      if (path && resolve(path) !== repoRoot) {
        skips.add(resolve(path))
      }
    }
  } catch {
    // no git — ignore
  }

  return skips
}

const hasManifest = (dir: string, entries: readonly string[]): string[] => {
  const found: string[] = []
  for (const name of MANIFEST_FILES) {
    if (entries.includes(name)) found.push(name)
  }
  return found
}

interface QueueItem {
  dir: string
  depth: number
  ignoreLayers: IgnoreLayer[]
}

export interface WalkOptions {
  maxDepth?: number
}

export const walkManifests = (
  repoRoot: string,
  options: WalkOptions = {},
): WalkResult => {
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const root = resolve(repoRoot)
  const gitSkips = collectGitSkips(root)

  const manifests: DiscoveredManifest[] = []
  const claimedSubtrees: string[] = []
  const skippedDeepDirs: string[] = []

  const initialIgnore: IgnoreLayer[] = []
  const rootRules = readIgnoreFile(root)
  if (rootRules.length > 0) {
    initialIgnore.push({ base: root, rules: rootRules })
  }

  const queue: QueueItem[] = [
    { dir: root, depth: 0, ignoreLayers: initialIgnore },
  ]

  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    const { dir, depth, ignoreLayers } = item

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (err) {
      throw new WalkAccessError(dir, err)
    }

    const found = hasManifest(dir, entries)
    if (found.length > 0) {
      const claimed = claimedSubtrees.find(
        (c) => dir === c || dir.startsWith(c + sep),
      )
      if (claimed && claimed !== dir) {
        throw new NestedTechError(claimed, dir)
      }
      manifests.push({ dir, files: found })
      claimedSubtrees.push(dir)

      // Enforce "no nested tech": scan the subtree (depth-limited) and reject
      // if any descendant directory also carries a manifest.
      const stack: { d: string; depth: number }[] = []
      let nestedIgnore = ignoreLayers
      if (entries.includes('.gitignore')) {
        const rules = readIgnoreFile(dir)
        if (rules.length > 0) nestedIgnore = [...ignoreLayers, { base: dir, rules }]
      }
      for (const name of entries) {
        if (HARDCODED_IGNORE.has(name)) continue
        const child = resolve(dir, name)
        if (gitSkips.has(child)) continue
        let st
        try {
          st = lstatSync(child)
        } catch {
          continue
        }
        if (st.isSymbolicLink() || !st.isDirectory()) continue
        if (isIgnored(nestedIgnore, child, true)) continue
        stack.push({ d: child, depth: depth + 1 })
      }
      while (stack.length > 0) {
        const top = stack.pop()
        if (!top) break
        if (top.depth > maxDepth) continue
        let subEntries: string[]
        try {
          subEntries = readdirSync(top.d)
        } catch (err) {
          throw new WalkAccessError(top.d, err)
        }
        const nestedFound = hasManifest(top.d, subEntries)
        if (nestedFound.length > 0) {
          throw new NestedTechError(dir, top.d)
        }
        for (const name of subEntries) {
          if (HARDCODED_IGNORE.has(name)) continue
          const child = resolve(top.d, name)
          if (gitSkips.has(child)) continue
          let st
          try {
            st = lstatSync(child)
          } catch {
            continue
          }
          if (st.isSymbolicLink() || !st.isDirectory()) continue
          stack.push({ d: child, depth: top.depth + 1 })
        }
      }
      continue
    }

    if (depth >= maxDepth) {
      // Don't descend; remember if we'd be skipping subdirs.
      for (const name of entries) {
        if (HARDCODED_IGNORE.has(name)) continue
        const child = resolve(dir, name)
        let isDir = false
        try {
          isDir = lstatSync(child).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          skippedDeepDirs.push(child)
          break
        }
      }
      continue
    }

    let nextIgnore = ignoreLayers
    if (entries.includes('.gitignore')) {
      const rules = readIgnoreFile(dir)
      if (rules.length > 0) {
        nextIgnore = [...ignoreLayers, { base: dir, rules }]
      }
    }

    for (const name of entries) {
      if (HARDCODED_IGNORE.has(name)) continue
      const child = resolve(dir, name)

      let st
      try {
        st = lstatSync(child)
      } catch (err) {
        throw new WalkAccessError(child, err)
      }
      if (st.isSymbolicLink()) {
        try {
          statSync(child)
        } catch (err) {
          throw new WalkAccessError(child, err)
        }
        continue
      }
      if (!st.isDirectory()) continue

      if (gitSkips.has(child)) continue
      if (isIgnored(nextIgnore, child, true)) continue

      queue.push({ dir: child, depth: depth + 1, ignoreLayers: nextIgnore })
    }
  }

  const warnings: DepthCapWarning[] = []
  if (skippedDeepDirs.length > 0) {
    warnings.push({ kind: 'depth-cap', paths: skippedDeepDirs })
  }

  return { manifests, warnings }
}
