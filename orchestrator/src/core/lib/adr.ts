import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ADR_DIR = 'docs/knowledge/decisions'

export const slugify = (title: string): string => {
  const ascii = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii.length > 0 ? ascii.slice(0, 60) : 'adr'
}

const padNumber = (n: number): string => String(n).padStart(4, '0')

export const adrDirIn = (root: string): string => resolve(root, ADR_DIR)

const ADR_FILENAME_RE = /^(\d{4})-[a-z0-9-]+\.md$/

export const nextAdrNumber = async (dir: string): Promise<number> => {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 1
    throw err
  }
  let max = 0
  for (const name of entries) {
    const match = ADR_FILENAME_RE.exec(name)
    if (!match) continue
    const n = Number.parseInt(match[1], 10)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max + 1
}

export interface AdrWriteArgs {
  /** Worktree root the ADR is being written into. */
  worktreePath: string
  title: string
  body: string
}

export interface AdrWriteResult {
  filePath: string
  number: number
  slug: string
}

export const writeAdrInWorktree = async (
  args: AdrWriteArgs,
): Promise<AdrWriteResult> => {
  const dir = adrDirIn(args.worktreePath)
  await mkdir(dir, { recursive: true })
  const number = await nextAdrNumber(dir)
  const slug = slugify(args.title)
  const filename = `${padNumber(number)}-${slug}.md`
  const filePath = resolve(dir, filename)
  const body = args.body.trim()
  const content = body.length > 0
    ? `# ${args.title}\n\n${body}\n`
    : `# ${args.title}\n`
  await writeFile(filePath, content, 'utf8')
  return { filePath, number, slug }
}

// ─── Supersede support ────────────────────────────────────────────────────────

const STATUS_HEADING = '## Status'
const SUPERSEDED_BY_RE = /^Superseded by (\d{4})$/

/**
 * Parse the `## Status` section of an ADR file to detect supersession.
 * Returns `{ supersededBy: "NNNN" }` if the first non-blank line after the
 * heading matches "Superseded by NNNN", otherwise returns `null`.
 */
export const parseAdrStatus = (content: string): { supersededBy: string } | null => {
  const lines = content.split('\n')
  const statusIdx = lines.findIndex((l) => l === STATUS_HEADING)
  if (statusIdx === -1) return null
  for (let i = statusIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    if (/^## /.test(lines[i])) break // Hit next section without content
    const match = SUPERSEDED_BY_RE.exec(lines[i])
    if (match) return { supersededBy: match[1] }
    break // Non-matching first content line → not superseded
  }
  return null
}

/**
 * Return a copy of `content` with the `## Status` section set to
 * "Superseded by <supersededBy>". If no `## Status` section exists,
 * one is inserted immediately after the title line.
 */
const patchAdrStatus = (content: string, supersededBy: string): string => {
  const supersededLine = `Superseded by ${supersededBy}`
  const lines = content.split('\n')
  const statusIdx = lines.findIndex((l) => l === STATUS_HEADING)

  if (statusIdx !== -1) {
    // Find the end of the existing Status section (next ## heading or EOF).
    let sectionEnd = lines.length
    for (let i = statusIdx + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        sectionEnd = i
        break
      }
    }
    const before = lines.slice(0, statusIdx)
    const after = lines.slice(sectionEnd)
    // Trim trailing blanks from `before` so we always get exactly one blank
    // between the heading above the Status section and the section itself.
    while (before.length > 0 && before[before.length - 1].trim() === '') {
      before.pop()
    }
    const newLines = [...before, '', STATUS_HEADING, '', supersededLine, '']
    if (after.length > 0) {
      // Trim leading blanks from the remainder so the join is clean.
      let start = 0
      while (start < after.length && after[start].trim() === '') start++
      newLines.push('', ...after.slice(start))
    }
    const joined = newLines.join('\n')
    return joined.endsWith('\n') ? joined : joined + '\n'
  }

  // No existing Status section: insert after the title line.
  const titleIdx = lines.findIndex((l) => l.trim().length > 0)
  if (titleIdx === -1) {
    return `${STATUS_HEADING}\n\n${supersededLine}\n`
  }
  const before = lines.slice(0, titleIdx + 1)
  const rest = lines.slice(titleIdx + 1)
  // Skip blank lines between the title and the rest.
  let bodyStart = 0
  while (bodyStart < rest.length && rest[bodyStart].trim() === '') bodyStart++
  const body = rest.slice(bodyStart)

  const newLines = [...before, '', STATUS_HEADING, '', supersededLine]
  if (body.length > 0) {
    newLines.push('', ...body)
  }
  const joined = newLines.join('\n')
  return joined.endsWith('\n') ? joined : joined + '\n'
}

export interface AdrSupersedeArgs {
  /** Worktree root in which the ADR files live. */
  worktreePath: string
  /** 4-digit zero-padded number of the ADR being superseded (e.g. "0084"). */
  oldNumber: string
  /** 4-digit zero-padded number of the ADR that supersedes it (e.g. "0091"). */
  newNumber: string
}

export interface AdrSupersedeResult {
  filePath: string
  filename: string
}

/**
 * Find the ADR numbered `oldNumber` in the worktree, update its `## Status`
 * section to "Superseded by <newNumber>", and write it back. Throws if no
 * matching ADR file is found.
 */
export const supersedeAdrInWorktree = async (
  args: AdrSupersedeArgs,
): Promise<AdrSupersedeResult> => {
  const dir = adrDirIn(args.worktreePath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No ADR matching "${args.oldNumber}" (docs/knowledge/decisions/ does not exist)`,
      )
    }
    throw err
  }
  const padded = args.oldNumber.padStart(4, '0')
  const filename = entries.find(
    (name) => ADR_FILENAME_RE.test(name) && name.startsWith(`${padded}-`),
  )
  if (!filename) {
    throw new Error(
      `No ADR matching "${args.oldNumber}" in docs/knowledge/decisions/`,
    )
  }
  const filePath = resolve(dir, filename)
  const content = await readFile(filePath, 'utf8')
  const updated = patchAdrStatus(content, args.newNumber.padStart(4, '0'))
  await writeFile(filePath, updated, 'utf8')
  return { filePath, filename }
}
