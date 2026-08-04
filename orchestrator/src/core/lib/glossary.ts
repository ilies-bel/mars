import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { GLOSSARY_DIR } from './knowledge'

export interface GlossaryTerm {
  term: string
  definition: string
  aliases: readonly string[]
  surfaceForms: readonly string[]
}

export const generateDefaultSurfaceForms = (term: string): string[] => {
  const lower = term.toLowerCase()
  let plural: string
  if (/(?:s|x|z|ch|sh)$/.test(lower)) plural = `${lower}es`
  else if (/y$/.test(lower)) plural = `${lower.slice(0, -1)}ies`
  else plural = `${lower}s`
  return lower === plural ? [lower] : [lower, plural]
}

/** Normalises the identity of a term while retaining its stored display form. */
export const canonicalizeTermKey = (term: string): string =>
  term.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

export const glossaryTermFilename = (term: string): string => {
  const key = canonicalizeTermKey(term)
  const slug = key
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'term'
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 12)
  return `${slug}-${suffix}.md`
}

const parseList = (line: string): string[] => line
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const parseGlossaryTerm = (text: string): GlossaryTerm | null => {
  const lines = text.trim().split('\n')
  const heading = lines.shift()?.match(/^#\s+(.+)\s*$/)
  if (!heading) return null
  const aliases: string[] = []
  let surfaceForms: string[] | undefined
  const definitionLines: string[] = []
  for (const line of lines) {
    const avoid = line.trim().match(/^_Avoid_:\s*(.*)$/i)
    if (avoid) { aliases.push(...parseList(avoid[1] ?? '')); continue }
    const forms = line.trim().match(/^_Surface forms_:\s*(.*)$/i)
    if (forms) { surfaceForms = parseList(forms[1] ?? ''); continue }
    definitionLines.push(line)
  }
  const term = heading[1].trim()
  return {
    term,
    definition: definitionLines.join('\n').trim(),
    aliases,
    surfaceForms: surfaceForms ?? generateDefaultSurfaceForms(term),
  }
}

const renderGlossaryTerm = (term: GlossaryTerm): string => {
  const defaults = generateDefaultSurfaceForms(term.term)
  const surfaceForms = term.surfaceForms.length > 0 ? term.surfaceForms : defaults
  const differs = surfaceForms.length !== defaults.length || surfaceForms.some((form, index) => form !== defaults[index])
  return [
    `# ${term.term.trim()}`,
    '',
    term.definition.trim(),
    ...(term.aliases.length > 0 ? ['', `_Avoid_: ${term.aliases.join(', ')}`] : []),
    ...(differs ? ['', `_Surface forms_: ${surfaceForms.join(', ')}`] : []),
    '',
  ].join('\n')
}

const pathFor = (repoRoot: string, term: string): string =>
  resolve(repoRoot, GLOSSARY_DIR, glossaryTermFilename(term))

export const readGlossaryTerm = async (repoRoot: string, term: string): Promise<GlossaryTerm | null> => {
  try {
    return parseGlossaryTerm(await readFile(pathFor(repoRoot, term), 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const listGlossaryTerms = async (repoRoot: string): Promise<GlossaryTerm[]> => {
  const dir = resolve(repoRoot, GLOSSARY_DIR)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const terms = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map(async (entry) => parseGlossaryTerm(await readFile(join(dir, entry.name), 'utf8'))))
    return terms.filter((term): term is GlossaryTerm => term !== null)
      .sort((a, b) => a.term.localeCompare(b.term))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Atomically replaces just the selected term's Markdown unit. */
export const writeGlossaryTerm = async (
  repoRoot: string,
  next: Omit<GlossaryTerm, 'surfaceForms'> & { readonly surfaceForms?: readonly string[] },
): Promise<void> => {
  const target = pathFor(repoRoot, next.term)
  const term: GlossaryTerm = { ...next, term: next.term.trim(), surfaceForms: next.surfaceForms ?? generateDefaultSurfaceForms(next.term) }
  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, renderGlossaryTerm(term), 'utf8')
  await rename(temporary, target)
}

/** Deletes just the requested unit. Missing terms intentionally remain a no-op. */
export const removeGlossaryTerm = async (repoRoot: string, term: string): Promise<boolean> => {
  try {
    await rm(pathFor(repoRoot, term))
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
