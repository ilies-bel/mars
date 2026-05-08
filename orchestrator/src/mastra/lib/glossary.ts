import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface GlossaryTerm {
  term: string
  definition: string
  aliases: readonly string[]
}

export interface GlossaryDoc {
  preamble: string
  terms: readonly GlossaryTerm[]
  trailer: string
}

const HEADER = '# Project Context\n\nCanonical domain terms for this project. Edited via `mars glossary`.\n'
const LANGUAGE_HEADING = '## Language'

const stripAvoid = (block: string): { definition: string; aliases: string[] } => {
  const lines = block.split('\n')
  const aliases: string[] = []
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    const match = trimmed.match(/^_Avoid_:\s*(.*)$/i)
    if (match) {
      const list = match[1] ?? ''
      for (const a of list.split(',')) {
        const cleaned = a.trim()
        if (cleaned.length > 0) aliases.push(cleaned)
      }
      continue
    }
    kept.push(line)
  }
  return { definition: kept.join('\n').trim(), aliases }
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
    const { definition, aliases } = stripAvoid(rest)
    terms.push({ term, definition, aliases })
  }

  return { preamble, terms, trailer }
}

export const renderGlossary = (doc: GlossaryDoc): string => {
  const preamble = doc.preamble.trim().length > 0 ? `${doc.preamble.trim()}\n\n` : `${HEADER}\n`
  const termBlocks = doc.terms.map((t) => {
    const aliases =
      t.aliases.length > 0 ? `\n_Avoid_: ${t.aliases.join(', ')}` : ''
    return `**${t.term}**:\n${t.definition.trim()}${aliases}`
  })
  const language = `${LANGUAGE_HEADING}\n\n${termBlocks.join('\n\n')}\n`
  const trailer = doc.trailer.trim().length > 0 ? `\n${doc.trailer.trim()}\n` : ''
  return `${preamble}${language}${trailer}`
}

export const upsertTerm = (doc: GlossaryDoc, next: GlossaryTerm): GlossaryDoc => {
  const lower = next.term.toLowerCase()
  const found = doc.terms.findIndex((t) => t.term.toLowerCase() === lower)
  if (found === -1) {
    return { ...doc, terms: [...doc.terms, next] }
  }
  const terms = [...doc.terms]
  terms[found] = next
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
