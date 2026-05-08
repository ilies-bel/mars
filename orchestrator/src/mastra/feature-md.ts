import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { resolveContext } from './context'

export interface FeatureMarkdown {
  id: string
  goal: string
  status: string
  origin: string
  story: string
  technical: string
  acceptance: string[]
  source: 'markdown'
}

const featuresDir = (): string => {
  const { repoRoot } = resolveContext()
  return resolve(repoRoot, 'features')
}

const parseFrontmatter = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== '---') return out
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') break
    const idx = lines[i].indexOf(':')
    if (idx === -1) continue
    const key = lines[i].slice(0, idx).trim()
    const value = lines[i].slice(idx + 1).trim()
    out[key] = value
  }
  return out
}

const stripFrontmatter = (raw: string): string => {
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== '---') return raw
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return lines.slice(i + 1).join('\n')
  }
  return raw
}

const splitSections = (
  body: string,
): { goal: string; story: string; technical: string; acceptance: string[] } => {
  const lines = body.split(/\r?\n/)
  let goal = ''
  let storyLines: string[] = []
  let techLines: string[] = []
  let section: 'pre' | 'story' | 'technical' = 'pre'

  for (const line of lines) {
    if (/^#\s+/.test(line) && section === 'pre') {
      goal = line.replace(/^#\s+/, '').trim()
      continue
    }
    if (/^##\s+Story\b/i.test(line)) {
      section = 'story'
      continue
    }
    if (/^##\s+Technical\b/i.test(line)) {
      section = 'technical'
      continue
    }
    if (/^##\s+/.test(line)) {
      section = 'pre'
      continue
    }
    if (section === 'story') storyLines.push(line)
    else if (section === 'technical') techLines.push(line)
  }

  const acceptance: string[] = []
  let inAcceptance = false
  const storyKept: string[] = []
  for (const line of storyLines) {
    if (/^\*\*Acceptance\*\*/i.test(line.trim())) {
      inAcceptance = true
      continue
    }
    if (inAcceptance) {
      const m = line.match(/^\s*[-*]\s+(.*)$/)
      if (m) {
        acceptance.push(m[1].trim())
        continue
      }
      if (line.trim() === '') continue
      inAcceptance = false
    }
    storyKept.push(line)
  }

  return {
    goal,
    story: storyKept.join('\n').trim(),
    technical: techLines.join('\n').trim(),
    acceptance,
  }
}

export const readFeatureMarkdown = (id: string): FeatureMarkdown | null => {
  const path = join(featuresDir(), `${id}.md`)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const fm = parseFrontmatter(raw)
  const body = stripFrontmatter(raw)
  const { goal, story, technical, acceptance } = splitSections(body)
  return {
    id: fm.id ?? id,
    goal,
    status: fm.status ?? 'draft',
    origin: fm.origin ?? 'user',
    story,
    technical,
    acceptance,
    source: 'markdown',
  }
}

export const listFeatureMarkdownIds = (): string[] => {
  const dir = featuresDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
}
