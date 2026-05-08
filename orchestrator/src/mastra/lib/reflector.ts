import { runClaudeCode } from './git'
import { getRepoRoot } from '../context'
import { insertSuggestion } from '../queue'
import type { ReflectCorpusEntry } from './reflect-query'

export interface ReflectionSuggestion {
  title: string
  prompt: string
  rationale: string | null
}

export interface ReflectionResult {
  suggestions: ReflectionSuggestion[]
  rawOutput: string
  exitCode: number
}

const SYNTHESIS_INSTRUCTIONS = `You are a workflow optimizer for the Mars task orchestrator. You will be
given recent task data — prompts, final status, scorer scores, per-step
token totals, error tails. Identify, in order of priority:

(a) **token sinks**: steps whose token consumption is disproportionate to
    the value delivered. Cite the step id and the offending task ids.
(b) **failure clusters**: tasks that share a verify-failed root cause
    (typecheck vs test vs lint) or repeated merge aborts.
(c) **workflow drift**: repeated vcs-supervisor invocations, prompt
    patterns that consistently fail, or cache-miss patterns
    (cache_create_tokens >> cache_read_tokens).

Output a single JSON document on stdout, with no prose, no code fences,
no markdown — just the JSON. Shape:

{
  "suggestions": [
    {
      "title": "short imperative title (≤ 60 chars)",
      "prompt": "self-contained Mars task prompt that a fresh agent can act on without further context. Include file paths, the symptom, the suggested fix, and the verification command. End with 'Save your work.'",
      "rationale": "1–2 sentences citing the evidence (task ids, token counts, error patterns)"
    }
  ]
}

Rules:
- At most 5 suggestions. Fewer is better.
- Each suggestion must be actionable today, not aspirational.
- Drop suggestions you cannot ground in the data.
- If there are no high-quality suggestions, return {"suggestions": []}.`

const buildPrompt = (corpus: ReflectCorpusEntry[]): string => {
  const corpusJson = JSON.stringify(corpus, null, 2)
  return `${SYNTHESIS_INSTRUCTIONS}

Recent task corpus (newest first):
${corpusJson}`
}

interface ParsedDocument {
  suggestions?: unknown
}

const extractFirstJsonDocument = (text: string): unknown | null => {
  const trimmed = text.trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const collectAssistantText = (
  conversation: ReadonlyArray<{ type: string; [k: string]: unknown }>,
): string => {
  const parts: string[] = []
  for (const event of conversation) {
    if (event.type !== 'assistant') continue
    const message = event.message as { content?: unknown } | undefined
    if (!message) continue
    const content = message.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          parts.push((block as { text: string }).text)
        }
      }
    }
  }
  return parts.join('\n')
}

export const runReflector = async (
  corpus: ReflectCorpusEntry[],
  timeoutMs: number = 90 * 1000,
): Promise<ReflectionResult> => {
  if (corpus.length === 0) {
    return { suggestions: [], rawOutput: '', exitCode: 0 }
  }

  const r = await runClaudeCode({
    cwd: getRepoRoot(),
    prompt: buildPrompt(corpus),
    timeoutMs,
    model: 'haiku',
  })

  const text = collectAssistantText(r.conversation) || r.stdout
  const parsed = extractFirstJsonDocument(text) as ParsedDocument | null
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return { suggestions: [], rawOutput: text, exitCode: r.exitCode }
  }

  const suggestions: ReflectionSuggestion[] = []
  for (const raw of parsed.suggestions) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : ''
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : null
    if (!title || !prompt) continue
    suggestions.push({ title, prompt, rationale: rationale || null })
  }

  return { suggestions: suggestions.slice(0, 5), rawOutput: text, exitCode: r.exitCode }
}

export const persistSuggestions = async (
  suggestions: readonly ReflectionSuggestion[],
  sourceTaskId: string,
): Promise<void> => {
  for (const s of suggestions) {
    await insertSuggestion({
      sourceTaskId,
      title: s.title,
      prompt: s.prompt,
      rationale: s.rationale,
    })
  }
}
