import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKER_CONFIGS } from '../../orchestrator/src/mastra/workers/index.ts'

// Public, read-only shape for the upcoming Agents page. Field names mirror
// the worker registry; `allowedTools` is exposed for parity with future
// agent definitions that pin an explicit allow-list (the orchestrator's
// Workers rely on an implicit allow-list — everything not denied — so the
// array is empty for those entries).
export interface AgentEntry {
  readonly name: string
  readonly model: string
  readonly effort: string | null
  readonly permissionMode: string | null
  readonly allowedTools: readonly string[]
  readonly deniedTools: readonly string[]
  readonly messageCap: number | null
  readonly role: string
}

const WORKER_ROLES: Record<string, string> = {
  Coder: 'implement',
  Planner: 'plan',
  Slicer: 'slice',
  Triager: 'triage',
  Fixer: 'fix',
}

const fromWorkerConfigs = (): AgentEntry[] => {
  return Object.values(WORKER_CONFIGS).map((config) => ({
    name: config.name,
    model: config.model,
    effort: config.effort,
    permissionMode: config.permissionMode,
    allowedTools: [],
    deniedTools: [...config.disallowedTools],
    messageCap: config.maxMessages,
    role: WORKER_ROLES[config.name] ?? config.name.toLowerCase(),
  }))
}

// Minimal YAML frontmatter parser scoped to the keys we need from
// `.claude/agents/<name>.md`. The frontmatter ships from this repo so we
// know its shape; we deliberately do not pull in a YAML dependency.
const parseSupervisorFrontmatter = (
  source: string,
): { name?: string; model?: string; tools: string[] } | null => {
  if (!source.startsWith('---')) return null
  const end = source.indexOf('\n---', 3)
  if (end === -1) return null
  const body = source.slice(3, end)
  const out: { name?: string; model?: string; tools: string[] } = {
    tools: [],
  }
  const lines = body.split('\n')
  let inTools = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (inTools) {
      const m = line.match(/^\s+-\s+(\S.*)$/)
      if (m) {
        out.tools.push(m[1].trim())
        continue
      }
      // exit tools block when we hit a non-list line
      inTools = false
    }
    if (line.startsWith('name:')) {
      out.name = line.slice('name:'.length).trim()
    } else if (line.startsWith('model:')) {
      out.model = line.slice('model:'.length).trim()
    } else if (line.startsWith('tools:')) {
      inTools = true
    }
  }
  return out
}

const fromVcsSupervisor = async (
  repoRoot: string,
): Promise<AgentEntry | null> => {
  const path = join(repoRoot, '.claude', 'agents', 'vcs-supervisor.md')
  try {
    const source = await readFile(path, 'utf8')
    const fm = parseSupervisorFrontmatter(source)
    if (!fm?.model) return null
    return {
      // Use 'Vega' as the canonical worker name so that the sessions endpoint
      // (which queries "workerName":"Vega" in step_ended payloads) returns the
      // conflicted-merge Sessions recorded by the merge step span.
      name: 'Vega',
      model: fm.model,
      effort: null,
      permissionMode: null,
      allowedTools: fm.tools,
      deniedTools: [],
      messageCap: null,
      role: 'vcs-supervisor',
    }
  } catch {
    return null
  }
}

export const loadAgents = async (repoRoot: string): Promise<AgentEntry[]> => {
  const workers = fromWorkerConfigs()
  const supervisor = await fromVcsSupervisor(repoRoot)
  return supervisor ? [...workers, supervisor] : workers
}
