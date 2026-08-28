import { z } from 'zod'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

const projectSchema = z.object({
  projectId: z.string(),
  repoRoot: z.string().refine(path.isAbsolute, { message: 'repoRoot must be an absolute path' }),
  name: z.string(),
})

export type RegistryEntry = z.infer<typeof projectSchema>

/** Returns the path to the project registry file. Overridable via MARS_PROJECTS_FILE for tests. */
function registryPath(): string {
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
function saveProjectRegistry(entries: RegistryEntry[]): void {
  const filePath = registryPath()
  if (process.env.VITEST && !process.env.MARS_PROJECTS_FILE) {
    throw new Error(
      `[mars-test registry violation] A test tried to write the real project registry at ` +
        `${filePath}. Set MARS_PROJECTS_FILE to a temp file in your test's setup ` +
        `(see orchestrator/test/setup-env.ts).`,
    )
  }
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
 *
 * Belt-and-braces: when running under Vitest without an explicit
 * MARS_PROJECTS_FILE override, registryPath() would fall through to
 * ~/.mars/projects.json and pollute the developer's real registry.  In that
 * case a synthesised entry is returned without touching the filesystem so
 * daemon-boot test fixtures are self-contained without any per-fixture
 * plumbing.  The primary guard is in saveProjectRegistry (it throws for any
 * write attempt under the same condition, covering every caller in every
 * workspace); this short-circuit is the secondary safety net that prevents
 * the read-then-write path from ever reaching the chokepoint in the first
 * place, and avoids a throw in contexts like daemon-boot that call
 * ensureProjectRegistered unconditionally.
 */
export function ensureProjectRegistered({
  repoRoot,
  name,
}: {
  repoRoot: string
  name?: string
}): RegistryEntry {
  if (process.env.VITEST && !process.env.MARS_PROJECTS_FILE) {
    // Skipping write: running under Vitest with no MARS_PROJECTS_FILE override
    // would write to ~/.mars/projects.json.  Return a synthesised entry.
    const abs = path.resolve(repoRoot)
    const hash = crypto.createHash('sha256').update(abs).digest('hex')
    return { projectId: 'p_' + hash.slice(0, 12), repoRoot: abs, name: name ?? path.basename(abs) }
  }
  const abs = path.resolve(repoRoot)
  const existing = loadProjectRegistry().find((e) => e.repoRoot === abs)
  if (existing) return existing
  return addProject({ repoRoot: abs, name })
}
