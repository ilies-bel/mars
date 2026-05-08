import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  createWorktree,
  resolveSha,
  runClaudeCode,
  verifyChanges,
} from '../lib/git'
import type { ClaudeEvent } from '../lib/claude-stream'
import { summarizeUsage } from '../lib/claude-usage'
import { getRepoRoot } from '../context'

const exec = promisify(execFile)

const DIFF_BYTE_CAP = 200 * 1024

const variantConfigSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
})

const variantLabelSchema = z.enum(['A', 'B'])

const usageTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreateTokens: z.number(),
  cacheReadTokens: z.number(),
  totalCostUsd: z.number(),
  messageCount: z.number(),
})

const verifyStepSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  output: z.string(),
})

const verifyResultSchema = z.object({
  passed: z.boolean(),
  steps: z.array(verifyStepSchema),
})

const variantRunSchema = z.object({
  label: variantLabelSchema,
  config: variantConfigSchema,
  worktreePath: z.string(),
  branch: z.string(),
  claudeExitCode: z.number(),
  claudeSessionId: z.string().nullable(),
  usage: usageTotalsSchema,
  verifyResult: verifyResultSchema,
  wallClockMs: z.number(),
})

const diffStatsSchema = z.object({
  patch: z.string(),
  patchTruncated: z.boolean(),
  changedFiles: z.array(z.string()),
  additions: z.number(),
  deletions: z.number(),
})

const variantWithDiffSchema = variantRunSchema.extend({
  diff: diffStatsSchema,
})

const rubricSchema = z.object({
  correctness: z.number().min(0).max(10),
  completeness: z.number().min(0).max(10),
  unnecessaryChanges: z.number().min(0).max(10),
  mistakes: z.array(z.string()),
  rationale: z.string(),
})

const judgeOutputSchema = z.object({
  variant1: rubricSchema,
  variant2: rubricSchema,
  overallRationale: z.string(),
})

const reportSchema = z.object({
  experimentId: z.string(),
  baseSha: z.string(),
  instruction: z.string(),
  variants: z.array(
    variantWithDiffSchema.extend({
      rubric: rubricSchema,
    }),
  ),
  judgeRationale: z.string(),
  tokensWinner: z.enum(['A', 'B', 'tie']),
})

const inputSchema = z.object({
  instruction: z.string().min(1),
  variants: z.array(variantConfigSchema).length(2),
  integrationBranch: z.string().default('main'),
  experimentId: z.string().default(() => randomUUID().slice(0, 8)),
})

const pinBaseStep = createStep({
  id: 'pin-base',
  inputSchema,
  outputSchema: inputSchema.extend({
    baseSha: z.string(),
  }),
  execute: async ({ inputData }) => {
    const baseSha = await resolveSha(inputData.integrationBranch)
    return { ...inputData, baseSha }
  },
})

interface VariantRunArgs {
  label: 'A' | 'B'
  config: z.infer<typeof variantConfigSchema>
  experimentId: string
  baseSha: string
  integrationBranch: string
}

const resolveVerifyCwd = (worktreeRoot: string): string => {
  const hasProject = (dir: string): boolean =>
    existsSync(resolve(dir, 'package.json')) &&
    existsSync(resolve(dir, 'tsconfig.json'))
  if (hasProject(worktreeRoot)) return worktreeRoot
  const orchestrator = resolve(worktreeRoot, 'orchestrator')
  if (hasProject(orchestrator)) return orchestrator
  return worktreeRoot
}

