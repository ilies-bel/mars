import type { Command } from '../command'

const providerFrom = (value: string | undefined): 'claude' | 'codex' | null =>
  value === undefined || value === 'codex' || value === 'claude' ? (value ?? 'codex') : null

const stewardGroup: Command = {
  path: 'steward',
  summary: 'inspect, optimize, or revert Mars-owned Worker prompt instructions',
  usage: 'usage: mars steward <inspect|optimize|revert>',
  run: (_args, deps) => {
    deps.err('usage: mars steward <inspect|optimize|revert>')
    return { code: 1 }
  },
}

const stewardInspect: Command = {
  path: 'steward inspect',
  summary: 'measure a Worker prompt through the production composition path',
  usage: 'usage: mars steward inspect Coder [--provider codex|claude]',
  run: async (args, deps) => {
    if (args.positional[0] !== 'Coder' || args.positional.length !== 1) {
      deps.err('usage: mars steward inspect Coder [--provider codex|claude]')
      return { code: 1 }
    }
    const provider = providerFrom(args.flags['--provider'])
    if (!provider) {
      deps.err('--provider must be codex or claude')
      return { code: 1 }
    }
    const { measureWorkerDispatchPrompt } = await import('../../workflows/primitives/shared')
    const report = measureWorkerDispatchPrompt('Coder', 'Implement the requested change.', provider)
    deps.out(JSON.stringify(report, null, 2))
    return { code: 0, value: report }
  },
}

const stewardOptimize: Command = {
  path: 'steward optimize',
  summary: 'run the Steward prompt proposer for a Worker',
  usage: 'usage: mars steward optimize Coder [--provider codex|claude]',
  run: async (args, deps) => {
    if (args.positional[0] !== 'Coder' || args.positional.length !== 1) {
      deps.err('usage: mars steward optimize Coder [--provider codex|claude]')
      return { code: 1 }
    }
    const provider = providerFrom(args.flags['--provider'])
    if (!provider) {
      deps.err('--provider must be codex or claude')
      return { code: 1 }
    }
    // Resolve the CLI context before the optimizer reads daemon.json.
    void deps.ctx
    const { optimizeWorkerPrompt } = await import('../../core/steward-prompt-optimizer')
    const result = await optimizeWorkerPrompt('Coder', provider)
    deps.out(JSON.stringify(result, null, 2))
    return { code: 0, value: result }
  },
}

const stewardRevert: Command = {
  path: 'steward revert',
  summary: 'restore the prior Mars-owned Worker prompt text from a ledger entry',
  usage: 'usage: mars steward revert <ledger-entry>',
  run: async (args, deps) => {
    const ledgerId = args.positional[0]
    if (!ledgerId || args.positional.length !== 1) {
      deps.err('usage: mars steward revert <ledger-entry>')
      return { code: 1 }
    }
    void deps.ctx
    try {
      const { revertWorkerPromptOptimization } = await import('../../core/steward-prompt-optimizer')
      const targetId = await revertWorkerPromptOptimization(ledgerId)
      deps.out(`reverted ${targetId} from Steward ledger ${ledgerId}`)
      return { code: 0, value: { targetId } }
    } catch (error) {
      deps.err(error instanceof Error ? error.message : String(error))
      return { code: 1 }
    }
  },
}

export const stewardCommands: readonly Command[] = [
  stewardGroup,
  stewardInspect,
  stewardOptimize,
  stewardRevert,
]
