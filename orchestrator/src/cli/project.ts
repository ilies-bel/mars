import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { addProject, loadProjectRegistry, removeProject } from '../registry/projects.js'

export async function projectAdd(args: { path: string; name?: string }): Promise<void> {
  const abs = resolve(args.path)
  if (!existsSync(abs)) {
    console.error(`error: directory does not exist: ${abs}`)
    process.exit(1)
  }
  let entry
  try {
    entry = addProject({ repoRoot: abs, name: args.name })
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  console.log(entry.projectId)
}

export function projectList(): void {
  const entries = loadProjectRegistry()
  if (entries.length === 0) {
    console.log('(no projects registered)')
    return
  }
  for (const e of entries) {
    console.log(`${e.projectId}\t${e.name}\t${e.repoRoot}`)
  }
}

export function projectRemove(projectId: string): void {
  const found = removeProject(projectId)
  if (found) {
    console.log(`removed ${projectId}`)
  } else {
    console.log(`no such project: ${projectId}`)
  }
}