const runSingleVariant = async ({
  label,
  config,
  experimentId,
  baseSha,
  integrationBranch,
}: VariantRunArgs): Promise<z.infer<typeof variantRunSchema>> => {
  const startedAt = Date.now()
  const ref = await createWorktree({
    taskId: experimentId,
    integrationBranch,
    baseSha,
    branchSuffix: label,
  })
  const conversation: ClaudeEvent[] = []
  const sessionId = randomUUID()
  const r = await runClaudeCode({
    cwd: ref.path,
    prompt: config.prompt,
    timeoutMs: 20 * 60 * 1000,
    model: config.model,
    systemPrompt: config.systemPrompt,
    sessionId,
    onEvent: async (event) => {
      conversation.push(event)
    },
  })
  const usage = summarizeUsage(conversation)
  const verifyCwd = resolveVerifyCwd(ref.path)
  const verifyResult = await verifyChanges({
    cwd: verifyCwd,
    typecheckCmd: ['npx', ['tsc', '--noEmit']],
    testCmd: ['npm', ['test', '--silent']],
    lintCmd: ['npx', ['biome', 'check', '.']],
  })
  const wallClockMs = Date.now() - startedAt
  return {
    label,
    config,
    worktreePath: ref.path,
    branch: ref.branch,
    claudeExitCode: r.exitCode,
    claudeSessionId: r.sessionId,
    usage,
    verifyResult,
    wallClockMs,
  }
}

const runVariantsStep = createStep({
  id: 'run-variants',
  inputSchema: inputSchema.extend({ baseSha: z.string() }),
  outputSchema: z.object({
    instruction: z.string(),
    integrationBranch: z.string(),
    experimentId: z.string(),
    baseSha: z.string(),
    variants: z.array(variantRunSchema).length(2),
  }),
  execute: async ({ inputData, tracingContext }) => {
    const [a, b] = await Promise.all([
      runSingleVariant({
        label: 'A',
        config: inputData.variants[0],
        experimentId: inputData.experimentId,
        baseSha: inputData.baseSha,
        integrationBranch: inputData.integrationBranch,
      }),
      runSingleVariant({
        label: 'B',
        config: inputData.variants[1],
        experimentId: inputData.experimentId,
        baseSha: inputData.baseSha,
        integrationBranch: inputData.integrationBranch,
      }),
    ])
    tracingContext?.currentSpan?.update({
      metadata: {
        variantUsage: { A: a.usage, B: b.usage },
        variantWallClockMs: { A: a.wallClockMs, B: b.wallClockMs },
        variantVerified: { A: a.verifyResult.passed, B: b.verifyResult.passed },
      },
    })
    return {
      instruction: inputData.instruction,
      integrationBranch: inputData.integrationBranch,
      experimentId: inputData.experimentId,
      baseSha: inputData.baseSha,
      variants: [a, b],
    }
  },
})

const collectDiffForVariant = async (
  worktreePath: string,
  baseSha: string,
): Promise<z.infer<typeof diffStatsSchema>> => {
  const range = `${baseSha}..HEAD`
  let patch = ''
  let patchTruncated = false
  try {
    const { stdout } = await exec('git', ['diff', range], {
      cwd: worktreePath,
      maxBuffer: DIFF_BYTE_CAP * 4,
    })
    if (stdout.length > DIFF_BYTE_CAP) {
      patch = `${stdout.slice(0, DIFF_BYTE_CAP)}\n…[truncated]`
      patchTruncated = true
    } else {
      patch = stdout
    }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    patch = `(diff failed: ${e.message ?? 'unknown error'})`
  }

  let changedFiles: string[] = []
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--name-only', range],
      { cwd: worktreePath, maxBuffer: 1024 * 1024 },
    )
    changedFiles = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } catch {
    changedFiles = []
  }

  let additions = 0
  let deletions = 0
  try {
    const { stdout } = await exec(
      'git',
      ['diff', '--numstat', range],
      { cwd: worktreePath, maxBuffer: 1024 * 1024 },
    )
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const add = Number(parts[0])
      const del = Number(parts[1])
      if (Number.isFinite(add)) additions += add
      if (Number.isFinite(del)) deletions += del
    }
  } catch {
    // ignore stat failures
  }

  return { patch, patchTruncated, changedFiles, additions, deletions }
}

const collectDiffsStep = createStep({
  id: 'collect-diffs',
  inputSchema: z.object({
    instruction: z.string(),
    integrationBranch: z.string(),
    experimentId: z.string(),
    baseSha: z.string(),
    variants: z.array(variantRunSchema).length(2),
  }),
  outputSchema: z.object({
    instruction: z.string(),
    integrationBranch: z.string(),
    experimentId: z.string(),
    baseSha: z.string(),
    variants: z.array(variantWithDiffSchema).length(2),
  }),
  execute: async ({ inputData }) => {
    const withDiffs = await Promise.all(
      inputData.variants.map(async (v) => ({
        ...v,
        diff: await collectDiffForVariant(v.worktreePath, inputData.baseSha),
      })),
    )
    return {
      instruction: inputData.instruction,
      integrationBranch: inputData.integrationBranch,
      experimentId: inputData.experimentId,
      baseSha: inputData.baseSha,
      variants: [withDiffs[0], withDiffs[1]],
    }
  },
})

