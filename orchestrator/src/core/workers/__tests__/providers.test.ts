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

  it("'claude' provider spawnArgv starts with 'claude'", () => {
    const argv = PROVIDERS.claude.spawnArgv({})
    expect(argv[0]).toBe('claude')
    expect(argv).toContain('-p')
  })

  it("'claude' provider feedPrompt writes to stdin and closes it", async () => {
    const chunks: Buffer[] = []
    let ended = false
    const fakeStdin = {
      write(data: string, cb: (err?: Error | null) => void) {
        chunks.push(Buffer.from(data))
        cb()
      },
      end(cb: () => void) {
        ended = true
        cb()
      },
    }

    await PROVIDERS.claude.feedPrompt(
      { stdin: fakeStdin as unknown as NodeJS.WritableStream },
      'hello world',
    )

    expect(Buffer.concat(chunks).toString()).toBe('hello world')
    expect(ended).toBe(true)
  })

  it("'claude' provider has no doneSignal (tracer-bullet stage)", () => {
    expect(PROVIDERS.claude.doneSignal).toBeUndefined()
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
