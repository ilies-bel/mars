/**
 * Utility functions for project identity — display name and icon derived from
 * the Project record. Kept separate so ProjectSelector and any future
 * shell-tint logic share the same derivation without duplication.
 */
import type { Project } from './schemas'

/**
 * Curated space-themed glyphs that render cleanly in JetBrains Mono.
 * ⯃ (U+2BC3) is intentionally omitted — it is absent from older versions of
 * the font and may render as a replacement box.
 */
const SPACE_GLYPHS = [
  '☄', // U+2604 COMET
  '✦', // U+2726 BLACK FOUR POINTED STAR
  '✧', // U+2727 WHITE FOUR POINTED STAR
  '★', // U+2605 BLACK STAR
  '☀', // U+2600 BLACK SUN WITH RAYS
  '☾', // U+263E LAST QUARTER MOON
  '⊙', // U+2299 CIRCLED DOT OPERATOR
  '⊕', // U+2295 CIRCLED PLUS
  '◐', // U+25D0 CIRCLE WITH LEFT HALF BLACK
  '♁', // U+2641 EARTH
  '♆', // U+2646 NEPTUNE
  '✶', // U+2736 SIX POINTED BLACK STAR
  '✷', // U+2737 EIGHT POINTED BLACK STAR
  '❂', // U+2742 CIRCLED WHITE STAR
  '☉', // U+2609 SUN
] as const

/**
 * FNV-1a 32-bit hash — small, dependency-free, and stable across platforms.
 * Returns an unsigned 32-bit integer. Same input always produces the same
 * output; the function has no external state.
 */
const fnv1a = (str: string): number => {
  let h = 2166136261 // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0 // FNV prime; >>> 0 forces unsigned 32-bit
  }
  return h
}

/**
 * Derive a display name and icon for a project.
 * The name uses project.name if non-empty, otherwise the last segment of
 * repoRoot, otherwise projectId as a final fallback.
 * The icon is a space-themed glyph chosen deterministically from the derived
 * name — same name always yields the same glyph.
 */
export const projectIdentity = (
  project: Project,
): { name: string; icon: string } => {
  const name =
    project.name.trim() ||
    project.repoRoot.replace(/\/$/, '').split('/').filter(Boolean).pop() ||
    project.projectId
  const icon = SPACE_GLYPHS[fnv1a(name) % SPACE_GLYPHS.length]
  return { name, icon }
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
