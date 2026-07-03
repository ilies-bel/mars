import { execSync } from 'node:child_process'

export type AuthorKind = 'human' | 'agent'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Return the originating Claude Code session UUID from the environment, or
 * null when the var is absent or malformed.
 *
 * Claude Code exports CLAUDE_CODE_SESSION_ID=<uuid> into every Bash
 * subprocess (verified on Claude Code 2.1.175). The guard rejects
 * non-UUID values so test overrides can't accidentally poison the column.
 */
export const detectOriginSession = (
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const val = env.CLAUDE_CODE_SESSION_ID
  if (typeof val === 'string' && UUID_RE.test(val)) return val
  return null
}

export interface Author {
  kind: AuthorKind
  name: string
}

const AGENT_ENV_VARS = [
  'MARS_AGENT_NAME',
  'CLAUDE_CODE',
  'CLAUDECODE',
  'CLAUDE_AGENT',
  'ANTHROPIC_AGENT',
] as const

const isAgentEnv = (env: NodeJS.ProcessEnv): boolean =>
  AGENT_ENV_VARS.some((k) => {
    const v = env[k]
    return v !== undefined && v !== '' && v !== '0'
  })

const readGitIdentity = (): string | null => {
  try {
    const email = execSync('git config --get user.email', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (email.length > 0) return email
  } catch {
    // ignore
  }
  try {
    const name = execSync('git config --get user.name', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (name.length > 0) return name
  } catch {
    // ignore
  }
  return null
}

export const detectAuthor = (env: NodeJS.ProcessEnv = process.env): Author => {
  if (isAgentEnv(env)) {
    const name = env.MARS_AGENT_NAME?.trim() || 'agent'
    return { kind: 'agent', name }
  }
  const name = readGitIdentity() ?? env.USER ?? 'unknown'
  return { kind: 'human', name }
}

export const parseAuthorFlag = (raw: string): Author => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('--author requires a value (e.g. human:alice or agent:vega)')
  }
  const colon = trimmed.indexOf(':')
  if (colon === -1) {
    if (trimmed === 'human' || trimmed === 'agent') {
      return { kind: trimmed, name: trimmed === 'agent' ? 'agent' : 'unknown' }
    }
    return { kind: 'human', name: trimmed }
  }
  const kindRaw = trimmed.slice(0, colon).toLowerCase()
  const name = trimmed.slice(colon + 1).trim()
  if (kindRaw !== 'human' && kindRaw !== 'agent') {
    throw new Error(
      `--author kind must be 'human' or 'agent' (got '${kindRaw}')`,
    )
  }
  if (name.length === 0) {
    throw new Error(`--author name cannot be empty`)
  }
  return { kind: kindRaw, name }
}

export const resolveAuthor = (
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Author => {
  if (flagValue !== undefined) return parseAuthorFlag(flagValue)
  return detectAuthor(env)
}

export const formatAuthor = (author: Author | null): string => {
  if (!author) return '-'
  return `${author.kind}:${author.name}`
}
