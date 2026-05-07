import { runSubprocess, type RunSubprocessResult } from '../mastra/lib/git'
import type { SupervisorSpec } from './detect-stack'
import { filterExternalMarkdown } from './render'

const FETCH_PROMPT = (query: string): string => `You have a single task: fetch a specialist agent definition from the public directory at https://github.com/ayush-that/sub-agents.directory that matches the query below.

Query: ${query}

Use the WebFetch tool to browse the directory's README/index, then fetch the matching agent's raw markdown body (frontmatter + content).

Output rules — read carefully:
- Print ONLY the raw markdown body of the matched agent. No commentary. No code fence around it.
- If you cannot find a reasonable match after one or two fetches, print exactly the literal string: NONE
- Do not invent content. Do not summarize. Either return the upstream markdown verbatim or return NONE.`

const EXTRACT_PROMPT = (spec: SupervisorSpec, filtered: string): string => `You are extracting structured fields from a community-sourced specialist agent definition for the "${spec.name}" supervisor (persona: ${spec.persona}, role: ${spec.kind}, focus: ${spec.externalQuery}).

The upstream content has already been filtered (long code examples and tutorial sections stripped). Your job is to pull out the WHAT and WHY (standards, scope, tech stack list), not the HOW.

Return ONLY a single JSON object on stdout, no surrounding prose, with these string fields:

{
  "specialty": "one sentence describing this supervisor's specialty",
  "techStack": "markdown bullet list of technologies/frameworks/libraries this supervisor knows (names only, no examples)",
  "scopeHandles": "markdown bullet list of what this supervisor handles",
  "scopeEscalates": "markdown bullet list of what this supervisor escalates to other supervisors / orchestrator",
  "standards": "markdown bullet list of coding standards, quality bars, conventions (no code examples)"
}

Keep each field concise. Total JSON should be well under 300 lines. Do not include code blocks. Do not include the word "Example".

Filtered upstream content:
---
${filtered}
---`

const TIMEOUT_FETCH = 5 * 60 * 1000
const TIMEOUT_EXTRACT = 5 * 60 * 1000

const runClaudeText = async (
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunSubprocessResult> => {
  const work = runSubprocess(
    'claude',
    ['-p', prompt, '--dangerously-skip-permissions'],
    cwd,
  )
  const timeout = new Promise<RunSubprocessResult>((resolveFn) =>
    setTimeout(
      () =>
        resolveFn({
          exitCode: 124,
          stdout: '',
          stderr: `claude timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    ),
  )
  return Promise.race([work, timeout])
}

export interface FetchedSpecialist {
  spec: SupervisorSpec
  rawMarkdown: string | null
  rawLines: number
}

export const fetchExternalSpecialist = async (
  spec: SupervisorSpec,
  cwd: string,
): Promise<FetchedSpecialist> => {
  const r = await runClaudeText(FETCH_PROMPT(spec.externalQuery), cwd, TIMEOUT_FETCH)
  const out = r.stdout.trim()
  if (r.exitCode !== 0 || out === '' || out === 'NONE' || out.toUpperCase() === 'NONE') {
    return { spec, rawMarkdown: null, rawLines: 0 }
  }
  return { spec, rawMarkdown: out, rawLines: out.split('\n').length }
}

export interface ExtractedFields {
  specialty: string
  techStack: string
  scopeHandles: string
  scopeEscalates: string
  standards: string
}

const tryParseJson = (text: string): ExtractedFields | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<ExtractedFields>
    if (
      typeof parsed.specialty === 'string' &&
      typeof parsed.techStack === 'string' &&
      typeof parsed.scopeHandles === 'string' &&
      typeof parsed.scopeEscalates === 'string' &&
      typeof parsed.standards === 'string'
    ) {
      return parsed as ExtractedFields
    }
  } catch {
    return null
  }
  return null
}

export const extractFields = async (
  spec: SupervisorSpec,
  rawMarkdown: string,
  cwd: string,
): Promise<ExtractedFields | null> => {
  const filtered = filterExternalMarkdown(rawMarkdown)
  const r = await runClaudeText(EXTRACT_PROMPT(spec, filtered), cwd, TIMEOUT_EXTRACT)
  if (r.exitCode !== 0) return null
  return tryParseJson(r.stdout)
}
