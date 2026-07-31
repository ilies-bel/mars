import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-steward-prompt-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('Steward prompt optimizer', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports the actual Codex and Claude assemblies and duplicate system/user directives', async () => {
    const config = await import('./daemon/config')
    const prompts = await import('../workflows/primitives/shared')
    const original = prompts.buildCoderSystemPrompt()
    config.persistWorkerPromptOverride(
      'Coder.system',
      `${original}\n\nAlways commit the in-scope work before you exit.`,
    )

    const codex = prompts.measureWorkerDispatchPrompt(
      'Coder',
      'Always commit the in-scope work before you exit.',
      'codex',
    )
    const claude = prompts.measureWorkerDispatchPrompt('Coder', 'Implement the requested change.', 'claude')

    expect(codex.assembly).toBe('codex-inlined-mars-system-instructions')
    expect(codex.duplicatedDirectives).toContain('always commit the in-scope work before you exit.')
    expect(claude.assembly).toBe('claude-append-system-prompt')
    expect(codex.sections.find((section) => section.name === '## Save your work')?.depthPercent).toBeGreaterThan(80)
  })

  it('applies autonomously once per content version, records prior text, and announces the edit', async () => {
    const optimizer = await import('./steward-prompt-optimizer')
    const entries: Array<{ targetVersion: string; outcome: string }> = []
    let text = 'verbose footer'
    const acknowledge = vi.fn().mockResolvedValue(undefined)
    const deps = {
      autonomyLevel: 'tell' as const,
      readBlock: () => text,
      writeBlock: (_block: 'Coder.system' | 'COMMIT_FOOTER', next: string) => {
        text = next
      },
      listLedger: async () => entries,
      recordLedger: async (entry: { targetVersion: string; outcome: string }) => {
        entries.push({ targetVersion: entry.targetVersion, outcome: entry.outcome })
        return 'ledger-1'
      },
      writeChatAck: acknowledge,
    }

    const first = await optimizer.optimizeWorkerPrompt('Coder', 'codex', deps)
    const second = await optimizer.optimizeWorkerPrompt('Coder', 'codex', deps)
    text = 'human revised footer'
    const afterHumanEdit = await optimizer.optimizeWorkerPrompt('Coder', 'codex', deps)

    expect(first.kind).toBe('applied')
    expect(second.kind).toBe('already-optimized')
    expect(afterHumanEdit.kind).toBe('applied')
    expect(JSON.parse(entries[0]!.outcome).priorText).toBe('verbose footer')
    expect(JSON.parse(entries[1]!.outcome).priorText).toBe('human revised footer')
    expect(acknowledge).toHaveBeenCalledTimes(2)
    expect(acknowledge.mock.calls[0]?.[0]).toContain('COMMIT_FOOTER')
  })

  it('keeps off silent and ask proposal-only', async () => {
    const optimizer = await import('./steward-prompt-optimizer')
    const writeBlock = vi.fn()
    const off = await optimizer.optimizeWorkerPrompt('Coder', 'codex', { autonomyLevel: 'off', writeBlock })
    const ask = await optimizer.optimizeWorkerPrompt('Coder', 'codex', { autonomyLevel: 'ask', writeBlock })

    expect(off.kind).toBe('off')
    expect(ask.kind).toBe('proposal')
    expect(writeBlock).not.toHaveBeenCalled()
  })

  it('does not edit a standing prompt when its undo ledger cannot be recorded', async () => {
    const optimizer = await import('./steward-prompt-optimizer')
    const writeBlock = vi.fn()

    await expect(
      optimizer.optimizeWorkerPrompt('Coder', 'codex', {
        autonomyLevel: 'tell',
        readBlock: () => 'original footer',
        writeBlock,
        listLedger: async () => [],
        recordLedger: async () => {
          throw new Error('ledger unavailable')
        },
      }),
    ).rejects.toThrow('ledger unavailable')

    expect(writeBlock).not.toHaveBeenCalled()
  })

  it('reverts from the ledger and does not immediately reapply the restored version', async () => {
    const optimizer = await import('./steward-prompt-optimizer')
    const config = await import('./daemon/config')
    const ledger = await import('./steward-ledger')
    const ack = vi.fn().mockResolvedValue(undefined)

    const applied = await optimizer.optimizeWorkerPrompt('Coder', 'codex', {
      autonomyLevel: 'tell',
      writeChatAck: ack,
    })
    expect(applied.kind).toBe('applied')
    if (applied.kind !== 'applied') throw new Error('expected applied optimization')
    const changed = config.readWorkerPromptOverride('COMMIT_FOOTER')
    expect(changed).toContain('Before exiting, commit every in-scope change')

    await optimizer.revertWorkerPromptOptimization(applied.ledgerId)
    expect(config.readWorkerPromptOverride('COMMIT_FOOTER')).toBeNull()
    const entry = await ledger.getStewardLedgerEntry(applied.ledgerId)
    expect(entry?.outcome).toContain('reverted')

    const retry = await optimizer.optimizeWorkerPrompt('Coder', 'codex', {
      autonomyLevel: 'tell',
      writeChatAck: ack,
    })
    expect(retry.kind).toBe('already-optimized')
  })

  it('runs on the named degraded KPI signals', async () => {
    const optimizer = await import('./steward-prompt-optimizer')
    const bus = new EventEmitter()
    const writeBlock = vi.fn()
    const stop = optimizer.startStewardPromptOptimization(bus, {
      autonomyLevel: 'tell',
      readBlock: () => 'original footer',
      writeBlock,
      listLedger: async () => [],
      recordLedger: async () => 'ledger-event',
      writeChatAck: vi.fn().mockResolvedValue(undefined),
    })

    bus.emit('kpi-degraded', { kind: 'kpi-degraded', signal: 'auto-commit rate', delta: 0.2 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop()

    expect(writeBlock).toHaveBeenCalledWith('COMMIT_FOOTER', expect.any(String))
  })
})