const buildJudgePrompt = (args: {
  instruction: string
  variant1Patch: string
  variant1Verify: z.infer<typeof verifyResultSchema>
  variant2Patch: string
  variant2Verify: z.infer<typeof verifyResultSchema>
}): string => {
  const verifySummary = (v: z.infer<typeof verifyResultSchema>): string => {
    if (v.steps.length === 0) return 'no verification steps ran'
    return v.steps
      .map((s) => `${s.name}: ${s.passed ? 'pass' : 'fail'}${s.passed ? '' : `\n${s.output.slice(0, 1000)}`}`)
      .join('\n')
  }
  return `You are an impartial code-review judge. Two coding agents (Variant 1, Variant 2) were given the same instruction and produced two diffs. Score each on a structured rubric.

# Original instruction
${args.instruction}

# Variant 1
## Verification
${verifySummary(args.variant1Verify)}

## Diff
\`\`\`diff
${args.variant1Patch || '(empty diff)'}
\`\`\`

# Variant 2
## Verification
${verifySummary(args.variant2Verify)}

## Diff
\`\`\`diff
${args.variant2Patch || '(empty diff)'}
\`\`\`

# Rubric (per variant)
- correctness: 0–10. Does the diff actually do what the instruction asks?
- completeness: 0–10. Are all parts of the instruction addressed?
- unnecessaryChanges: 0–10 where 10 means NO unnecessary changes (perfectly minimal). Lower means more bloat/scope creep.
- mistakes: array of short strings naming concrete defects (bugs, regressions, scope creep, missing pieces, failing verification).
- rationale: 1–3 sentences justifying the scores.

If a variant's verification failed or its diff is empty, note that explicitly in mistakes.

# Output
Output a single JSON document on stdout, no prose, no code fences. Shape:
{
  "variant1": { "correctness": 0, "completeness": 0, "unnecessaryChanges": 0, "mistakes": [], "rationale": "" },
  "variant2": { "correctness": 0, "completeness": 0, "unnecessaryChanges": 0, "mistakes": [], "rationale": "" },
  "overallRationale": "1–3 sentences comparing the two variants and naming the stronger result."
}`
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
  conversation: readonly ClaudeEvent[],
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

const callJudge = async (
  prompt: string,
): Promise<{
  parsed: z.infer<typeof judgeOutputSchema> | null
  rawOutput: string
  exitCode: number
}> => {
  const r = await runClaudeCode({
    cwd: getRepoRoot(),
    prompt,
    timeoutMs: 5 * 60 * 1000,
    model: 'sonnet',
  })
  const text = collectAssistantText(r.conversation) || r.stdout
  const raw = extractFirstJsonDocument(text)
  if (!raw) return { parsed: null, rawOutput: text, exitCode: r.exitCode }
  const result = judgeOutputSchema.safeParse(raw)
  if (!result.success) {
    return { parsed: null, rawOutput: text, exitCode: r.exitCode }
  }
  return { parsed: result.data, rawOutput: text, exitCode: r.exitCode }
}

const judgeStep = createStep({
  id: 'judge',
  inputSchema: z.object({
    instruction: z.string(),
    integrationBranch: z.string(),
    experimentId: z.string(),
    baseSha: z.string(),
    variants: z.array(variantWithDiffSchema).length(2),
  }),
  outputSchema: z.object({
    instruction: z.string(),
    integrationBranch: z.string(),
    experimentId: z.string(),
    baseSha: z.string(),
    variants: z.array(variantWithDiffSchema).length(2),
    judge: judgeOutputSchema,
    judgeMapping: z.object({
      variant1: variantLabelSchema,
      variant2: variantLabelSchema,
    }),
  }),
  execute: async ({ inputData, tracingContext }) => {
    // Randomize blinding
    const flipForBlinding = Math.random() < 0.5
    const variant1 = flipForBlinding ? inputData.variants[1] : inputData.variants[0]
    const variant2 = flipForBlinding ? inputData.variants[0] : inputData.variants[1]
    const judgeMapping = {
      variant1: variant1.label,
      variant2: variant2.label,
    }

    const prompt = buildJudgePrompt({
      instruction: inputData.instruction,
      variant1Patch: variant1.diff.patch,
      variant1Verify: variant1.verifyResult,
      variant2Patch: variant2.diff.patch,
      variant2Verify: variant2.verifyResult,
    })

    let attempt = await callJudge(prompt)
    if (!attempt.parsed) {
      attempt = await callJudge(
        `${prompt}\n\nPrevious output failed to parse — return ONLY the JSON document.`,
      )
    }
    if (!attempt.parsed) {
      throw new Error(
        `judge failed to produce valid rubric JSON after retry. raw output (first 500 chars): ${attempt.rawOutput.slice(0, 500)}`,
      )
    }

    tracingContext?.currentSpan?.update({
      metadata: {
        judgeRubric: attempt.parsed,
        judgeMapping,
      },
    })

    return {
      instruction: inputData.instruction,
      integrationBranch: inputData.integrationBranch,
      experimentId: inputData.experimentId,
      baseSha: inputData.baseSha,
      variants: inputData.variants,
      judge: attempt.parsed,
      judgeMapping,
    }
  },
})

const reportStep = createStep({
  id: 'report',
  inputSchema: z.object({
    instruction: z.string(),
    integrationBranch: z.string(),
    experimentId: z.string(),
    baseSha: z.string(),
    variants: z.array(variantWithDiffSchema).length(2),
    judge: judgeOutputSchema,
    judgeMapping: z.object({
      variant1: variantLabelSchema,
      variant2: variantLabelSchema,
    }),
  }),
  outputSchema: reportSchema,
  execute: async ({ inputData, tracingContext }) => {
    const rubricByLabel: Record<'A' | 'B', z.infer<typeof rubricSchema>> = {
      A: emptyRubric(),
      B: emptyRubric(),
    }
    rubricByLabel[inputData.judgeMapping.variant1] = inputData.judge.variant1
    rubricByLabel[inputData.judgeMapping.variant2] = inputData.judge.variant2

    const variantsWithRubric = inputData.variants.map((v) => ({
      ...v,
      rubric: rubricByLabel[v.label],
    }))

    const tokensA =
      inputData.variants[0].usage.inputTokens +
      inputData.variants[0].usage.outputTokens +
      inputData.variants[0].usage.cacheCreateTokens
    const tokensB =
      inputData.variants[1].usage.inputTokens +
      inputData.variants[1].usage.outputTokens +
      inputData.variants[1].usage.cacheCreateTokens
    const tokensWinner: 'A' | 'B' | 'tie' =
      tokensA === tokensB ? 'tie' : tokensA < tokensB ? 'A' : 'B'

    const report: z.infer<typeof reportSchema> = {
      experimentId: inputData.experimentId,
      baseSha: inputData.baseSha,
      instruction: inputData.instruction,
      variants: variantsWithRubric,
      judgeRationale: inputData.judge.overallRationale,
      tokensWinner,
    }

    tracingContext?.currentSpan?.update({
      metadata: {
        abReport: report,
        tokensWinner,
        tokensTotals: { A: tokensA, B: tokensB },
      },
    })

    return report
  },
})

const emptyRubric = (): z.infer<typeof rubricSchema> => ({
  correctness: 0,
  completeness: 0,
  unnecessaryChanges: 0,
  mistakes: [],
  rationale: '',
})

export const abExperimentWorkflow = createWorkflow({
  id: 'ab-experiment',
  inputSchema,
  outputSchema: reportSchema,
})
  .then(pinBaseStep)
  .then(runVariantsStep)
  .then(collectDiffsStep)
  .then(judgeStep)
  .then(reportStep)
  .commit()

export type AbExperimentReport = z.infer<typeof reportSchema>
export type AbVariantConfig = z.infer<typeof variantConfigSchema>
