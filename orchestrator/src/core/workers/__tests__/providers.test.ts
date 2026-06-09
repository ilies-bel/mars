import { describe, it, expect } from 'vitest'
import { PROVIDERS } from '../providers'
import { WORKER_CONFIGS } from '../index'

describe('PROVIDERS registry', () => {
  it("contains the 'claude' entry", () => {
    expect(Object.keys(PROVIDERS)).toContain('claude')
  })

  it("'claude' provider has a name matching its key", () => {
    expect(PROVIDERS.claude.name).toBe('claude')
  })

  it("'claude' provider spawnArgv starts with 'claude' and has no '-p' flag", () => {
    const argv = PROVIDERS.claude.spawnArgv({})
    expect(argv[0]).toBe('claude')
    expect(argv).not.toContain('-p')
  })

  it("'claude' provider spawnArgv includes '--model' when model is supplied", () => {
    const argv = PROVIDERS.claude.spawnArgv({ model: 'claude-sonnet-4-6' })
    expect(argv).toContain('--model')
    expect(argv).toContain('claude-sonnet-4-6')
  })

  it("'claude' provider spawnArgv omits '--model' when model is absent", () => {
    const argv = PROVIDERS.claude.spawnArgv({})
    expect(argv).not.toContain('--model')
  })

  it("'claude' provider spawnArgv includes '--resume' when sessionId is supplied", () => {
    const argv = PROVIDERS.claude.spawnArgv({ sessionId: 'sess-abc123' })
    expect(argv).toContain('--resume')
    expect(argv).toContain('sess-abc123')
  })

  it("'claude' provider spawnArgv omits '--resume' when sessionId is absent", () => {
    const argv = PROVIDERS.claude.spawnArgv({})
    expect(argv).not.toContain('--resume')
  })

  it("'claude' provider feedPrompt writes the prompt body then the CR terminator", async () => {
    const written: string[] = []
    const fakePtyHandle = {
      write(data: string): void {
        written.push(data)
      },
    }

    await PROVIDERS.claude.feedPrompt(fakePtyHandle, 'hello world')

    expect(written).toHaveLength(2)
    expect(written[0]).toBe('hello world')
    expect(written[1]).toBe('\r')
  })

  it("'claude' provider doneSignal is a status-file signal with a wait function", () => {
    expect(PROVIDERS.claude.doneSignal).toBeDefined()
    expect(PROVIDERS.claude.doneSignal?.kind).toBe('status-file')
    expect(PROVIDERS.claude.doneSignal).toHaveProperty('wait')
    expect(typeof (PROVIDERS.claude.doneSignal as { wait?: unknown })?.wait).toBe('function')
  })

  it("contains the 'gemini' entry", () => {
    expect(Object.keys(PROVIDERS)).toContain('gemini')
  })

  it("'gemini' provider has a name matching its key", () => {
    expect(PROVIDERS.gemini.name).toBe('gemini')
  })

  it("'gemini' provider spawnArgv starts with 'gemini' and has no '-p' flag", () => {
    const argv = PROVIDERS.gemini.spawnArgv({})
    expect(argv[0]).toBe('gemini')
    expect(argv).not.toContain('-p')
  })

  it("'gemini' provider feedPrompt writes the prompt body then the CR terminator", async () => {
    const written: string[] = []
    const fakePtyHandle = {
      write(data: string): void {
        written.push(data)
      },
    }

    await PROVIDERS.gemini.feedPrompt(fakePtyHandle, 'do something')

    expect(written).toHaveLength(2)
    expect(written[0]).toBe('do something')
    expect(written[1]).toBe('\r')
  })

  it("'gemini' provider doneSignal is a prompt-scan signal with promptPrefix and spinnerOverride", () => {
    expect(PROVIDERS.gemini.doneSignal).toBeDefined()
    expect(PROVIDERS.gemini.doneSignal?.kind).toBe('prompt-scan')
    const signal = PROVIDERS.gemini.doneSignal as { kind: string; promptPrefix?: unknown; spinnerOverride?: unknown }
    expect(typeof signal.promptPrefix).toBe('string')
    expect(signal.promptPrefix).toBeTruthy()
    expect(signal.spinnerOverride).toBeInstanceOf(RegExp)
  })
})

describe('WORKER_CONFIGS provider field', () => {
  const workerNames = Object.keys(WORKER_CONFIGS) as Array<keyof typeof WORKER_CONFIGS>

  it('every built-in Worker declares a provider', () => {
    for (const name of workerNames) {
      expect(WORKER_CONFIGS[name]).toHaveProperty('provider')
    }
  })

  it('every built-in Worker provider resolves to a known PROVIDERS entry', () => {
    for (const name of workerNames) {
      const { provider } = WORKER_CONFIGS[name]
      expect(
        PROVIDERS,
        `Worker ${name} has provider '${provider}' which is not in PROVIDERS`,
      ).toHaveProperty(provider)
    }
  })

  it("all five Workers declare provider: 'claude'", () => {
    expect(workerNames).toHaveLength(5)
    for (const name of workerNames) {
      expect(WORKER_CONFIGS[name].provider).toBe('claude')
    }
  })
})
