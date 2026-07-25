/**
 * Live smoke test for the chat provider: runs one real turn against the
 * ChatGPT/Codex backend using the local `~/.codex/auth.json` credentials.
 *
 *   pnpm tsx scripts/smoke-chat-oauth.ts [prompt]
 *
 * Prints every streamed segment as it arrives (so token-by-token streaming is
 * visible, not just the final text), then the usage totals. Exercises the real
 * shell tool: the default prompt asks a question that requires running `mars`.
 *
 * Not part of `vitest run` — it needs network access and a logged-in Codex CLI.
 */

import { runCodexOAuthTurn, resolveCodexOAuthConfig, loadCodexCredentials } from '../src/core/daemon/codex-oauth'
import { resolveChatSystemPrompt } from '../src/core/daemon/chat-system-prompt'

/**
 * `--history=<n>` pads the replayed history with n synthetic turns. Use it to
 * check prefix caching: automatic caching has a 1024-token minimum, so a short
 * thread (system prompt ~400 tokens) reports 0 cached and only longer threads —
 * the ones where replay actually costs something — see a hit.
 */
const historyArg = process.argv.find((a) => a.startsWith('--history='))
const historyTurns = historyArg ? Number(historyArg.split('=')[1]) : 0
const prompt = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') ||
  'How many commits are on the current branch? Use the shell tool, then answer with just the number.'

const paddedHistory = Array.from({ length: historyTurns }, (_, i) => ({
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  content: [{
    type: (i % 2 === 0 ? 'input_text' : 'output_text') as 'input_text' | 'output_text',
    text: `Turn ${i}: earlier in this thread we discussed the task queue, its worktrees, and how the reconciler decides which leases to reclaim.`,
  }],
}))

const repoRoot = process.cwd()
const config = resolveCodexOAuthConfig()
const credentials = await loadCodexCredentials()

console.log('config:', {
  model: config.model,
  effort: config.effort,
  maxToolTurns: config.maxToolTurns,
  allowlist: config.shellAllowlist === null ? 'DISABLED (unrestricted)' : `${config.shellAllowlist.length} prefixes`,
})
console.log('credentials:', credentials ? `loaded (account ${credentials.accountId ?? 'unknown'})` : 'MISSING — run `codex login`')
if (!credentials) process.exit(1)

const systemPrompt = await resolveChatSystemPrompt(repoRoot)
console.log(`system prompt: ${systemPrompt.length} chars (the cache prefix)\n`)

const startedAt = Date.now()
let firstSegmentAt: number | null = null

const result = await runCodexOAuthTurn({
  systemPrompt,
  history: paddedHistory,
  prompt,
  cwd: repoRoot,
  signal: AbortSignal.timeout(120_000),
  onSegment: (seg) => {
    firstSegmentAt ??= Date.now() - startedAt
    if (seg.type === 'text') process.stdout.write(seg.text)
    else if (seg.type === 'tool_use') console.log(`\n[tool_use ${seg.name}] ${JSON.stringify(seg.input)}`)
    else if (seg.type === 'tool_result') {
      const content = seg.content as { stdout?: string; stderr?: string; exitCode?: number }
      console.log(`[tool_result exit=${content.exitCode}] ${(content.stdout ?? content.stderr ?? '').trim().slice(0, 200)}`)
    } else if (seg.type === 'thinking') console.log(`\n[thinking] ${seg.thinking.slice(0, 200)}`)
  },
})

console.log('\n')
console.log('first segment after:', firstSegmentAt, 'ms')
console.log('total:', Date.now() - startedAt, 'ms')
console.log('result:', JSON.stringify(result))
if (result.ok) {
  const { inputTokens, cachedInputTokens } = result.usage
  const pct = inputTokens > 0 ? Math.round((cachedInputTokens / inputTokens) * 100) : 0
  console.log(`cache hit: ${cachedInputTokens}/${inputTokens} input tokens (${pct}%)`)
}
