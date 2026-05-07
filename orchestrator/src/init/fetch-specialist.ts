import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TREES_URL =
  'https://api.github.com/repos/ayush-that/sub-agents.directory/git/trees/main?recursive=1'

const RAW_BASE = 'https://raw.githubusercontent.com/ayush-that/sub-agents.directory/main/'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ParsedFrontmatter {
  name: string
  description: string
  tools: string
}

export interface ParsedSpecialist {
  frontmatter: ParsedFrontmatter
  body: string
}

export interface ResolvedSpecialist {
  slug: string
  path: string
  body: string
}

export interface FetchOptions {
  refresh: boolean
  cacheDir: string
}

interface TreesIndexFile {
  generatedAt: number
  index: Record<string, string>
}

const ensureCacheDir = (cacheDir: string): void => {
  mkdirSync(cacheDir, { recursive: true })
}

const isFresh = (mtimeMs: number, refresh: boolean): boolean => {
  if (refresh) return false
  return Date.now() - mtimeMs < TTL_MS
}

const safeRead = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const safeReadJson = <T>(path: string): T | null => {
  const raw = safeRead(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const safeStatMs = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

interface TreeEntry {
  path?: string
  type?: string
}

interface TreesResponse {
  tree?: TreeEntry[]
}

const buildIndexFromTree = (tree: TreeEntry[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const entry of tree) {
    if (entry.type !== 'blob') continue
    const path = entry.path
    if (!path || !path.startsWith('content/') || !path.endsWith('.md')) continue
    const slug = path.slice(path.lastIndexOf('/') + 1, -'.md'.length)
    if (slug && !(slug in out)) {
      out[slug] = path
    }
  }
  return out
}

const fetchTreesFromNetwork = async (): Promise<Record<string, string> | null> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mars-orchestrator',
  }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const res = await fetch(TREES_URL, { headers })
    if (!res.ok) return null
    const json = (await res.json()) as TreesResponse
    if (!json.tree) return null
    return buildIndexFromTree(json.tree)
  } catch {
    return null
  }
}

export const fetchTreesIndex = async (
  opts: FetchOptions,
): Promise<Map<string, string>> => {
  ensureCacheDir(opts.cacheDir)
  const cachePath = resolve(opts.cacheDir, 'trees.json')
  const cached = safeReadJson<TreesIndexFile>(cachePath)

  if (cached && isFresh(cached.generatedAt, opts.refresh)) {
    return new Map(Object.entries(cached.index))
  }

  const fresh = await fetchTreesFromNetwork()
  if (fresh) {
    const payload: TreesIndexFile = { generatedAt: Date.now(), index: fresh }
    try {
      writeFileSync(cachePath, JSON.stringify(payload), 'utf8')
    } catch {
      // ignore cache write failure
    }
    return new Map(Object.entries(fresh))
  }

  if (cached) {
    return new Map(Object.entries(cached.index))
  }

  return new Map()
}

const parseFrontmatterFields = (block: string): ParsedFrontmatter | null => {
  const fields: Record<string, string> = {}
  const lines = block.split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  if (
    typeof fields.name !== 'string' ||
    typeof fields.description !== 'string' ||
    typeof fields.tools !== 'string'
  ) {
    return null
  }
  return {
    name: fields.name,
    description: fields.description,
    tools: fields.tools,
  }
}

export const parseFrontmatter = (text: string): ParsedSpecialist | null => {
  if (!text.startsWith('---')) return null
  const afterStart = text.indexOf('\n', 3)
  if (afterStart === -1) return null
  const end = text.indexOf('\n---', afterStart)
  if (end === -1) return null
  const block = text.slice(afterStart + 1, end)
  const fm = parseFrontmatterFields(block)
  if (!fm) return null
  let body = text.slice(end + '\n---'.length)
  if (body.startsWith('\n')) body = body.slice(1)
  return { frontmatter: fm, body: body.trim() }
}

const fetchRawBody = async (path: string): Promise<string | null> => {
  try {
    const res = await fetch(RAW_BASE + path, {
      headers: { 'User-Agent': 'mars-orchestrator' },
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export const fetchSpecialistBody = async (
  slug: string,
  index: Map<string, string>,
  opts: FetchOptions,
): Promise<ResolvedSpecialist | null> => {
  const path = index.get(slug)
  if (!path) return null

  ensureCacheDir(opts.cacheDir)
  const cachePath = resolve(opts.cacheDir, `${slug}.md`)
  const metaPath = resolve(opts.cacheDir, `${slug}.meta.json`)

  const mtimeMs = safeStatMs(cachePath)
  if (mtimeMs !== null && isFresh(mtimeMs, opts.refresh)) {
    const cached = safeRead(cachePath)
    if (cached !== null) {
      const parsed = parseFrontmatter(cached)
      if (parsed) {
        return { slug, path, body: parsed.body }
      }
    }
  }

  const raw = await fetchRawBody(path)
  if (raw === null) {
    const stale = safeRead(cachePath)
    if (stale !== null) {
      const parsed = parseFrontmatter(stale)
      if (parsed) {
        return { slug, path, body: parsed.body }
      }
    }
    return null
  }

  try {
    writeFileSync(cachePath, raw, 'utf8')
    writeFileSync(metaPath, JSON.stringify({ path, fetchedAt: Date.now() }), 'utf8')
  } catch {
    // ignore cache write failure
  }

  const parsed = parseFrontmatter(raw)
  if (!parsed) return null
  return { slug, path, body: parsed.body }
}

export interface ResolveResult {
  resolved: ResolvedSpecialist | null
  tried: string[]
}

export const resolveSpecialist = async (
  slugs: readonly string[],
  index: Map<string, string>,
  opts: FetchOptions,
): Promise<ResolveResult> => {
  const tried: string[] = []
  for (const slug of slugs) {
    tried.push(slug)
    if (!index.has(slug)) continue
    const result = await fetchSpecialistBody(slug, index, opts)
    if (result) {
      return { resolved: result, tried }
    }
  }
  return { resolved: null, tried }
}
