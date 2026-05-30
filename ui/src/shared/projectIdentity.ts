/**
 * Utility functions for project identity — display name and icon derived from
 * the Project record. Kept separate so ProjectSelector and any future
 * shell-tint logic share the same derivation without duplication.
 */
import type { Project } from './schemas'

/**
 * Derive a display name and icon for a project.
 * The name uses project.name if non-empty, otherwise the last segment of
 * repoRoot, otherwise projectId as a final fallback.
 */
export const projectIdentity = (
  project: Project,
): { name: string; icon: string } => {
  const name =
    project.name.trim() ||
    project.repoRoot.replace(/\/$/, '').split('/').filter(Boolean).pop() ||
    project.projectId
  return { name, icon: '◉' }
}

/**
 * Find a project ID by matching its repoRoot. Returns null when no project in
 * the list matches the given root path.
 */
export const projectIdFromRoot = (
  repoRoot: string,
  projects: Project[],
): string | null => {
  return projects.find((p) => p.repoRoot === repoRoot)?.projectId ?? null
}
