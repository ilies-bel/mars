import { readFileSync, writeFileSync } from 'node:fs'

const LAYOUT_START = '<!-- mars:project-layout:start -->'
const LAYOUT_END = '<!-- mars:project-layout:end -->'

export interface ProjectLayoutEntry {
  /** Directory scope relative to repo root, e.g. 'gateway', 'dashboard', or '.' */
  folder: string
  /** Technology list, e.g. ['node', 'typescript'] */
  techs: string[]
  /** Supervisor name, e.g. 'node-backend-supervisor' */
  supervisorName: string
  /** Persona name, e.g. 'Nina' */
  persona: string
  /** Formatted verify commands, e.g. ['npx tsc --noEmit', 'npm test --silent'] */
  verifyCommands: string[]
}

/**
 * Generate the project layout markdown block (including the marker comments).
 * Returns an empty string when `entries` is empty — the caller decides whether
 * to skip writing or to remove an existing block.
 */
export const generateProjectLayoutBlock = (
  entries: ProjectLayoutEntry[],
): string => {
  if (entries.length === 0) return ''

  const rows = entries.map((e) => {
    const folder = e.folder === '.' ? '(root)' : e.folder
    const techs = e.techs.length > 0 ? e.techs.join(', ') : '—'
    const supervisor = `${e.persona} (${e.supervisorName})`
    const verify =
      e.verifyCommands.length > 0 ? e.verifyCommands.join(', ') : '—'
    return `| ${folder} | ${techs} | ${supervisor} | ${verify} |`
  })

  return [
    LAYOUT_START,
    '## Project layout',
    '',
    '| Folder | Technology | Supervisor | Verify |',
    '|--------|------------|------------|--------|',
    ...rows,
    LAYOUT_END,
  ].join('\n')
}

/**
 * Insert or replace the project layout marker block in the root CLAUDE.md.
 * Idempotent: calling with the same entries produces the same file content.
 * When `entries` is empty, any existing marker block is removed.
 */
export const enrichRootClaudeMd = (
  claudeMdPath: string,
  entries: ProjectLayoutEntry[],
): void => {
  const block = generateProjectLayoutBlock(entries)
  const existing = readFileSync(claudeMdPath, 'utf8')

  const startIdx = existing.indexOf(LAYOUT_START)
  const endIdx = existing.indexOf(LAYOUT_END)
  const hasExistingBlock =
    startIdx !== -1 && endIdx !== -1 && endIdx > startIdx

  if (!block) {
    if (hasExistingBlock) {
      // Remove the old block and collapse surrounding whitespace
      const before = existing.slice(0, startIdx).trimEnd()
      const after = existing.slice(endIdx + LAYOUT_END.length).trimStart()
      const newContent =
        before + '\n' + (after.length > 0 ? after : '')
      writeFileSync(claudeMdPath, newContent, 'utf8')
    }
    return
  }

  if (hasExistingBlock) {
    // Replace in-place, keeping everything before and after the block intact
    const newContent =
      existing.slice(0, startIdx) +
      block +
      existing.slice(endIdx + LAYOUT_END.length)
    writeFileSync(claudeMdPath, newContent, 'utf8')
  } else {
    // Append with a blank line separator
    const separator = existing.endsWith('\n') ? '\n' : '\n\n'
    writeFileSync(claudeMdPath, existing + separator + block + '\n', 'utf8')
  }
}
