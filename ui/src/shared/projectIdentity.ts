/**
 * Utility functions for project identity — display name, icon, and signature
 * color derived from the Project record. Kept separate so ProjectSelector and
 * shell-tint logic share the same derivation without duplication.
 */
import type { Project } from './schemas'

/**
 * Brand palette used for per-project signature colors.
 * Each entry is a full-opacity hex that passes 3:1+ contrast on the app's
 * light background (#F5EDE4) as a chrome accent (border, stripe).
 */
const BRAND_PALETTE = [
  '#9A4F00', // flame
  '#9C2E35', // iron
  '#8B5023', // ochre
  '#725130', // basalt
  '#C77D4E', // rust
  '#B49B63', // dune
  '#E8A33D', // amber
] as const

/** Deterministic integer hash of a string (djb2 variant, unsigned 32-bit). */
const hashString = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * Derive a display name, icon, and signature color for a project.
 * - name: project.name if non-empty, else last segment of repoRoot, else projectId
 * - icon: always '◉'
 * - color: deterministic hex from the brand palette, stable across renders
 */
export const projectIdentity = (
  project: Project,
): { name: string; icon: string; color: string } => {
  const name =
    project.name.trim() ||
    project.repoRoot.replace(/\/$/, '').split('/').filter(Boolean).pop() ||
    project.projectId
  const color = BRAND_PALETTE[hashString(project.projectId) % BRAND_PALETTE.length]
  return { name, icon: '◉', color }
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
