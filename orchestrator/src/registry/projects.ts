import { z } from 'zod'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

export const projectSchema = z.object({
  projectId: z.string(),
  repoRoot: z.string().refine(path.isAbsolute, { message: 'repoRoot must be an absolute path' }),
  name: z.string(),
})

export type RegistryEntry = z.infer<typeof projectSchema>

/** Returns the path to the project registry file. Overridable via MARS_PROJECTS_FILE for tests. */
export function registryPath(): string {
  return process.env.MARS_PROJECTS_FILE ?? path.join(os.homedir(), '.mars', 'projects.json')
}

/** Returns [] when the file is absent or empty; throws on JSON or schema errors. */
export function loadProjectRegistry(): RegistryEntry[] {
  const filePath = registryPath()
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf-8')
  if (raw.trim() === '') return []
  const parsed = JSON.parse(raw)
  return z.array(projectSchema).parse(parsed)
}

/** Writes entries atomically to the registry file (write-temp-then-rename). */
export function saveProjectRegistry(entries: RegistryEntry[]): void {
  const filePath = registryPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2))
  fs.renameSync(tmp, filePath)
}

/**
 * Adds a new project entry. projectId is derived deterministically as
 * 'p_' + sha256(absoluteRepoRoot).slice(0,12). Throws if repoRoot already registered.
 */
export function addProject({ repoRoot, name }: { repoRoot: string; name?: string }): RegistryEntry {
  const abs = path.resolve(repoRoot)
  const entries = loadProjectRegistry()
  if (entries.some((e) => e.repoRoot === abs)) {
    throw new Error(`Project with repoRoot "${abs}" is already registered`)
  }
  const hash = crypto.createHash('sha256').update(abs).digest('hex')
  const entry: RegistryEntry = {
    projectId: 'p_' + hash.slice(0, 12),
    repoRoot: abs,
    name: name ?? path.basename(abs),
  }
  saveProjectRegistry([...entries, entry])
  return entry
}

/** Removes the project with the given id. Returns true if it existed, false otherwise. */
export function removeProject(projectId: string): boolean {
  const entries = loadProjectRegistry()
  const next = entries.filter((e) => e.projectId !== projectId)
  if (next.length === entries.length) return false
  saveProjectRegistry(next)
  return true
}

/** Returns the entry for the given projectId, or null if not found. */
export function findProject(projectId: string): RegistryEntry | null {
  return loadProjectRegistry().find((e) => e.projectId === projectId) ?? null
}

/**
 * Idempotently ensures the given repo root is registered. If an entry with
 * the same absolute repoRoot already exists, returns it unchanged (no write).
 * Otherwise registers via addProject and returns the new entry.
 */
export function ensureProjectRegistered({
  repoRoot,
  name,
}: {
  repoRoot: string
  name?: string
}): RegistryEntry {
  const abs = path.resolve(repoRoot)
  const existing = loadProjectRegistry().find((e) => e.repoRoot === abs)
  if (existing) return existing
  return addProject({ repoRoot: abs, name })
}
