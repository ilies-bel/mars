import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface AgentsBlockTarget {
  filePath: string
  supervisorName: string
  scope: string
  body: string
}

const sentinelOpen = (name: string, scope: string): string =>
  `<!-- mars-init:supervisor=${name}:scope=${scope} -->`

const sentinelClose = (name: string, scope: string): string =>
  `<!-- /mars-init:supervisor=${name}:scope=${scope} -->`

const buildBlock = (name: string, scope: string, body: string): string => {
  const trimmed = body.replace(/^\n+/, '').replace(/\n+$/, '')
  return `${sentinelOpen(name, scope)}\n${trimmed}\n${sentinelClose(name, scope)}`
}

const findBlockRange = (
  content: string,
  name: string,
  scope: string,
): { start: number; end: number } | null => {
  const open = sentinelOpen(name, scope)
  const close = sentinelClose(name, scope)
  const start = content.indexOf(open)
  if (start === -1) return null
  const closeStart = content.indexOf(close, start + open.length)
  if (closeStart === -1) return null
  return { start, end: closeStart + close.length }
}

const trimSurroundingBlankLines = (
  content: string,
  start: number,
  end: number,
): { start: number; end: number } => {
  let s = start
  let e = end
  while (s > 0 && content[s - 1] === '\n') s -= 1
  while (e < content.length && content[e] === '\n') e += 1
  return { start: s, end: e }
}

export const upsertAgentsBlock = (target: AgentsBlockTarget): void => {
  const { filePath, supervisorName, scope, body } = target
  const block = buildBlock(supervisorName, scope, body)

  mkdirSync(dirname(filePath), { recursive: true })

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${block}\n`, 'utf8')
    return
  }

  const existing = readFileSync(filePath, 'utf8')
  const range = findBlockRange(existing, supervisorName, scope)

  if (range) {
    const next = existing.slice(0, range.start) + block + existing.slice(range.end)
    if (next !== existing) writeFileSync(filePath, next, 'utf8')
    return
  }

  const needsLeadingBlank = existing.length > 0 && !existing.endsWith('\n\n')
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  const prefix = needsLeadingBlank && existing.length > 0 ? sep : ''
  const next = `${existing}${prefix}${block}\n`
  writeFileSync(filePath, next, 'utf8')
}

export const removeAgentsBlock = (
  filePath: string,
  supervisorName: string,
  scope: string,
): { removed: boolean; fileDeleted: boolean } => {
  if (!existsSync(filePath)) return { removed: false, fileDeleted: false }
  const existing = readFileSync(filePath, 'utf8')
  const range = findBlockRange(existing, supervisorName, scope)
  if (!range) return { removed: false, fileDeleted: false }

  const trimmed = trimSurroundingBlankLines(existing, range.start, range.end)
  const next = existing.slice(0, trimmed.start) + existing.slice(trimmed.end)

  if (next.trim().length === 0) {
    unlinkSync(filePath)
    return { removed: true, fileDeleted: true }
  }

  const normalised = next.endsWith('\n') ? next : `${next}\n`
  writeFileSync(filePath, normalised, 'utf8')
  return { removed: true, fileDeleted: false }
}

export const agentsMdPathForScope = (repoRoot: string, scope: string): string => {
  if (scope === '.' || scope === '') return resolve(repoRoot, 'AGENTS.md')
  const cleaned = scope.replace(/\/+$/, '')
  return resolve(repoRoot, cleaned, 'AGENTS.md')
}
