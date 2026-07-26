import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface GlossaryTerm {
  term: string
  definition: string
  aliases: readonly string[]
  surfaceForms: readonly string[]
}

export interface GlossaryDoc {
  preamble: string
  terms: readonly GlossaryTerm[]
  trailer: string
}

const HEADER = '# Project Context\n\nCanonical domain terms for this project. Edited via `mars glossary`.\n'
const LANGUAGE_HEADING = '## Language'

export const generateDefaultSurfaceForms = (term: string): string[] => {
  const lower = term.toLowerCase()
  let plural: string
  if (/(?:s|x|z|ch|sh)$/.test(lower)) {
    plural = lower + 'es'
  } else if (/y$/.test(lower)) {
    plural = lower.slice(0, -1) + 'ies'
  } else {
    plural = lower + 's'
  }
  return lower === plural ? [lower] : [lower, plural]
}

const stripAvoid = (
  block: string,
): { definition: string; aliases: string[]; surfaceForms: string[] | undefined } => {
  const lines = block.split('\n')
  const aliases: string[] = []
  let parsedSurfaceForms: string[] | undefined
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    const avoidMatch = trimmed.match(/^_Avoid_:\s*(.*)$/i)
    if (avoidMatch) {
      const list = avoidMatch[1] ?? ''
      for (const a of list.split(',')) {
        const cleaned = a.trim()
        if (cleaned.length > 0) aliases.push(cleaned)
      }
      continue
    }
    const sfMatch = trimmed.match(/^_Surface forms_:\s*(.*)$/i)
    if (sfMatch) {
      const list = sfMatch[1] ?? ''
      parsedSurfaceForms = list
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      continue
    }
    kept.push(line)
  }
  return { definition: kept.join('\n').trim(), aliases, surfaceForms: parsedSurfaceForms }
}

export const parseGlossary = (text: string): GlossaryDoc => {
  const idx = text.indexOf(`\n${LANGUAGE_HEADING}`)
  if (idx === -1) {
    return { preamble: text, terms: [], trailer: '' }
  }
  const preamble = text.slice(0, idx).replace(/\n+$/, '') + '\n'
  const after = text.slice(idx + 1)
  const nextHeadingMatch = after.slice(LANGUAGE_HEADING.length).match(/\n## /)
  const languageEnd =
    nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? LANGUAGE_HEADING.length + nextHeadingMatch.index
      : after.length
  const languageBody = after.slice(LANGUAGE_HEADING.length, languageEnd)
  const trailer = after.slice(languageEnd)

  const terms: GlossaryTerm[] = []
  const blocks = languageBody.split(/\n(?=\*\*[^*]+\*\*\s*:)/)
  for (const raw of blocks) {
    const block = raw.trim()
    if (block.length === 0) continue
    const match = block.match(/^\*\*([^*]+)\*\*\s*:\s*([\s\S]*)$/)
    if (!match) continue
    const term = match[1].trim()
    const rest = match[2] ?? ''
    const { definition, aliases, surfaceForms } = stripAvoid(rest)
    terms.push({
      term,
      definition,
      aliases,
      surfaceForms: surfaceForms ?? generateDefaultSurfaceForms(term),
    })
  }

  return { preamble, terms, trailer }
}

export const renderGlossary = (doc: GlossaryDoc): string => {
  const preamble = doc.preamble.trim().length > 0 ? `${doc.preamble.trim()}\n\n` : `${HEADER}\n`
  const termBlocks = doc.terms.map((t) => {
    const aliases = t.aliases.length > 0 ? `\n_Avoid_: ${t.aliases.join(', ')}` : ''
    const defaults = generateDefaultSurfaceForms(t.term)
    const sfDiffers =
      t.surfaceForms.length !== defaults.length ||
      t.surfaceForms.some((f, i) => f !== defaults[i])
    const surfaceFormsLine = sfDiffers ? `\n_Surface forms_: ${t.surfaceForms.join(', ')}` : ''
    return `**${t.term}**:\n${t.definition.trim()}${aliases}${surfaceFormsLine}`
  })
  const language = `${LANGUAGE_HEADING}\n\n${termBlocks.join('\n\n')}\n`
  const trailer = doc.trailer.trim().length > 0 ? `\n${doc.trailer.trim()}\n` : ''
  return `${preamble}${language}${trailer}`
}

export const upsertTerm = (
  doc: GlossaryDoc,
  next: Omit<GlossaryTerm, 'surfaceForms'> & { readonly surfaceForms?: readonly string[] },
): GlossaryDoc => {
  const term: GlossaryTerm = {
    ...next,
    surfaceForms: next.surfaceForms ?? generateDefaultSurfaceForms(next.term),
  }
  const lower = term.term.toLowerCase()
  const found = doc.terms.findIndex((t) => t.term.toLowerCase() === lower)
  if (found === -1) {
    return { ...doc, terms: [...doc.terms, term] }
  }
  const terms = [...doc.terms]
  terms[found] = term
  return { ...doc, terms }
}

export const removeTermByName = (
  doc: GlossaryDoc,
  term: string,
): { doc: GlossaryDoc; removed: boolean } => {
  const lower = term.toLowerCase()
  const next = doc.terms.filter((t) => t.term.toLowerCase() !== lower)
  if (next.length === doc.terms.length) return { doc, removed: false }
  return { doc: { ...doc, terms: next }, removed: true }
}

export const readGlossaryFile = async (path: string): Promise<GlossaryDoc> => {
  try {
    const text = await readFile(path, 'utf8')
    return parseGlossary(text)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { preamble: '', terms: [], trailer: '' }
    }
    throw err
  }
}

export const writeGlossaryFile = async (
  path: string,
  doc: GlossaryDoc,
): Promise<void> => {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, renderGlossary(doc), 'utf8')
}
